import * as vscode from 'vscode';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { RawData, WebSocket } from 'ws';
import { log, logError } from '../logger';
import { isEnvelope, makeEnvelope, MessageEnvelope } from '../protocol';
import { colleagueEnabled, Store } from '../store';
import { ControlResult, Transport, TransportStatus } from './types';

/** 控制面请求（房间 / 管理）的应答超时 */
const CONTROL_TIMEOUT_MS = 8000;

/**
 * 连接中断后的界面文案。本扩展**不做任何自动重连**：无论哪种失败都停在离线态，
 * 由用户点「重试连接」再次尝试，避免配置错误时无限制地向中继发起连接。
 */
const CLOSE_REASON_TEXT: Record<number, string> = {
  4001: '中继令牌不正确，请修改令牌后点「保存并应用」',
  4002: '未向中继声明本机 id，请填写档案 id 后点「保存并应用」',
  4005: '该中继 id 已被另一个窗口占用（若确认旧窗口已关闭，可点「重试连接」）',
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

  private ws?: WebSocket;
  private queue: MessageEnvelope[] = [];
  private running = false;
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
    this.token = await this.store.getToken();
    this.adminToken = await this.store.getAdminToken();
    log(`[relay] 启动：地址=${this.store.config.relay.url || '(空)'} 档案id=${this.store.config.identity.id || '(空)'} 令牌=${this.token ? '已设置' : '未设置'} 扩展版本=${this.store.extensionVersion || '(未知)'}${this.adminToken ? ' 管理令牌=已设置' : ''}`);
    this.connect();
  }

  async stop(): Promise<void> {
    log('[relay] 停止');
    this.running = false;
    this.ws?.close();
    this.ws = undefined;
    // 保留 queue：断开后重新连接时会补发，用户不会因为断开而丢消息；
    // 在线/离线名单是上一次会话的缓存，重连后由中继的 presence 重建
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
    const { url } = this.store.config.relay;
    const myId = this.myRelayId();
    if (!url || !myId) {
      const missing = [!url ? '中继服务器地址' : '', !myId ? '档案 id' : ''].filter(Boolean).join('与');
      log(`[relay] 未配置${missing}，无法连接`);
      this.statusEmitter.fire({ state: 'offline', detail: `未配置${missing}，请填写后点「保存并应用」` });
      return;
    }
    this.statusEmitter.fire({ state: 'connecting', detail: '正在连接中继服务器...' });
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
    const headers: Record<string, string> = { 'x-client-version': this.store.extensionVersion };
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
    ws.on('open', () => {
      log('[relay] 已连接中继服务器');
      this.statusEmitter.fire({ state: 'online', detail: '已连接中继服务器' });
      this.fetchRelayInfo(url);
      const identity = this.store.config.identity;
      // 向中继上报自己的档案（to='server' 由中继登记后广播给所有在线设备），中继是档案的权威来源
      log(`[relay] 向中继上报档案（角色=${identity.role || '空'} 负责=${identity.scope || '空'}）`);
      ws.send(JSON.stringify(makeEnvelope({ kind: 'hello', from: this.myRelayId(), to: 'server', profile: identity })));
      const queued = this.queue.splice(0);
      if (queued.length > 0) {
        log(`[relay] 补发队列消息 ${queued.length} 条`);
      }
      for (const env of queued) {
        ws.send(JSON.stringify(env));
      }
    });
    ws.on('message', data => this.handleRaw(data));
    ws.on('error', err => {
      logError('[relay] 连接出错', err);
    });
    ws.on('close', (code, reason) => {
      // 已被 stop() 或下一次连接替换：属上一个会话，不能改写当前会话的状态与在途请求
      if (this.ws !== ws) {
        log(`[relay] 忽略上一个会话的关闭事件（code=${code}）`);
        return;
      }
      this.ws = undefined;
      const reasonText = reason.toString();
      log(`[relay] 与中继的连接关闭：code=${code} reason=${reasonText || '(空)'}`);
      this.failPending('与中继的连接已断开');
      if (!this.running) {
        return;
      }
      // 不自动重连：任何中断都停在离线态，文案里写明用户下一步要做什么
      this.statusEmitter.fire({ state: 'offline', detail: this.describeClose(code, reasonText) });
    });
  }

  /** 关闭码 → 界面文案；本扩展不做自动重连，因此文案必须给出下一步动作 */
  private describeClose(code: number, reasonText: string): string {
    const suffix = reasonText ? `（中继说明：${reasonText}）` : '';
    if (code === 4008) {
      return `扩展版本（${this.store.extensionVersion || '未知'}）未通过中继版本门禁：${reasonText || '版本不一致'}。请升级扩展或联系管理员升级中继，然后点「保存并应用」`;
    }
    const mapped = CLOSE_REASON_TEXT[code];
    if (mapped) {
      return `${mapped}${suffix}`;
    }
    if (code === 1005 || code === 1006) {
      return `无法连接中继服务器（请检查中继地址、网络，以及中继是否在运行），点「重试连接」再次尝试`;
    }
    return `与中继服务器的连接已断开（关闭码 ${code}），点「重试连接」再次尝试${suffix}`;
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
    // 控制面：房间 / 管理应答按请求 id 关联；两类都不进消息通道
    if (parsed.kind === 'room' || parsed.kind === 'admin') {
      const resolve = this.pending.get(parsed.id);
      if (resolve) {
        this.pending.delete(parsed.id);
        resolve({ ok: parsed.ok === true, error: parsed.error, env: parsed });
      } else {
        log(`[relay] 收到未匹配的控制面应答（op=${parsed.op ?? '(空)'}），已忽略`);
      }
      return;
    }
    if (parsed.kind === 'room-event') {
      const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      log(`[relay] 房间列表更新：${rooms.length} 个房间`);
      this.store.setRooms(rooms);
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
  controlOp(kind: 'room' | 'admin', op: string, payload?: Record<string, unknown>): Promise<ControlResult> {
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
