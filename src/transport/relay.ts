import * as vscode from 'vscode';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { RawData, WebSocket } from 'ws';
import { log, logError } from '../logger';
import { isEnvelope, makeEnvelope, MessageEnvelope } from '../protocol';
import { colleagueEnabled, Store } from '../store';
import { ControlResult, MemoryChange, Transport, TransportStatus } from './types';

/** 控制面请求（房间 / 管理）的应答超时 */
const CONTROL_TIMEOUT_MS = 8000;

/**
 * 断开后的自愈策略：中继重启、网络抖动、Cloudflare 隧道掉线这类瞬时中断自动重连，
 * 退避从 1s 起指数增长到 30s（带 ±20% 抖动，避免一堆客户端同时回来打爆中继）；
 * 只有"配置 / 权限 / 版本"这类重连也不会成功的关闭码才停在离线态，等用户处理。
 * 手动点「断开连接」会停掉重连计划（running=false），不会自己连回来。
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_JITTER = 0.2;
/** 会话稳定存活超过这个时长后再断开时，退避计数清零（链路一直抖时不会反复从 1s 重试） */
const RECONNECT_STABLE_MS = 60000;
/** 重连也没用的关闭码：令牌不对 / 没声明 id / id 用保留地址 / 被管理员踢出或封禁 / 版本门禁 */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4003, 4006, 4007, 4008]);
/** 看门狗：中继每 30s 心跳一次，这么久一个帧都没收到就认为本机侧链路已死，主动断开重连 */
const STALE_FRAME_MS = 95000;
const WATCHDOG_TICK_MS = 10000;
const CLOSE_REASON_TEXT: Record<number, string> = {
  1000: '连接被对端正常关闭',
  1001: '中继服务正在关闭或重启',
  1002: 'WebSocket 协议错误，连接被关闭',
  1003: '中继不接受收到的数据类型',
  1007: '消息不是合法的 UTF-8 文本，连接被关闭',
  1008: '消息违反中继策略，连接被关闭',
  1009: '单条消息超过中继上限（2 MiB），连接被关闭',
  1010: '本机与中继的扩展协商项不一致，连接被关闭',
  1011: '中继判定本机心跳超时（长时间没有回应 ping），已重置连接',
  1012: '中继服务正在重启',
  1013: '中继暂时不可用（维护或过载）',
  1014: '中继繁忙，本次连接被拒绝',
  1015: 'TLS 握手失败（证书不受信任或加密套件不匹配）',
  4001: '中继令牌不正确，请修改令牌后点「保存并应用」',
  4002: '未向中继声明本机 id，请填写档案 id 后点「保存并应用」',
  4003: '档案 id 用了中继的保留地址（server），请换一个 id 后点「保存并应用」',
  4005: '该中继 id 已被另一个窗口占用（旧窗口关闭后本窗口会自动接上）',
  4006: '已被管理员移出中继（需联系管理员恢复，之后点「重试连接」）',
  4007: '已被管理员封禁（解封后点「重试连接」）',
  4008: '扩展版本未通过中继版本门禁，需与中继同步升级',
};

/** 中继模式：双方都连接中继服务器，由服务器转发并代存离线消息 */
export class RelayTransport implements Transport {
  private readonly messageEmitter = new vscode.EventEmitter<MessageEnvelope>();
  readonly onMessage = this.messageEmitter.event;
  private readonly statusEmitter = new vscode.EventEmitter<TransportStatus>();
  readonly onStatus = this.statusEmitter.event;
  private readonly rejectedEmitter = new vscode.EventEmitter<MessageEnvelope>();
  readonly onRejected = this.rejectedEmitter.event;
  private readonly memoryEventEmitter = new vscode.EventEmitter<MemoryChange>();
  readonly onMemoryEvent = this.memoryEventEmitter.event;

  private ws?: WebSocket;
  private queue: MessageEnvelope[] = [];
  private running = false;
  /** 待执行的重连定时器（手动断开 / 重新连接时取消） */
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** 已连续重连次数：连接稳定存活后清零，用于指数退避与界面提示 */
  private reconnectAttempt = 0;
  /** 看门狗定时器：本机侧长时间收不到任何帧时判定连接已死 */
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private token = '';
  /** 中继管理令牌（可选）：随握手上报，通过即获得管理权限 */
  private adminToken = '';
  /** 控制面请求等待中的应答回调：中继应答的 id 与请求相同，据此关联 */
  private readonly pending = new Map<string, (result: ControlResult) => void>();
  private onlinePeers = new Set<string>();
  /** 已明确通告下线的同事（收到其任何消息后恢复在线） */
  private readonly offlinePeers = new Set<string>();

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.running = true;
    // 上一轮留下的重连计划作废：本次 start 自己会发起连接
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    // 先把旧版全局令牌认领到当前中继名下（地址是这里才保证有值的）
    await this.store.migrateLegacySecrets();
    this.token = await this.store.getToken();
    this.adminToken = await this.store.getAdminToken();
    log(`[relay] 启动：地址=${this.store.config.relay.url || '(空)'} 档案id=${this.store.config.identity.id || '(空)'} 令牌=${this.token ? '已设置' : '未设置'} 扩展版本=${this.store.extensionVersion || '(未知)'}${this.adminToken ? ' 管理令牌=已设置' : ''}`);
    void this.connect().catch(err => logError('[relay] 连接失败', err));
  }

  async stop(): Promise<void> {
    log('[relay] 停止');
    this.running = false;
    this.cancelReconnect();
    this.stopWatchdog();
    this.ws?.close();
    this.ws = undefined;
    // 保留 queue：断开后重新连接时会补发，用户不会因为断开而丢消息；
    // 在线/离线名单是上一次会话的缓存，重连后由中继的 presence 重建
    // 授权名单不能留：中继口径是"断线即收回"，本机跟着清空
    this.store.setGrantedBy([]);
    this.onlinePeers.clear();
    this.offlinePeers.clear();
    this.failPending('通信通道已停止');
    this.statusEmitter.fire({ state: 'stopped', detail: '中继模式已停止' });
  }

  send(env: MessageEnvelope): Promise<void> {
    const out = { ...env, from: this.myRelayId(), to: this.resolveAddress(env.to) };
    if (this.ws?.readyState === WebSocket.OPEN) {
      log(`[relay] 发送 ${env.kind} → ${out.to}（消息 ${env.id}）`);
      this.ws.send(JSON.stringify(out));
    } else {
      log(`[relay] 未连接中继，入队 ${env.kind} → ${out.to}（队列 ${this.queue.length + 1} 条）`);
      this.queue.push(out);
    }
    return Promise.resolve();
  }

  /** 同事 id → 中继上的路由 id */
  private resolveAddress(to: string): string {
    const colleague = this.store.config.colleagues.find(c => c.id === to);
    return colleague?.relayPeerId || to;
  }

  /** 还在待发队列里的消息 id（断开 / 对方离线时入队，重连后补发） */
  queuedIds(): string[] {
    return this.queue.map(env => env.id);
  }

  /** 取消一条还没发出的排队消息：从队列里摘掉，避免对方上线后又被补发 */
  cancelQueued(id: string): boolean {
    const idx = this.queue.findIndex(env => env.id === id);
    if (idx < 0) {
      return false;
    }
    this.queue.splice(idx, 1);
    log(`[relay] 已从待发队列取消消息 ${id}（剩余 ${this.queue.length} 条）`);
    return true;
  }

  /** 本机在中继上的 id：一律取档案 id，各窗口因此天然使用不同 id */
  private myRelayId(): string {
    return this.store.config.identity.id;
  }

  isOnline(peerId: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.offlinePeers.has(peerId)) {
      return false;
    }
    const colleague = this.store.config.colleagues.find(c => c.id === peerId);
    return this.onlinePeers.has(colleague?.relayPeerId || peerId);
  }

  /** 退出前尽力向所有沟通方发出下线通告（复用中继连接，不等待） */
  sendOfflineNotice(): void {
    const identity = this.store.config.identity;
    for (const c of this.store.config.colleagues) {
      if (!c.relayPeerId || !colleagueEnabled(c)) {
        continue;
      }
      void this.send(makeEnvelope({ kind: 'offline', from: this.myRelayId(), to: c.id, profile: identity }));
      log(`[relay] 已向 ${c.id} 发出下线通告`);
    }
  }

  /**
   * 连接前问一次中继的在线名单（带令牌），判断本机 id 是否已被占用。
   * 任何失败（旧版服务端无该端点、网络异常、响应不可解析）都视为"未占用"，
   * 让连接流程照常继续，由服务端的 4005 兜底。
   */
  private idTakenOnRelay(url: string, myId: string): Promise<boolean> {
    return new Promise(resolve => {
      let target: URL;
      try {
        target = new URL(`${url.replace(/^ws/, 'http').replace(/\/+$/, '')}/peers`);
      } catch {
        resolve(false);
        return;
      }
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname,
          method: 'GET',
          headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
          timeout: 4000,
        },
        res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => (body += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { peers?: unknown };
              resolve(Array.isArray(parsed.peers) && parsed.peers.includes(myId));
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on('timeout', () => {
        log('[relay] 预检在线名单超时，按未占用处理');
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  private async connect(): Promise<void> {
    if (!this.running) {
      return;
    }
    // 本次是实际发起连接：把待执行的重连计划作废，避免重复连
    this.cancelReconnect();
    const { url } = this.store.config.relay;
    const myId = this.myRelayId();
    if (!url || !myId) {
      const missing = [!url ? '中继服务器地址' : '', !myId ? '档案 id' : ''].filter(Boolean).join('与');
      log(`[relay] 未配置${missing}，无法连接`);
      this.statusEmitter.fire({ state: 'offline', detail: `未配置${missing}，请填写后点「保存并应用」` });
      return;
    }
    this.statusEmitter.fire({
      state: 'connecting',
      detail: this.reconnectAttempt > 0 ? `正在重连中继服务器（第 ${this.reconnectAttempt} 次重连）...` : '正在连接中继服务器...',
    });
    if (await this.idTakenOnRelay(url, myId)) {
      // 在线名单里有本机 id：可能是断电遗留的死连接（服务端会接管），也可能是另一窗口。
      // 不再直接放弃连接，交给服务端裁决：死连接被接管，活连接则仍以 4005 拒绝。
      log(`[relay] 预检发现 id=${myId} 已在在线名单，继续尝试连接（死连接会被服务端接管）`);
    }
    if (!this.running) {
      return;
    }
    const wsUrl = `${url.replace(/\/+$/, '')}/ws?id=${encodeURIComponent(myId)}`;
    // 版本门禁：上报扩展版本（中继按它决定是否放行）；管理令牌可选，错误不影响普通连接
    const headers: Record<string, string> = {
      'x-client-version': this.store.extensionVersion,
      // 设备类型：中继据此标注设备、拒绝对人工终端派发写任务（缺省视为 extension）
      'x-client-kind': 'extension',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (this.adminToken) {
      headers['x-admin-token'] = this.adminToken;
    }
    log(`[relay] 连接中继 ${wsUrl}（扩展版本 ${this.store.extensionVersion || '未知'}）${this.token ? '（携带令牌）' : ''}${this.adminToken ? '（携带管理令牌）' : ''}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, {
        headers,
        handshakeTimeout: 8000,
      });
    } catch (err) {
      // 地址格式非法时构造会直接抛出；此处兜住，避免变成未处理的 Promise 拒绝
      logError('[relay] 无法创建连接', err);
      this.statusEmitter.fire({ state: 'offline', detail: `中继地址无法连接：${(err as Error).message}。请检查地址格式后点「保存并应用」重试` });
      return;
    }
    this.ws = ws;
    // 诊断统计：断线时把"存活多久、心跳是否正常"一并写进日志，便于事后判断断在哪一段
    const stats = { startedAt: Date.now(), opened: false, pings: 0, lastPingAt: 0, lastFrameAt: Date.now() };
    let lastError = '';
    ws.on('ping', () => {
      stats.pings += 1;
      stats.lastPingAt = Date.now();
      stats.lastFrameAt = Date.now();
      // 每 10 次（中继 30s 一轮，约 5 分钟）记一条，避免日志刷屏
      if (stats.pings % 10 === 0) {
        log(`[relay] 心跳正常：已连接 ${((Date.now() - stats.startedAt) / 60000).toFixed(1)} 分钟，收到 ping ${stats.pings} 次`);
      }
    });
    // 看门狗：写入侧的失败要等 TCP 超时才发现，这里用"中继心跳是否还在到达"判断本机侧链路是否已死
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.ws !== ws) {
        this.stopWatchdog();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const idleMs = Date.now() - stats.lastFrameAt;
      if (idleMs >= STALE_FRAME_MS) {
        log(`[relay] ${Math.round(idleMs / 1000)}s 未收到中继任何帧（心跳应每 30s 一次），判定连接已失效，主动断开后重连`);
        // terminate 会触发本地的 close(1006)，随后走自动重连
        ws.terminate();
      }
    }, WATCHDOG_TICK_MS);
    ws.on('open', () => {
      stats.opened = true;
      log(this.reconnectAttempt > 0 ? `[relay] 自动重连成功（第 ${this.reconnectAttempt} 次重连）` : '[relay] 已连接中继服务器');
      this.statusEmitter.fire({ state: 'online', detail: '已连接中继服务器' });
      this.fetchRelayInfo(url);
      const identity = this.store.config.identity;
      // 向中继上报自己的档案（to='server' 由中继登记后广播给所有在线设备），中继是档案的权威来源
      log(`[relay] 向中继上报档案（角色=${identity.role || '空'} 负责=${identity.scope || '空'}）`);
      ws.send(JSON.stringify(makeEnvelope({ kind: 'hello', from: this.myRelayId(), to: 'server', profile: identity })));
      // 上报写授权名单（中继内存态，断线即收回；重连后需要重新上报）
      this.reportTrust(this.store.execGrantees());
      const queued = this.queue.splice(0);
      if (queued.length > 0) {
        log(`[relay] 补发队列消息 ${queued.length} 条`);
      }
      for (const env of queued) {
        ws.send(JSON.stringify(env));
      }
    });
    ws.on('message', data => {
      stats.lastFrameAt = Date.now();
      this.handleRaw(data);
    });
    ws.on('error', err => {
      lastError = err instanceof Error ? err.message : String(err);
      logError('[relay] 连接出错', err);
    });
    ws.on('close', (code, reason) => {
      // 已被 stop() 或下一次连接替换：属上一个会话，不能改写当前会话的状态与在途请求
      if (this.ws !== ws) {
        log(`[relay] 忽略上一个会话的关闭事件（code=${code}）`);
        return;
      }
      this.ws = undefined;
      this.stopWatchdog();
      const reasonText = reason.toString();
      const aliveMs = Date.now() - stats.startedAt;
      const ago = (t: number): string => (t > 0 ? `${Math.round((Date.now() - t) / 1000)}s 前` : '从未');
      log(`[relay] 与中继的连接关闭：code=${code} reason=${reasonText || '(空)'}`
        + `（本次存活 ${Math.round(aliveMs / 1000)}s，收到 ping ${stats.pings} 次，`
        + `最后一次 ping ${ago(stats.lastPingAt)}，最后一次数据 ${ago(stats.lastFrameAt)}`
        + `${lastError ? `，本地错误 ${lastError}` : ''}）`);
      // 授权名单由中继权威下发且"断线即收回"：断开后本机不能继续按旧名单声称对方已授权
      this.store.setGrantedBy([]);
      this.failPending('与中继的连接已断开');
      if (!this.running) {
        return;
      }
      const detail = this.describeClose(code, reasonText, stats.opened, lastError);
      if (FATAL_CLOSE_CODES.has(code)) {
        // 令牌 / id / 权限 / 版本问题：重连也不会成功，停在离线态等用户处理
        log(`[relay] 关闭码 ${code} 属于需要人工处理的情况，不自动重连`);
        this.statusEmitter.fire({ state: 'offline', detail });
        return;
      }
      if (aliveMs >= RECONNECT_STABLE_MS) {
        // 这次连接稳定存活过，退避重新从 1s 开始
        this.reconnectAttempt = 0;
      }
      this.scheduleReconnect(detail);
    });
  }

  /** 关闭码 → 界面文案（自动重连的倒计时由 scheduleReconnect 追加） */
  private describeClose(code: number, reasonText: string, opened: boolean, lastError: string): string {
    if (code === 4008) {
      return `扩展版本（${this.store.extensionVersion || '未知'}）未通过中继版本门禁：${reasonText || '版本不一致'}。请升级扩展或联系管理员升级中继，然后点「保存并应用」`;
    }
    if (code === 1005 || code === 1006) {
      // 这两种码分两种情况：连握手都没成功，和连上之后被掐断（网络 / 隧道抖动）
      const local = lastError ? `：${lastError}` : '';
      return opened
        ? `与中继的连接被中断（网络抖动或隧道掉线${local}）`
        : `无法连接中继服务器（请检查中继地址、网络，以及中继是否在运行${local}）`;
    }
    const mapped = CLOSE_REASON_TEXT[code];
    if (mapped) {
      return reasonText ? `${mapped}（中继说明：${reasonText}）` : mapped;
    }
    return `与中继服务器的连接已断开（关闭码 ${code}）${reasonText ? `（中继说明：${reasonText}）` : ''}`;
  }

  /** 取消待执行的重连（手动断开、重新连接时调用） */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * 安排下一次自动重连：指数退避（1s→30s）+ ±20% 抖动，并把倒计时同步到界面状态。
   * 中继 4005（id 被另一个窗口占用）也会走这里：旧连接最多要几十秒才被中继判定失联。
   */
  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempt += 1;
    const step = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    const delay = Math.max(500, Math.round(step * (1 + RECONNECT_JITTER * (Math.random() * 2 - 1))));
    const seconds = Math.max(1, Math.round(delay / 1000));
    log(`[relay] ${seconds}s 后自动重连（第 ${this.reconnectAttempt} 次）：${reason}`);
    this.statusEmitter.fire({
      state: 'offline',
      detail: `${reason}；${seconds}s 后自动重连（第 ${this.reconnectAttempt} 次）`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(err => logError('[relay] 重连失败', err));
    }, delay);
  }

  private handleRaw(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      log('[relay] 收到无法解析的数据，已忽略');
      return;
    }
    if (!isEnvelope(parsed)) {
      return;
    }
    // 信任授权：既可能是对 report 的应答（按 id 关联），也可能是中继主动下发的"我被谁授权"
    if (parsed.kind === 'trust') {
      const resolveTrust = this.pending.get(parsed.id);
      if (resolveTrust) {
        this.pending.delete(parsed.id);
        resolveTrust({ ok: parsed.ok === true, error: parsed.error, env: parsed });
        return;
      }
      if (parsed.op === 'grantedBy') {
        const list = parsed.payload && typeof parsed.payload === 'object' && Array.isArray(parsed.payload.grantedBy)
          ? parsed.payload.grantedBy.filter((x): x is string => typeof x === 'string')
          : [];
        log(`[relay] 写授权名单更新：被 ${list.length > 0 ? list.join(', ') : '(无)'} 授权`);
        this.store.setGrantedBy(list);
        return;
      }
      log(`[relay] 收到未匹配的信任消息（op=${parsed.op ?? '(空)'}），已忽略`);
      return;
    }
    // 控制面：房间 / 管理 / 记忆应答按请求 id 关联；都不进消息通道
    if (parsed.kind === 'room' || parsed.kind === 'admin' || parsed.kind === 'memory') {
      const resolve = this.pending.get(parsed.id);
      if (resolve) {
        this.pending.delete(parsed.id);
        resolve({ ok: parsed.ok === true, error: parsed.error, env: parsed });
      } else {
        log(`[relay] 收到未匹配的控制面应答（op=${parsed.op ?? '(空)'}），已忽略`);
      }
      return;
    }
    if (parsed.kind === 'memory-event') {
      // 中继是记忆的唯一权威存储与下发方：这里只接收"哪条记忆变了"，随后由界面重新向中继拉取
      const payload = parsed.payload ?? {};
      const roomId = typeof payload.roomId === 'string' ? payload.roomId : '';
      if (!roomId) {
        return;
      }
      const change: MemoryChange = {
        roomId,
        roomName: typeof payload.roomName === 'string' ? payload.roomName : '',
        action: typeof parsed.op === 'string' ? parsed.op : '',
        entryId: typeof payload.entryId === 'string' ? payload.entryId : '',
        revision: Number(payload.revision) || 0,
        by: typeof payload.by === 'string' ? payload.by : '',
      };
      log(`[relay] 记忆变更：房间 ${change.roomName || change.roomId} ${change.action}（条目 ${change.entryId || '(整房)'}）`);
      this.memoryEventEmitter.fire(change);
      return;
    }
    if (parsed.kind === 'room-event') {
      const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
      log(`[relay] 房间列表更新：${rooms.length} 个房间、${categories.length} 个分类`);
      this.store.setRooms(rooms);
      this.store.setCategories(categories);
      return;
    }
    if (parsed.kind === 'error') {
      log(`[relay] 中继拒收回执：${parsed.error ?? '(无原因)'}（原消息 ${parsed.refId || '(未知)'}）`);
      this.rejectedEmitter.fire(parsed);
      return;
    }
    if (parsed.kind === 'presence') {
      this.onlinePeers = new Set(parsed.peers ?? []);
      log(`[relay] 在线名单更新：${[...this.onlinePeers].join(', ') || '(空)'}（含档案 ${parsed.profiles?.length ?? 0} 份）`);
      if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        // 中继是档案的权威来源：先按目录登记/更新，再补齐只有 id、未上报档案的在线设备
        void this.store.applyRelayDirectory(parsed.profiles);
      }
      void this.registerDiscoveredPeers();
      this.refreshPresenceStatus();
      return;
    }
    if (parsed.kind === 'offline') {
      this.offlinePeers.add(parsed.from);
      log(`[relay] 同事 ${parsed.from} 已通告下线`);
      this.refreshPresenceStatus();
      return;
    }
    if (this.offlinePeers.delete(parsed.from)) {
      log(`[relay] 同事 ${parsed.from} 恢复在线`);
      this.refreshPresenceStatus();
    }
    log(`[relay] 收到 ${parsed.kind} from=${parsed.from}（消息 ${parsed.id}）`);
    if (parsed.profile) {
      // 档案以中继目录为准；对端随消息携带的 profile 仅作补充（不再互发档案声明）
      void this.store.applyPeerProfile(parsed.profile, parsed.from).then(changed => {
        if (changed) {
          this.refreshPresenceStatus();
        }
      });
    }
    this.messageEmitter.fire(parsed);
  }

  /**
   * 中继广播的在线名单 → 自动登记为本机沟通方（跳过自己与已登记的）。
   * 中继上的 id 同时也是路由地址，因此 relayPeerId 取同一个值。
   */
  private async registerDiscoveredPeers(): Promise<void> {
    const known = new Set(this.store.config.colleagues.map(c => c.id));
    const mine = this.myRelayId();
    let added = 0;
    for (const peerId of this.onlinePeers) {
      if (peerId === mine || known.has(peerId)) {
        continue;
      }
      if (await this.store.upsertDiscoveredPeer({ id: peerId, relayPeerId: peerId })) {
        added += 1;
      }
    }
    if (added > 0) {
      log(`[relay] 自动登记 ${added} 位在线设备为本机沟通方`);
    }
  }

  private refreshPresenceStatus(): void {
    this.statusEmitter.fire({ state: 'online', detail: '已连接中继服务器' });
  }

  /** 连接断开/停止时让等待中的控制面请求立即失败，避免空等到超时 */
  private failPending(reason: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of waiting) {
      resolve({ ok: false, error: reason });
    }
  }

  /**
   * 中继控制面操作（房间 / 管理）：请求发往 to='server'，中继应答的 id 与请求相同。
   * 未连接或超时（旧版中继不认识该操作）时返回 ok=false，由界面提示。
   */
  controlOp(kind: 'room' | 'admin' | 'memory' | 'trust', op: string, payload?: Record<string, unknown>): Promise<ControlResult> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: '未连接中继服务器，无法执行该操作' });
    }
    const env = makeEnvelope({ kind, from: this.myRelayId(), to: 'server', op, payload });
    return new Promise<ControlResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(env.id);
        resolve({ ok: false, error: '中继未响应（可能服务端版本过旧，请升级中继后重试）' });
      }, CONTROL_TIMEOUT_MS);
      this.pending.set(env.id, result => {
        clearTimeout(timer);
        resolve(result);
      });
      log(`[relay] 控制面请求 ${kind}/${op}（消息 ${env.id}）`);
      try {
        this.ws?.send(JSON.stringify(env));
      } catch (err) {
        // 连接在检查与发送之间断开：立刻失败，避免等待悬空
        clearTimeout(timer);
        this.pending.delete(env.id);
        resolve({ ok: false, error: `控制面请求发送失败：${(err as Error).message}` });
      }
    });
  }

  /** 上报写授权名单（连接建立与名单变化时调用）；未连接时静默丢弃，重连后会整体重报 */
  reportTrust(grantees: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    void this.controlOp('trust', 'report', { grantees }).then(result => {
      if (!result.ok) {
        log(`[relay] 上报写授权名单失败：${result.error ?? '(未知)'}`);
      }
    });
  }

  /** 询问 /healthz 获取中继运行版本（仅展示用；版本门禁由握手时的 4008 判定） */
  private fetchRelayInfo(url: string): void {
    let target: URL;
    try {
      target = new URL(`${url.replace(/^ws/, 'http').replace(/\/+$/, '')}/healthz`);
    } catch {
      return;
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname,
        method: 'GET',
        timeout: 4000,
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { version?: unknown; protocol?: unknown };
            this.store.setRelayInfo(
              typeof parsed.version === 'string' ? parsed.version : '',
              typeof parsed.protocol === 'number' ? parsed.protocol : 0,
            );
          } catch {
            // /healthz 不可解析：界面显示为空即可
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => undefined);
    req.end();
  }
}
