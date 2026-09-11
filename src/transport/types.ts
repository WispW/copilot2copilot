import { Event } from 'vscode';
import { MessageEnvelope } from '../protocol';

export type ConnState = 'stopped' | 'connecting' | 'online' | 'offline';

export interface TransportStatus {
  state: ConnState;
  detail: string;
}

/** 通信通道统一抽象：局域网对等直连 或 中继转发 */
export interface Transport {
  readonly onMessage: Event<MessageEnvelope>;
  readonly onStatus: Event<TransportStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 发送一条消息；连接不可用时入本地队列稍后重试 */
  send(env: MessageEnvelope): Promise<void>;
  /** 立即尝试建立到某位同事的连接（局域网：主动直连；中继：确保与中继服务器的连接） */
  connectPeer(peerId: string): void;
  /** 某个同事当前是否可达 */
  isOnline(peerId: string): boolean;
}
