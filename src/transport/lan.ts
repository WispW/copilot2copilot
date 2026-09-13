import * as vscode from 'vscode';
import * as os from 'os';
import type { IncomingMessage } from 'http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { log, logError } from '../logger';
import { ColleagueProfile, isEnvelope, makeEnvelope, MessageEnvelope } from '../protocol';
import { colleagueEnabled, Store } from '../store';
import { Transport, TransportStatus } from './types';

interface PeerLink {
  ws?: WebSocket;
  queue: MessageEnvelope[];
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_RETRY_MS = 60_000;
const MAX_QUEUE = 200;
/** 单个地址的身份探测超时；短超时是为了让整轮子网扫描能在几秒内结束 */
const PROBE_TIMEOUT_MS = 400;
/** 子网扫描的并发数 */
const SCAN_CONCURRENCY = 32;
/** 自动发现的扫描间隔 */
const SCAN_INTERVAL_MS = 60_000;
/** 虚拟网卡前缀：这些网段没有对等端，扫描它们只会浪费时间 */
const VIRTUAL_IFACE = /^(docker|veth|virbr|br-|tun|tap|wg|lo)/i;

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
  /** 已明确通告下线的同事（收到其任何消息后恢复在线） */
  private readonly offlinePeers = new Set<string>();
  private running = false;
  /** 监听失败的原因（端口被占用等）；非空时仍可出站，但收不到入站连接 */
  private listenProblem = '';
  /** 子网扫描定时器与进行中标记 */
  private scanTimer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.running = true;
    this.listenProblem = '';
    const { listenPort } = this.store.config.lan;
    log(`[lan] 启动：监听端口=${listenPort} 我的id=${this.store.config.identity.id || '(空)'} 同事数=${this.store.config.colleagues.length}（局域网模式不校验令牌）`);
    const bound = await this.startServer(listenPort);
    if (!bound) {
      const occupier = await this.probePortOccupier(listenPort);
      this.listenProblem = occupier
        ? `端口 ${listenPort} 已被本扩展的另一个窗口占用（对方档案 id=${occupier}）。本窗口收不到对方的连接，请改用其他监听端口`
        : `端口 ${listenPort} 已被占用（占用者未回应档案探测，可能不是本扩展或是旧版本）。本窗口收不到对方的连接，请改用其他监听端口`;
      log(`[lan] ${this.listenProblem}`);
    }
    for (const c of this.store.config.colleagues) {
      if (!colleagueEnabled(c)) {
        continue;
      }
      if (c.lanAddr) {
        log(`[lan] 待连接同事 ${c.id} → ${c.lanAddr}`);
        this.ensureLink(c.id);
      } else {
        log(`[lan] 同事 ${c.id} 未填写局域网地址，跳过主动连接`);
      }
    }
    this.reportStatus();
    // 自动发现：启动后扫一轮，之后定期扫（同网段新上线的设备随之被发现）
    void this.scanLan();
    this.stopScanTimer();
    this.scanTimer = setInterval(() => void this.scanLan(), SCAN_INTERVAL_MS);
  }

  private stopScanTimer(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  async stop(): Promise<void> {
    log('[lan] 停止');
    this.running = false;
    this.stopScanTimer();
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
      return Promise.resolve();
    }
    // 对方连入的连接等价可用；否则只会被连入的一方在地址不可回连时永远发不出去
    const inbound = this.inbound.get(env.to);
    if (inbound?.readyState === WebSocket.OPEN) {
      log(`[lan] 出站不可用，改经对方连入的连接发送 ${env.kind} → ${env.to}（消息 ${env.id}）`);
      inbound.send(JSON.stringify(env));
      return Promise.resolve();
    }
    log(`[lan] 连接不可用，入队 ${env.kind} → ${env.to}（队列 ${link.queue.length + 1} 条）`);
    link.queue.push(env);
    if (link.queue.length > MAX_QUEUE) {
      link.queue.shift();
      log('[lan] 队列超过上限，丢弃最早的一条');
    }
    this.ensureLink(env.to);
    return Promise.resolve();
  }

  /** 退出前尽力向所有沟通方发出下线通告（复用现有连接，不新建、不等待） */
  sendOfflineNotice(): void {
    const identity = this.store.config.identity;
    for (const c of this.store.config.colleagues) {
      const outbound = this.links.get(c.id)?.ws;
      const inbound = this.inbound.get(c.id);
      const ws = outbound?.readyState === WebSocket.OPEN ? outbound : inbound;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      ws.send(JSON.stringify(makeEnvelope({ kind: 'offline', from: identity.id, to: c.id, profile: identity })));
      log(`[lan] 已向 ${c.id} 发出下线通告`);
    }
  }

  isOnline(peerId: string): boolean {
    if (this.offlinePeers.has(peerId)) {
      return false;
    }
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

  /**
   * 启动监听。端口被占用时不再让整个启动流程失败（否则连主动连接同事的循环都不会执行），
   * 改为探测占用者并给出可操作的提示，同时保留出站能力。
   * @returns 监听是否成功
   */
  private startServer(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const server = new WebSocketServer({ port });
      server.once('listening', () => {
        this.server = server;
        log(`[lan] 监听成功 0.0.0.0:${port}`);
        resolve(true);
      });
      server.once('error', err => {
        logError(`[lan] 监听 ${port} 失败`, err);
        resolve(false);
      });
      server.on('connection', (ws, req) => this.acceptIncoming(ws, req.url ?? '/', req.socket.remoteAddress ?? ''));
    });
  }

  /**
   * 向某个地址发一次身份探测（`?probe=1`），成功则拿到对方档案。
   * 同一套握手既回答"端口占用者是谁"，也用于局域网自动发现。
   */
  private probePeer(ip: string, port: number): Promise<ColleagueProfile | null> {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://${ip}:${port}/?probe=1`, { handshakeTimeout: 2000 });
      let settled = false;
      const finish = (value: ColleagueProfile | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.terminate();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      ws.on('message', data => {
        try {
          const env = JSON.parse(data.toString()) as { kind?: string; profile?: ColleagueProfile };
          finish(env.kind === 'probeReply' && env.profile?.id ? env.profile : null);
        } catch {
          finish(null);
        }
      });
      // 监听器必须留到最后：terminate 会异步抛出 'error'，一旦无人监听就是未捕获异常
      ws.on('error', () => finish(null));
      ws.on('close', () => finish(null));
      ws.on('unexpected-response', () => finish(null));
    });
  }

  /** 端口被占用时探一下占用者：若是本扩展的另一个实例，就能问出它的档案 id */
  private async probePortOccupier(port: number): Promise<string> {
    return (await this.probePeer('127.0.0.1', port))?.id ?? '';
  }

  /** 供界面「扫描局域网」按钮调用 */
  scanDiscovered(): void {
    void this.scanLan();
  }

  /** 扫描本机各网段，自动发现监听同一端口、且也是本扩展的对等端 */
  private async scanLan(): Promise<void> {
    if (!this.running || this.scanning) {
      return;
    }
    const port = this.store.config.lan.listenPort;
    this.scanning = true;
    try {
      const targets: string[] = [];
      for (const [name, infos] of Object.entries(os.networkInterfaces())) {
        if (VIRTUAL_IFACE.test(name)) {
          continue;
        }
        for (const info of infos ?? []) {
          if (info.family !== 'IPv4' || info.internal) {
            continue;
          }
          const prefix = info.address.split('.').slice(0, 3).join('.');
          for (let host = 1; host <= 254; host += 1) {
            const ip = `${prefix}.${host}`;
            if (ip !== info.address) {
              targets.push(ip);
            }
          }
        }
      }
      if (targets.length === 0) {
        return;
      }
      let found = 0;
      for (let i = 0; i < targets.length; i += SCAN_CONCURRENCY) {
        const batch = targets.slice(i, i + SCAN_CONCURRENCY);
        const profiles = await Promise.all(batch.map(ip => this.probePeer(ip, port)));
        profiles.forEach((profile, k) => {
          if (!profile?.id) {
            return;
          }
          found += 1;
          void this.store.upsertDiscoveredPeer({
            id: profile.id,
            role: profile.role,
            scope: profile.scope,
            lanAddr: `${batch[k]}:${port}`,
          });
        });
        if (!this.running) {
          return;
        }
      }
      log(`[lan] 子网扫描完成：探测 ${targets.length} 个地址，发现 ${found} 个对等端`);
    } finally {
      this.scanning = false;
    }
  }

  private acceptIncoming(ws: WebSocket, url: string, remoteAddress: string): void {
    const params = new URL(url, 'http://localhost').searchParams;
    // 占用探测：只回应自己的档案 id 供对方提示用，不登记、不建立通道。
    // 故意不是协议 envelope（isEnvelope 会拒收），旧版本收到无 id 的探测会直接关闭连接，不会被污染。
    if (params.get('probe') === '1') {
      const identity = this.store.config.identity;
      log(`[lan] 收到端口占用探测，回应本机档案 id=${identity.id || '(空)'}`);
      ws.send(JSON.stringify({ kind: 'probeReply', profile: identity }));
      ws.close(4006, 'probe done');
      return;
    }
    const peerId = params.get('id') ?? '';
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
    // 对方连入即可当作发送通道：把此前积压的消息补发出去（否则只被连入的一侧会一直压队列）
    this.flush(this.linkFor(peerId), ws);
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
    if (!colleagueEnabled(colleague) || !colleague?.lanAddr) {
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
  /** 自己的档案声明消息（附可回连地址，供对方避开隧道/转发下错误的连接源 IP） */
  private helloEnvelope(peerId: string): string {
    const identity = { ...this.store.config.identity, addrs: this.store.myAddresses() };
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

  
  private flush(link: PeerLink, socket?: WebSocket): void {
    const ws = socket ?? link.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const pending = link.queue.splice(0);
    if (pending.length > 0) {
      log(`[lan] 补发队列消息 ${pending.length} 条`);
    }
    for (const env of pending) {
      ws.send(JSON.stringify(env));
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
    if (parsed.kind === 'offline') {
      this.offlinePeers.add(parsed.from);
      log(`[lan] 同事 ${parsed.from} 已通告下线`);
      this.reportStatus();
      return;
    }
    if (this.offlinePeers.delete(parsed.from)) {
      log(`[lan] 同事 ${parsed.from} 恢复在线`);
      this.reportStatus();
    }
    log(`[lan] 收到 ${parsed.kind} from=${parsed.from}（消息 ${parsed.id}）`);
    if (parsed.profile) {
      // 只有档案声明才参与地址学习：普通消息不带自报地址，若仍按连接源 IP 学习，
      // 刚学到的正确地址会被源 IP 覆盖（且恰好发生在只被连入的一侧）
      const observedAddr = parsed.kind === 'hello' ? (inboundAddr ?? '') : '';
      void this.store.applyPeerProfile(parsed.profile, parsed.from, observedAddr).then(changed => {
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
    if (!this.running) {
      this.statusEmitter.fire({ state: 'stopped', detail: '局域网模式已停止' });
      return;
    }
    this.statusEmitter.fire({
      state: 'online',
      detail: this.listenProblem ? `仅出站可用：${this.listenProblem}` : '局域网监听中',
    });
  }
}
