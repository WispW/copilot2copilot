/**
 * 双端共享的消息协议：扩展 ↔ 中继 ↔ 扩展。
 * relay/server.js 直接按同样的字段路由（不校验 kind），改动本文件时需同步中继。
 */

export const PROTOCOL_VERSION = 1;

/** 文件通道：单个文件大小上限与分块大小（512 KiB 经 base64 约 683 KiB，低于中继 2 MiB 的单帧上限） */
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 512 * 1024;

/** 一次文件交接的元数据：接收端据此校验大小与 sha256 */
export interface FileMeta {
  name: string;
  size: number;
  sha256: string;
}

/** 沟通方档案：角色 / 负责内容，用于双方 Copilot 相互理解 */
export interface ColleagueProfile {
  id: string;
  role: string;
  scope: string;
  /**
   * 本机可被回连的局域网地址（含端口），随 hello 声明。
   * 对端学到的是连接源 IP，经隧道/转发/多实例时可能是第三方地址，故用自报值兜底。
   */
  addrs?: string[];
}

export type MessageKind = 'hello' | 'message' | 'reply' | 'presence' | 'offline'
  | 'file-offer' | 'file-chunk' | 'file-ack' | 'file-end' | 'file-done';

export interface MessageEnvelope {
  v: number;
  kind: MessageKind;
  /** 消息唯一 id */
  id: string;
  from: string;
  to: string;
  ts: number;
  /** hello：携带发送方档案，供对方自动更新联系人信息 */
  profile?: ColleagueProfile;
  /** message / reply：正文与可选代码片段；file-offer：随文件的附言 */
  text?: string;
  snippet?: string;
  snippetLanguage?: string;
  /** reply：被回复的消息 id */
  requestId?: string;
  /** presence：中继广播的在线成员名单（仅由中继发往客户端） */
  peers?: string[];
  /**
   * presence：中继广播的在线档案目录（仅由中继发往客户端）。
   * peers 仍是判定在线的依据；未上报档案的在线设备不会出现在这里。
   */
  profiles?: ColleagueProfile[];
  /** 文件通道：一次交接的编号，同时用作收件箱中该条记录的 id */
  transferId?: string;
  /** file-offer：待传文件的元数据 */
  file?: FileMeta;
  /** file-chunk：块序号（从 0 起）；file-ack：被确认的块序号，-1 表示对 offer 的应答 */
  seq?: number;
  /** file-chunk：块的 base64 内容 */
  data?: string;
  /** file-ack / file-done：是否成功 */
  ok?: boolean;
  /** 失败原因（ok=false 时） */
  reason?: string;
  /** file-done：接收端实际落盘的文件名（重名时可能与原名不同） */
  savedName?: string;
}

let seq = 0;

export function makeId(prefix = 'm'): string {
  seq = (seq + 1) % 1000;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeEnvelope(partial: Omit<MessageEnvelope, 'v' | 'id' | 'ts'> & { id?: string }): MessageEnvelope {
  return {
    v: PROTOCOL_VERSION,
    id: partial.id ?? makeId(),
    ts: Date.now(),
    ...partial,
  };
}

/** 中继模式下按 to 字段路由的最小校验 */
export function isEnvelope(value: unknown): value is MessageEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const e = value as Partial<MessageEnvelope>;
  return typeof e.id === 'string' && typeof e.from === 'string' && typeof e.to === 'string'
    && (e.kind === 'hello' || e.kind === 'message' || e.kind === 'reply' || e.kind === 'presence' || e.kind === 'offline'
      || e.kind === 'file-offer' || e.kind === 'file-chunk' || e.kind === 'file-ack' || e.kind === 'file-end' || e.kind === 'file-done');
}
