import * as vscode from 'vscode';
import type { IncomingMessage } from 'http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { log, logError } from '../logger';
import { isEnvelope, makeEnvelope, MessageEnvelope } from '../protocol';
import { Store } from '../store';
import { ConnState, Transport, TransportStatus } from './types';

interface PeerLink {
  ws?: WebSocket;
  queue: MessageEnvelope[];
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_RETRY_MS = 60_000;
const MAX_QUEUE = 200;

/** 局域网双向对等：本机监听端口，同时主动连接各同事；离线消息本地排队重发 */
export class LanTransport implements Transport {
  private readonly messageEmitter = new vscode.EventEmitter<MessageEnvelope>();
  readonly onMessage = this.messageEmitter.event;
  private readonly statusEmitter = new vscode.EventEmitter<TransportStatus>();
  readonly onStatus = this.statusEmitter.event;

  private server?: WebSocketServer;
  private readonly links = new Map<string, PeerLink>();
  private readonly inbound = new Map<string, WebSocket>();
  /** 本次连接中已向哪些同事声明过自己的档案（避免重复与回环） */
  private readonly helloSent = new Set<string>();
  private running = false;

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.running = true;
    const { listenPort } = this.store.config.lan;
    log(`[lan] 启动：监听端口=${listenPort} 我的id=${this.store.config.identity.id || '(空)'} 同事数=${this.store.config.colleagues.length}（局域网模式不校验令牌）`);
    await this.startServer(listenPort);
    for (const c of this.store.config.colleagues) {
      if (c.lanAddr) {
        log(`[lan] 待连接同事 ${c.id} → ${c.lanAddr}`);
        this.ensureLink(c.id);
      } else {
        log(`[lan] 同事 ${c.id} 未填写局域网地址，跳过主动连接`);
      }
    }
    this.reportStatus();
  }

  async stop(): Promise<void> {
    log('[lan] 停止');
    this.running = false;
    for (const link of this.links.values()) {
      if (link.timer) {
        clearTimeout(link.timer);
      }
      link.ws?.close();
    }
    this.links.clear();
    for (const ws of this.inbound.values()) {
      ws.close();
    }
    this.inbound.clear();
    this.server?.close();
    this.server = undefined;
    this.statusEmitter.fire({ state: 'stopped', detail: '局域网模式已停止' });
  }

  send(env: MessageEnvelope): Promise<void> {
    const link = this.linkFor(env.to);
    if (link.ws?.readyState === WebSocket.OPEN) {
      log(`[lan] 发送 ${env.kind} → ${env.to}（消息 ${env.id}）`);
      link.ws.send(JSON.stringify(env));
    } else {
      log(`[lan] 连接不可用，入队 ${env.kind} → ${env.to}（队列 ${link.queue.length + 1} 条）`);
      link.queue.push(env);
      if (link.queue.length > MAX_QUEUE) {
        link.queue.shift();
        log('[lan] 队列超过上限，丢弃最早的一条');
      }
      this.ensureLink(env.to);
    }
    return Promise.resolve();
  }

  isOnline(peerId: string): boolean {
    const outbound = this.links.get(peerId)?.ws?.readyState === WebSocket.OPEN;
    const inbound = this.inbound.get(peerId)?.readyState === WebSocket.OPEN;
    return Boolean(outbound || inbound);
  }

  connectPeer(peerId: string): void {
    const link = this.linkFor(peerId);
    if (link.ws && (link.ws.readyState === WebSocket.OPEN || link.ws.readyState === WebSocket.CONNECTING)) {
      log(`[lan] 手动连接 ${peerId}：已有连接（readyState=${link.ws.readyState}），跳过`);
      return;
    }
    if (link.timer) {
      clearTimeout(link.timer);
      link.timer = undefined;
    }
    link.retryMs = 1000;
    log(`[lan] 手动连接 ${peerId}`);
    this.ensureLink(peerId);
  }

  private linkFor(peerId: string): PeerLink {
    let link = this.links.get(peerId);
    if (!link) {
      link = { queue: [], retryMs: 1000 };
      this.links.set(peerId, link);
    }
    return link;
  }

  private startServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port });
      server.once('listening', () => {
        this.server = server;
        log(`[lan] 监听成功 0.0.0.0:${port}`);
        resolve();
      });
      server.once('error', err => {
        logError(`[lan] 监听 ${port} 失败`, err);
        this.statusEmitter.fire({ state: 'offline', detail: `监听 ${port} 失败: ${(err as Error).message}` });
        reject(err);
      });
      server.on('connection', (ws, req) => this.acceptIncoming(ws, req.url ?? '/', req.socket.remoteAddress ?? ''));
    });
  }

  private acceptIncoming(ws: WebSocket, url: string, remoteAddress: string): void {
    const peerId = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    if (!peerId) {
      log('[lan] 拒绝连接：对方未声明 id');
      ws.close(4002, 'missing id');
      return;
    }
    if (peerId === this.store.config.identity.id) {
      log(`[lan] 拒绝自连接：对方声明的 id="${peerId}" 与本机 id 相同。请检查两端“我的档案”的 id 是否重复`);
      ws.close(4005, 'self connection');
      return;
    }
    const known = this.store.config.colleagues.some(c => c.id === peerId);
    const ip = remoteAddress.replace(/^::ffff:/, '');
    const suggestedAddr = ip && ip !== '::1' && ip !== '127.0.0.1' ? ip : '';
    log(`[lan] 对方 ${peerId} 已连入（来自 ${remoteAddress || '未知地址'}）${known ? '' : '，首次出现，将自动登记为沟通方'}`);
    this.inbound.set(peerId, ws);
    ws.on('message', data => this.handleRaw(data, ws, suggestedAddr));
    ws.on('error', () => { /* 由 close 统一处理 */ });
    ws.on('close', () => {
      if (this.inbound.get(peerId) === ws) {
        this.inbound.delete(peerId);
      }
      this.helloSent.delete(peerId);
      log(`[lan] 对方 ${peerId} 的入站连接已断开`);
      this.reportStatus();
    });
    this.reportStatus();
  }

  private ensureLink(peerId: string): void {
    if (!this.running) {
      return;
    }
    const colleague = this.store.config.colleagues.find(c => c.id === peerId);
    if (!colleague?.lanAddr) {
      return;
    }
    const link = this.linkFor(peerId);
    if (link.ws && (link.ws.readyState === WebSocket.OPEN || link.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const raw = colleague.lanAddr.replace(/^wss?:\/\//, '').replace(/\/+$/, '');
    const addr = raw.includes(':') ? raw : `${raw}:${this.store.config.lan.listenPort}`;
    const url = `ws://${addr}/?id=${encodeURIComponent(this.store.config.identity.id)}`;
    log(`[lan] 连接 ${peerId} → ${url}${raw !== addr ? `（原地址未写端口，已按监听端口 ${this.store.config.lan.listenPort} 补全）` : ''}`);
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    link.ws = ws;
    ws.on('open', () => {
      log(`[lan] 已连接 ${peerId}（${addr}）`);
      link.retryMs = 1000;
      this.sendHello(peerId, link);
      this.flush(link);
      this.reportStatus();
    });
    ws.on('message', data => this.handleRaw(data, ws));
    ws.on('error', err => {
      logError(`[lan] 连接 ${peerId}（${addr}）出错`, err);
    });
    ws.on('close', (code, reason) => {
      let hint = '';
      if (code === 4005) {
        hint = ' ← 对方认为这是它自己（两端 id 重复），请改成不同的 id';
      } else if (code === 4002) {
        hint = ' ← 对方未声明 id，请检查“我的档案”里的 id 是否已填写';
      } else if (code === 1006) {
        hint = ' ← 连接异常中断（对方未启动/端口未放行/被防火墙拦截）';
      }
      log(`[lan] 与 ${peerId}（${addr}）的连接关闭：code=${code} reason=${reason.toString() || '(空)'}${hint}`);
      this.helloSent.delete(peerId);
      this.scheduleReconnect(peerId, link);
      this.reportStatus();
    });
  }

  private scheduleReconnect(peerId: string, link: PeerLink): void {
    if (!this.running || link.timer) {
      return;
    }
    log(`[lan] ${peerId} 将在 ${link.retryMs}ms 后重连`);
    link.timer = setTimeout(() => {
      link.timer = undefined;
      link.retryMs = Math.min(link.retryMs * 2, MAX_RETRY_MS);
      this.ensureLink(peerId);
    }, link.retryMs);
  }
  /** 自己的档案声明消息 */
  private helloEnvelope(peerId: string): string {
    const identity = this.store.config.identity;
    return JSON.stringify(makeEnvelope({ kind: 'hello', from: identity.id, to: peerId, profile: identity }));
  }

  /** 连接建立后声明自己的档案，供对方自动更新联系人信息 */
  private sendHello(peerId: string, link: PeerLink): void {
    if (link.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const identity = this.store.config.identity;
    log(`[lan] 向 ${peerId} 发送档案声明（角色=${identity.role || '空'} 负责=${identity.scope || '空'}）`);
    this.helloSent.add(peerId);
    link.ws.send(this.helloEnvelope(peerId));
  }

  
  private flush(link: PeerLink): void {
    if (link.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const pending = link.queue.splice(0);
    if (pending.length > 0) {
      log(`[lan] 补发队列消息 ${pending.length} 条`);
    }
    for (const env of pending) {
      link.ws.send(JSON.stringify(env));
    }
  }

  private handleRaw(data: RawData, srcWs?: WebSocket, inboundAddr?: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      log('[lan] 收到无法解析的数据，已忽略');
      return;
    }
    if (!isEnvelope(parsed) || parsed.kind === 'presence') {
      return;
    }
    log(`[lan] 收到 ${parsed.kind} from=${parsed.from}（消息 ${parsed.id}）`);
    if (parsed.profile) {
      void this.store.applyPeerProfile(parsed.profile, parsed.from, inboundAddr).then(changed => {
        if (changed) {
          this.reportStatus();
        }
        // 对方是主动连入的一方：回发一次自己的档案，保证双方都持有对方档案
        if (parsed.kind === 'hello' && srcWs && srcWs.readyState === WebSocket.OPEN && !this.helloSent.has(parsed.from)) {
          this.helloSent.add(parsed.from);
          log(`[lan] 回发档案声明给 ${parsed.from}`);
          srcWs.send(this.helloEnvelope(parsed.from));
        }
      });
    }
    this.messageEmitter.fire(parsed);
  }

  private reportStatus(): void {
    const total = this.store.config.colleagues.length;
    const online = this.store.config.colleagues.filter(c => this.isOnline(c.id)).length;
    const state: ConnState = this.running ? 'online' : 'stopped';
    this.statusEmitter.fire({ state, detail: `局域网监听中 · ${online}/${total} 同事在线` });
  }
}
