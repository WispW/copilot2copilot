import * as vscode from 'vscode';
import { RawData, WebSocket } from 'ws';
import { log, logError } from '../logger';
import { isEnvelope, makeEnvelope, MessageEnvelope } from '../protocol';
import { Store } from '../store';
import { Transport, TransportStatus } from './types';

const MAX_RETRY_MS = 30_000;

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
  /** 本次连接中已向哪些同事声明过自己的档案（避免重复与回环） */
  private readonly helloSent = new Set<string>();
  /** 已明确通告下线的同事（收到其任何消息后恢复在线） */
  private readonly offlinePeers = new Set<string>();

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.running = true;
    this.token = await this.store.getToken();
    log(`[relay] 启动：地址=${this.store.config.relay.url || '(空)'} 我的id=${this.store.config.relay.myPeerId || '(空)'} 令牌=${this.token ? '已设置' : '未设置'}`);
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
    this.helloSent.clear();
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

  /** 本机在中继上的 id：消息的 from 用它，便于对方识别与回投 */
  private myRelayId(): string {
    return this.store.config.relay.myPeerId || this.store.config.identity.id;
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
      if (!c.relayPeerId) {
        continue;
      }
      void this.send(makeEnvelope({ kind: 'offline', from: this.myRelayId(), to: c.id, profile: identity }));
      log(`[relay] 已向 ${c.id} 发出下线通告`);
    }
  }

  /** 中继模式下“连接某位同事”等价于确保与中继服务器的连接 */
  connectPeer(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      log(`[relay] 手动连接：已有连接（readyState=${this.ws.readyState}），跳过`);
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.retryMs = 1000;
    this.connect();
  }

  private connect(): void {
    if (!this.running) {
      return;
    }
    const { url, myPeerId } = this.store.config.relay;
    if (!url || !myPeerId) {
      log('[relay] 未配置中继地址或我的 id，无法连接');
      this.statusEmitter.fire({ state: 'offline', detail: '未配置中继服务器地址或我的 id' });
      return;
    }
    const wsUrl = `${url.replace(/\/+$/, '')}/ws?id=${encodeURIComponent(myPeerId)}`;
    log(`[relay] 连接中继 ${wsUrl}${this.token ? '（携带令牌）' : ''}`);
    this.statusEmitter.fire({ state: 'connecting', detail: '正在连接中继服务器...' });
    const ws = new WebSocket(wsUrl, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
      handshakeTimeout: 8000,
    });
    this.ws = ws;
    ws.on('open', () => {
      log('[relay] 已连接中继服务器');
      this.retryMs = 1000;
      this.statusEmitter.fire({ state: 'online', detail: '已连接中继服务器' });
      const identity = this.store.config.identity;
      for (const c of this.store.config.colleagues) {
        if (c.relayPeerId) {
          log(`[relay] 向 ${c.relayPeerId} 发送档案声明`);
          this.helloSent.add(c.id);
          ws.send(JSON.stringify(makeEnvelope({ kind: 'hello', from: this.myRelayId(), to: c.relayPeerId, profile: identity })));
        }
      }
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
      this.helloSent.clear();
      if (this.running) {
        this.scheduleReconnect();
        this.statusEmitter.fire({ state: 'offline', detail: '与中继服务器断开，重连中...' });
      }
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
      log(`[relay] 在线名单更新：${[...this.onlinePeers].join(', ') || '(空)'}`);
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
      void this.store.applyPeerProfile(parsed.profile, parsed.from).then(changed => {
        if (changed) {
          this.refreshPresenceStatus();
        }
        if (parsed.kind === 'hello' && !this.helloSent.has(parsed.from)) {
          this.helloSent.add(parsed.from);
          log(`[relay] 回发档案声明给 ${parsed.from}`);
          void this.send(makeEnvelope({ kind: 'hello', from: this.store.config.identity.id, to: parsed.from, profile: this.store.config.identity }));
        }
      });
    }
    this.messageEmitter.fire(parsed);
  }

  private refreshPresenceStatus(): void {
    this.statusEmitter.fire({ state: 'online', detail: '已连接中继服务器' });
  }
}
