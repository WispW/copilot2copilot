/**
 * 双端共享的消息协议：扩展 ↔ 中继 ↔ 扩展。
 * relay/server.js 直接按同样的字段路由，改动本文件时需同步中继。
 */

export const PROTOCOL_VERSION = 1;

/** 沟通方档案：角色 / 负责内容，用于双方 Copilot 相互理解 */
export interface ColleagueProfile {
  id: string;
  role: string;
  scope: string;
}

export type MessageKind = 'hello' | 'message' | 'reply' | 'presence';

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
  /** message / reply：正文与可选代码片段 */
  text?: string;
  snippet?: string;
  snippetLanguage?: string;
  /** reply：被回复的消息 id */
  requestId?: string;
  /** presence：中继广播的在线成员名单（仅由中继发往客户端） */
  peers?: string[];
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
    && (e.kind === 'hello' || e.kind === 'message' || e.kind === 'reply' || e.kind === 'presence');
}
