/**
 * 双端共享的消息协议：扩展 ↔ 中继 ↔ 扩展。
 * relay/server.js 直接按同样的字段路由（不校验 kind），改动本文件时需同步中继。
 */

/**
 * 协议版本：v5 新增信任授权（成员上报"我授权谁对我执行写操作"，中继下发"我被谁授权"）；
 * v4 新增房间共享记忆（成员 query/remember/update/delete/restore，管理员 memory-*）；
 * v3 起房间由中继管理员统一维护并落盘。中继按扩展版本号做接入门禁（本文件改动时需同步 relay/server.js）
 */
export const PROTOCOL_VERSION = 5;

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
}

/**
 * 房间公开摘要（中继下发，按接收者定制）。
 * 房间列表（名称 / 分类 / 人数 / 是否有密码）对所有设备可见，凭密码加入；
 * 房间是可见域：只有同房间成员能互相看到并通信。
 * members 仅同房间成员与管理员可见；blocked（禁止再加入名单）与 bannedMembers 仅管理员可见。
 */
export interface RoomSummary {
  id: string;
  name: string;
  /** 所属分类 id（中继分类只做分组与排序；空串表示未分类） */
  categoryId: string;
  /** 创建该房间的管理员 id（仅供展示与审计；房间管理权始终在管理令牌持有者手里） */
  createdBy: string;
  hasPassword: boolean;
  memberCount: number;
  /** 房间内未删除的共享记忆条数（中继下发，用于界面提示） */
  memoryCount: number;
  /** 请求者是否已在该房间中 */
  joined: boolean;
  members?: string[];
  /** 成员中当前在线的 id（与 members 同权限可见）：用于界面标注离线成员 */
  onlineMembers?: string[];
  blocked?: string[];
  /** 成员中被中继封禁（设备级）的 id：仅管理员可见；封禁需管理员解除，这里只做标注 */
  bannedMembers?: string[];
}

/** 房间分类：仅用于分组与排序，不承载任何权限；由中继管理员维护并随房间状态落盘 */
export interface RoomCategory {
  id: string;
  name: string;
  createdAt: number;
}

/** 记忆条目（中继 memory 操作返回；history 仅在 get 时下发） */
export interface MemoryEntry {
  id: string;
  roomId: string;
  roomName: string;
  text: string;
  tags: string[];
  author: string;
  createdAt: number;
  revision: number;
  updatedBy: string;
  updatedAt: number;
  /** 来源消息 / 文件编号（可选） */
  sourceRequestId?: string;
  /** 软删除标记 */
  deleted?: { by: string; at: number };
  /** 历史版本（get 时下发）：最近 10 版，不含当前版 */
  history?: MemoryHistoryVersion[];
  /** 检索分（仅 query 返回） */
  score?: number;
}

/** 记忆历史版本 */
export interface MemoryHistoryVersion {
  revision: number;
  by: string;
  at: number;
  text: string;
  tags: string[];
}

/** 管理员视角的在线设备（仅 admin.list 下发） */
export interface AdminDevice {
  id: string;
  /** 客户端上报的扩展版本（-testN / -testN.M 后缀会被中继忽略，但仍原样记录） */
  version: string;
  admin: boolean;
  /** 所在房间 id */
  roomIds: string[];
}

export type MessageKind = 'hello' | 'message' | 'reply' | 'presence' | 'offline'
  | 'file-offer' | 'file-chunk' | 'file-ack' | 'file-end' | 'file-done'
  | 'room' | 'admin' | 'room-event' | 'memory' | 'trust' | 'error';

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
  /**
   * message：意图标记。'task' = 请求对方执行写操作（需对方已授权，未授权会被拒）；
   * 缺省（含旧版本客户端）一律按 'ask'（只问信息）处理。
   */
  intent?: 'ask' | 'task';
  /** reply：被回复的消息 id */
  requestId?: string;
  /** presence：中继广播的在线成员名单（仅由中继发往客户端） */
  peers?: string[];
  /**
   * presence：中继广播的在线档案目录（仅由中继发往客户端）。
   * peers 仍是判定在线的依据；未上报档案的在线设备不会出现在这里。
   */
  profiles?: ColleagueProfile[];
  /**
   * 控制面（kind=room/admin）：操作名与请求/应答载荷。
   * 请求由客户端发往 to='server'；中继的应答 id 与请求相同（用于关联），
   * 载荷经 payload 回传（rooms / room / devices / bans 等）。
   */
  op?: string;
  payload?: Record<string, unknown>;
  /** 控制面应答：失败原因（ok=false 时） */
  error?: string;
  /** room-event：按接收者定制的房间列表与分类列表（仅由中继生成） */
  rooms?: RoomSummary[];
  categories?: RoomCategory[];
  /** error（中继拒收回执）：被拒的原消息 id */
  refId?: string;
  /** 文件通道：一次交接的编号，同时用作收件箱中该条记录的 id */
  transferId?: string;
  /** file-offer：待传文件的元数据 */
  file?: FileMeta;
  /** file-chunk：块序号（从 0 起）；file-ack：被确认的块序号，-1 表示对 offer 的应答 */
  seq?: number;
  /** file-chunk：块的 base64 内容 */
  data?: string;
  /** file-ack / file-done / 控制面应答（room/admin）：是否成功 */
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
      || e.kind === 'file-offer' || e.kind === 'file-chunk' || e.kind === 'file-ack' || e.kind === 'file-end' || e.kind === 'file-done'
      || e.kind === 'room' || e.kind === 'admin' || e.kind === 'room-event' || e.kind === 'memory' || e.kind === 'trust' || e.kind === 'error');
}
