import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { log, logError } from './logger';
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, FileMeta, makeEnvelope, makeId, MessageEnvelope } from './protocol';
import { colleagueEnabled, Store } from './store';
import { Transport } from './transport/types';

/** 等待对方确认（接受 offer / 收到某块）的超时 */
const ACK_TIMEOUT_MS = 60_000;
/** 等待对方最终回执（sha256 校验 + 落盘）的超时 */
const DONE_TIMEOUT_MS = 120_000;
/** 接收端空闲超时：超时未完成即丢弃 .part 并告知对方 */
const RECV_IDLE_TIMEOUT_MS = 5 * 60_000;
/** 同时进行的入站传输上限 */
const MAX_INCOMING = 2;

/** 一次文件交接的接收结果（供注入层使用） */
export interface FileArrival {
  /** 在收件箱中对应的记录 id（= transferId） */
  id: string;
  from: string;
  meta: FileMeta;
  /** 本机落盘后的完整路径 */
  savedPath: string;
  /** 实际落盘的文件名（净化或去重后可能与原名不同） */
  savedName: string;
  note?: string;
}

interface Incoming {
  from: string;
  meta: FileMeta;
  note?: string;
  tmpPath: string;
  fd: number;
  received: number;
  nextSeq: number;
  hash: ReturnType<typeof createHash>;
  timer?: ReturnType<typeof setTimeout>;
}

interface Outgoing {
  peerId: string;
  ackWaiters: Map<number, (env: MessageEnvelope | null) => void>;
  doneWaiter?: (env: MessageEnvelope | null) => void;
}

/**
 * 文件通道：整份文件由扩展分块收发（不经过双方模型），逐块确认 + sha256 校验。
 * 接收端落在扩展私有收件箱目录，重名自动加序号、绝不覆盖，也绝不写入工作区。
 */
export class FileHub {
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Outgoing>();

  constructor(
    private readonly store: Store,
    private readonly getTransport: () => Transport | undefined,
    private readonly onArrival: (arrival: FileArrival) => Promise<void>,
  ) {}

  /** 启动时清理上次未完成的 .part 残留 */
  cleanupStaleTransferFiles(): void {
    try {
      const dir = this.store.transfersDir();
      let removed = 0;
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.part')) {
          fs.rmSync(path.join(dir, name), { force: true });
          removed += 1;
        }
      }
      if (removed > 0) {
        log(`[file] 已清理 ${removed} 个未完成的传输残留`);
      }
    } catch (err) {
      logError('[file] 清理传输残留失败', err);
    }
  }

  /** 分发文件通道信封；返回 true 表示已由本模块接管 */
  handle(env: MessageEnvelope): boolean {
    if (!env.kind.startsWith('file-')) {
      return false;
    }
    switch (env.kind) {
      case 'file-offer':
        void this.onOffer(env);
        break;
      case 'file-chunk':
        this.onChunk(env);
        break;
      case 'file-ack':
        this.onAck(env);
        break;
      case 'file-end':
        void this.onEnd(env);
        break;
      case 'file-done':
        this.onDone(env);
        break;
      default:
        break;
    }
    return true;
  }

  /** 把本机文件发给一位同事；正常返回时对方已落盘并通过 sha256 校验 */
  async sendFile(peerId: string, filePath: string, note: string, token: vscode.CancellationToken):
    Promise<{ transferId: string; meta: FileMeta; savedName: string }> {
    const transport = this.getTransport();
    if (!transport) {
      throw new Error('通信通道未启动。请打开 Copilot2Copilot 配置界面检查中继地址与连接状态。');
    }
    if (!transport.isOnline(peerId)) {
      throw new Error(`同事 ${peerId} 当前不在线。文件传输需要双方同时在线（不会排队补发），请稍后重试。`);
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new Error(`找不到要发送的文件：${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`只能发送普通文件（当前路径不是文件）：${filePath}`);
    }
    if (stat.size > FILE_MAX_BYTES) {
      throw new Error(`文件 ${(stat.size / 1048576).toFixed(1)} MiB 超过上限 ${FILE_MAX_BYTES / 1048576} MiB。`);
    }
    const meta: FileMeta = { name: path.basename(filePath), size: stat.size, sha256: await hashFile(filePath) };
    const transferId = makeId('f');
    const outgoing: Outgoing = { peerId, ackWaiters: new Map() };
    this.outgoing.set(transferId, outgoing);
    const identity = this.store.config.identity;
    log(`[file] 开始发送 ${meta.name}（${meta.size} 字节，sha256 ${meta.sha256.slice(0, 12)}…）→ ${peerId}`);
    try {
      await transport.send(makeEnvelope({
        kind: 'file-offer', from: identity.id, to: peerId, transferId, file: meta, text: note || undefined, profile: identity,
      }));
      const offered = await this.waitAck(transferId, -1, ACK_TIMEOUT_MS, token);
      if (offered.ok === false) {
        throw new Error(`对方拒绝接收：${offered.reason || '未说明原因'}`);
      }
      const chunks = Math.ceil(meta.size / FILE_CHUNK_BYTES);
      const fh = await fs.promises.open(filePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
        for (let seq = 0; seq < chunks; seq += 1) {
          if (token.isCancellationRequested) {
            throw new Error('传输已取消');
          }
          const { bytesRead } = await fh.read(buf, 0, FILE_CHUNK_BYTES, seq * FILE_CHUNK_BYTES);
          await transport.send(makeEnvelope({
            kind: 'file-chunk',
            from: identity.id,
            to: peerId,
            transferId,
            seq,
            data: buf.subarray(0, bytesRead).toString('base64'),
          }));
          const ack = await this.waitAck(transferId, seq, ACK_TIMEOUT_MS, token);
          if (ack.ok === false) {
            throw new Error(`对方中止接收：${ack.reason || '未说明原因'}`);
          }
          if ((seq + 1) % 16 === 0 || seq === chunks - 1) {
            log(`[file] → ${peerId} ${meta.name}：${seq + 1}/${chunks} 块`);
          }
        }
      } finally {
        await fh.close();
      }
      await transport.send(makeEnvelope({ kind: 'file-end', from: identity.id, to: peerId, transferId }));
      const done = await this.waitDone(transferId, DONE_TIMEOUT_MS, token);
      if (done.ok === false) {
        throw new Error(`对方校验未通过：${done.reason || '未说明原因'}`);
      }
      log(`[file] 已送达 ${peerId}：${meta.name}（落盘名 ${done.savedName ?? meta.name}）`);
      return { transferId, meta, savedName: done.savedName ?? meta.name };
    } catch (err) {
      // 通知对端清理未完成的分片；对端若已正常结束会忽略这条
      void transport.send(makeEnvelope({
        kind: 'file-done',
        from: identity.id,
        to: peerId,
        transferId,
        ok: false,
        reason: (err as Error).message,
      }));
      log(`[file] 传输失败 ${meta.name} → ${peerId}：${(err as Error).message}`);
      throw err;
    } finally {
      this.outgoing.delete(transferId);
    }
  }

  private async onOffer(env: MessageEnvelope): Promise<void> {
    const transport = this.getTransport();
    const { transferId, file: meta } = env;
    const peerId = env.from;
    if (!transport || !transferId || !meta) {
      return;
    }
    const identity = this.store.config.identity;
    const reject = (reason: string): Promise<void> => {
      log(`[file] 拒绝 ${peerId} 的 ${meta.name || '(未命名)'}：${reason}`);
      return transport.send(makeEnvelope({
        kind: 'file-ack', from: identity.id, to: peerId, transferId, seq: -1, ok: false, reason, profile: identity,
      }));
    };
    if (this.incoming.has(transferId)) {
      await reject('传输编号重复');
      return;
    }
    if (this.incoming.size >= MAX_INCOMING) {
      await reject('本机正在接收其它文件，请稍后重试');
      return;
    }
    if (!Number.isInteger(meta.size) || meta.size < 0 || meta.size > FILE_MAX_BYTES) {
      await reject(`文件大小不合法或超过上限（${FILE_MAX_BYTES / 1048576} MiB）`);
      return;
    }
    if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
      await reject('文件摘要格式不正确');
      return;
    }
    if ([...this.incoming.values()].some(rec => rec.from === peerId)) {
      await reject('同一同事已有正在进行的传输');
      return;
    }
    const tmpPath = path.join(this.store.transfersDir(), `${transferId}.part`);
    let fd: number;
    try {
      fd = fs.openSync(tmpPath, 'wx', 0o600);
    } catch (err) {
      await reject(`无法创建临时文件：${(err as Error).message}`);
      return;
    }
    const rec: Incoming = {
      from: peerId,
      meta,
      note: env.text,
      tmpPath,
      fd,
      received: 0,
      nextSeq: 0,
      hash: createHash('sha256'),
    };
    rec.timer = setTimeout(() => void this.abortIncoming(transferId, '接收超时未完成'), RECV_IDLE_TIMEOUT_MS);
    this.incoming.set(transferId, rec);
    log(`[file] 开始接收 ${peerId} 的 ${meta.name}（${meta.size} 字节，声明 sha256 ${meta.sha256.slice(0, 12)}…）`);
    await transport.send(makeEnvelope({
      kind: 'file-ack', from: identity.id, to: peerId, transferId, seq: -1, ok: true, profile: identity,
    }));
  }

  private onChunk(env: MessageEnvelope): void {
    const { transferId } = env;
    const rec = transferId ? this.incoming.get(transferId) : undefined;
    const transport = this.getTransport();
    if (!rec || !transferId || !transport) {
      // 未知/过期的传输编号：静默丢弃残块（发送方那边已超时收场）
      return;
    }
    if (rec.timer) {
      rec.timer.refresh();
    }
    const seq = env.seq;
    if (typeof seq !== 'number' || seq !== rec.nextSeq) {
      void this.abortIncoming(transferId, `块序号不连续（期望 ${rec.nextSeq}，收到 ${String(seq)}）`);
      return;
    }
    const raw = typeof env.data === 'string' ? env.data : '';
    if (raw.length > FILE_CHUNK_BYTES * 2) {
      // 分片声明的长度固定为 FILE_CHUNK_BYTES，超过 2 倍 base64 长度的帧必属异常，先拦下再解码
      void this.abortIncoming(transferId, `分片长度异常（${raw.length} 字符）`);
      return;
    }
    const data = Buffer.from(raw, 'base64');
    if (data.length > FILE_CHUNK_BYTES) {
      void this.abortIncoming(transferId, `分片长度异常（${data.length} 字节）`);
      return;
    }
    if (rec.received + data.length > rec.meta.size) {
      void this.abortIncoming(transferId, '收到的数据超过声明大小');
      return;
    }
    try {
      fs.writeSync(rec.fd, data);
    } catch (err) {
      void this.abortIncoming(transferId, `写入临时文件失败：${(err as Error).message}`);
      return;
    }
    rec.hash.update(data);
    rec.received += data.length;
    rec.nextSeq += 1;
    void transport.send(makeEnvelope({
      kind: 'file-ack', from: this.store.config.identity.id, to: rec.from, transferId, seq, ok: true,
    }));
  }

  private onAck(env: MessageEnvelope): void {
    const outgoing = env.transferId ? this.outgoing.get(env.transferId) : undefined;
    const seq = env.seq;
    if (!outgoing || typeof seq !== 'number') {
      return;
    }
    outgoing.ackWaiters.get(seq)?.(env);
  }

  private onDone(env: MessageEnvelope): void {
    // 对端中止：清理本机正在接收的该次传输（接收端只在此处感知对方的主动放弃）
    if (env.ok === false && env.transferId && this.incoming.has(env.transferId)) {
      void this.abortIncoming(env.transferId, `对方中止：${env.reason || '未说明原因'}`);
    }
    const outgoing = env.transferId ? this.outgoing.get(env.transferId) : undefined;
    if (!outgoing) {
      return;
    }
    if (env.ok === false) {
      // 对端中途中止：唤醒正在等块确认的发送循环，让它立即停下
      for (const waiter of [...outgoing.ackWaiters.values()]) {
        waiter(env);
      }
    }
    outgoing.doneWaiter?.(env);
  }

  private async onEnd(env: MessageEnvelope): Promise<void> {
    const { transferId } = env;
    const rec = transferId ? this.incoming.get(transferId) : undefined;
    const transport = this.getTransport();
    if (!rec || !transferId || !transport) {
      return;
    }
    const identity = this.store.config.identity;
    const finish = (ok: boolean, reason?: string, savedName?: string): Promise<void> => {
      if (rec.timer) {
        clearTimeout(rec.timer);
      }
      this.incoming.delete(transferId);
      try {
        fs.closeSync(rec.fd);
      } catch {
        // 已关闭或写入失败，忽略
      }
      fs.rmSync(rec.tmpPath, { force: true });
      return transport.send(makeEnvelope({
        kind: 'file-done', from: identity.id, to: rec.from, transferId, ok, reason, savedName,
      }));
    };
    const digest = rec.hash.digest('hex');
    if (rec.received !== rec.meta.size) {
      log(`[file] 接收失败 ${rec.from} 的 ${rec.meta.name}：收到 ${rec.received} 字节，声明 ${rec.meta.size} 字节`);
      await finish(false, `字节数不符（收到 ${rec.received}，声明 ${rec.meta.size}）`);
      return;
    }
    if (digest !== rec.meta.sha256) {
      log(`[file] 接收失败 ${rec.from} 的 ${rec.meta.name}：sha256 校验失败`);
      await finish(false, 'sha256 校验失败');
      return;
    }
    let placed: { finalName: string; finalPath: string };
    try {
      placed = placeFile(this.store.filesDir(), rec.meta.name, rec.tmpPath);
    } catch (err) {
      logError(`[file] 落盘失败 ${rec.meta.name}`, err);
      await finish(false, `落盘失败：${(err as Error).message}`);
      return;
    }
    await finish(true, undefined, placed.finalName);
    await this.store.appendMessage({
      id: transferId,
      direction: 'in',
      peerId: rec.from,
      text: rec.note ?? '',
      ts: Date.now(),
      done: false,
      file: { name: placed.finalName, size: rec.meta.size, sha256: rec.meta.sha256, path: placed.finalPath },
    });
    log(`[file] 已接收 ${rec.from} 的 ${placed.finalName} → ${placed.finalPath}`);
    if (!colleagueEnabled(this.store.findColleague(rec.from))) {
      log(`[file] 沟通方 ${rec.from} 已停用，不注入对话（已记入收件箱）`);
      return;
    }
    await this.onArrival({
      id: transferId,
      from: rec.from,
      meta: rec.meta,
      savedPath: placed.finalPath,
      savedName: placed.finalName,
      note: rec.note,
    });
  }

  private async abortIncoming(transferId: string, reason: string): Promise<void> {
    const rec = this.incoming.get(transferId);
    if (!rec) {
      return;
    }
    if (rec.timer) {
      clearTimeout(rec.timer);
    }
    this.incoming.delete(transferId);
    try {
      fs.closeSync(rec.fd);
    } catch {
      // 忽略重复关闭
    }
    fs.rmSync(rec.tmpPath, { force: true });
    log(`[file] 中止接收 ${rec.from} 的 ${rec.meta.name}：${reason}`);
    await this.getTransport()?.send(makeEnvelope({
      kind: 'file-done', from: this.store.config.identity.id, to: rec.from, transferId, ok: false, reason,
    }));
  }

  private waitAck(transferId: string, seq: number, timeoutMs: number, token?: vscode.CancellationToken): Promise<MessageEnvelope> {
    const outgoing = this.outgoing.get(transferId);
    return this.waitFor(
      outgoing
        ? waiter => outgoing.ackWaiters.set(seq, env => {
          outgoing.ackWaiters.delete(seq);
          waiter(env);
        })
        : undefined,
      timeoutMs,
      token,
    ).then(env => {
      if (env) {
        return env;
      }
      if (token?.isCancellationRequested) {
        throw new Error('传输已取消');
      }
      throw new Error(seq < 0
        ? '等待对方接受文件超时（对方可能未升级到支持文件传输的版本，或已掉线）'
        : `等待对方确认第 ${seq + 1} 块超时，传输中断`);
    });
  }

  private async waitDone(transferId: string, timeoutMs: number, token?: vscode.CancellationToken): Promise<MessageEnvelope> {
    const outgoing = this.outgoing.get(transferId);
    const env = await this.waitFor(
      outgoing ? waiter => { outgoing.doneWaiter = waiter; } : undefined,
      timeoutMs,
      token,
    );
    if (env) {
      return env;
    }
    if (token?.isCancellationRequested) {
      throw new Error('传输已取消');
    }
    throw new Error('等待对方落盘回执超时（文件已发完但未收到确认，请稍后向对方核实）');
  }

  /** 注册一次性等待器：超时或取消时以 null 结束 */
  private waitFor(
    register: ((waiter: (env: MessageEnvelope | null) => void) => void) | undefined,
    timeoutMs: number,
    token?: vscode.CancellationToken,
  ): Promise<MessageEnvelope | null> {
    return new Promise<MessageEnvelope | null>(resolve => {
      if (!register) {
        resolve(null);
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sub: vscode.Disposable | undefined;
      const waiter = (env: MessageEnvelope | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        sub?.dispose();
        resolve(env);
      };
      timer = setTimeout(() => waiter(null), timeoutMs);
      sub = token?.onCancellationRequested(() => waiter(null));
      register(waiter);
    });
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 只保留基名并剔除路径分隔符/控制字符，确保落点始终在收件箱目录内 */
function safeFileName(raw: string): string {
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  if (!cleaned || /^\.+$/.test(cleaned)) {
    // 空名或 . / .. 这类退化名：换成兜底名
    return `file-${Date.now().toString(36)}`;
  }
  return truncateName(cleaned, 200);
}

/** 按 UTF-8 字节截断文件名（保留扩展名、不切断多字节字符），给重名后缀与 NAME_MAX 留余量 */
function truncateName(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) {
    return name;
  }
  const ext = path.extname(name);
  const keepExt = Buffer.byteLength(ext) <= 20;
  const stem = keepExt ? name.slice(0, -ext.length) : name;
  const budget = maxBytes - (keepExt ? Buffer.byteLength(ext) : 0);
  let out = '';
  let used = 0;
  for (const ch of stem) {
    const size = Buffer.byteLength(ch);
    if (used + size > budget) {
      break;
    }
    out += ch;
    used += size;
  }
  return out + (keepExt ? ext : '');
}

/** 把临时文件移入收件箱；重名自动加序号，绝不覆盖已有文件（link + unlink 保证原子且不覆盖） */
function placeFile(dir: string, rawName: string, tmpPath: string): { finalName: string; finalPath: string } {
  const base = safeFileName(rawName);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i <= 100; i += 1) {
    const name = i === 1 ? base : `${stem} (${i})${ext}`;
    const target = path.resolve(dir, name);
    if (!target.startsWith(`${dir}${path.sep}`)) {
      throw new Error('文件名越出收件箱目录');
    }
    try {
      fs.linkSync(tmpPath, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw err;
    }
    fs.unlinkSync(tmpPath);
    return { finalName: name, finalPath: target };
  }
  throw new Error('收件箱内同名文件过多，请清理收件目录后重试');
}
