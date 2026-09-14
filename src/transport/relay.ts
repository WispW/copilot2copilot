import * as vscode from 'vscode';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { RawData, WebSocket } from 'ws';
import { log, logError } from '../logger';
import { isEnvelope, makeEnvelope, MessageEnvelope } from '../protocol';
import { colleagueEnabled, Store } from '../store';
import { Transport, TransportStatus } from './types';

const MAX_RETRY_MS = 30_000;

/** 4xxx 关闭码表示配置或身份问题；4004/4005 也可能是断电后残留连接未清理，
 *  收到后延迟自动重试，由服务端裁决（死连接被接管、活连接继续拒绝） */
const FATAL_CLOSE_REASONS: Record<number, string> = {
  4001: '中继令牌不正确',
  4002: '未向中继声明本机 id',
  4004: '该中继 id 已被另一个窗口占用，本窗口被顶下线',
  4005: '该中继 id 已被另一个窗口占用',
};

/** 中继模式：双方都连接中继服务器，由服务器转发并代存离线消息 */
export class RelayTransport implements Transport {
  private readonly messageEmitter = new vscode.EventEmitter<MessageEnvelope>();
  readonly onMessage = this.messageEmitter.event;
  private readonly statusEmitter = new vscode.EventEmitter<TransportStatus>();
  readonly onStatus = this.statusEmitter.event;

  private ws?: WebSocket;
  private queue: MessageEnvelope[] = [];
  private retryMs = 1000;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private token = '';
  private onlinePeers = new Set<string>();
  /** 已明确通告下线的同事（收到其任何消息后恢复在线） */
  private readonly offlinePeers = new Set<string>();

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.running = true;
    this.token = await this.store.getToken();
    log(`[relay] 启动：地址=${this.store.config.relay.url || '(空)'} 档案id=${this.store.config.identity.id || '(空)'} 令牌=${this.token ? '已设置' : '未设置'}`);
    this.connect();
  }

  async stop(): Promise<void> {
    log('[relay] 停止');
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.ws?.close();
    this.ws = undefined;
    this.queue = [];
    this.onlinePeers.clear();
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
      log('[relay] 未配置中继地址或档案 id，无法连接');
      this.statusEmitter.fire({ state: 'offline', detail: '未配置中继服务器地址或档案 id' });
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
    log(`[relay] 连接中继 ${wsUrl}${this.token ? '（携带令牌）' : ''}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
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
      this.retryMs = 1000;
      this.statusEmitter.fire({ state: 'online', detail: '已连接中继服务器' });
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
      log(`[relay] 与中继的连接关闭：code=${code} reason=${reason.toString() || '(空)'}`);
      if (!this.running) {
        return;
      }
      const fatal = FATAL_CLOSE_REASONS[code];
      if (fatal) {
        // 断电/断网重启后，服务端旧连接可能仍在清理中；不再永久停止自动重连，
        // 改为延迟重试——服务端对活连接仍会拒绝（不会顶掉对方窗口），
        // 死连接被接管后，下次连接即可成功。
        log(`[relay] 收到 ${code}（${fatal}），30 秒后自动重试`);
        this.statusEmitter.fire({ state: 'offline', detail: `${fatal}。正在自动重试…` });
        this.retryMs = 30000;
        this.scheduleReconnect();
        return;
      }
      this.scheduleReconnect();
      this.statusEmitter.fire({ state: 'offline', detail: '与中继服务器断开，重连中...' });
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.timer) {
      return;
    }
    log(`[relay] 将在 ${this.retryMs}ms 后重连中继`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
      this.connect();
    }, this.retryMs);
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
}
