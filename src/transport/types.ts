import { Event } from 'vscode';
import { MessageEnvelope } from '../protocol';

export type ConnState = 'stopped' | 'connecting' | 'online' | 'offline';

export interface TransportStatus {
  state: ConnState;
  detail: string;
}

/** 通信通道统一抽象（当前实现为中继转发） */
export interface Transport {
  readonly onMessage: Event<MessageEnvelope>;
  readonly onStatus: Event<TransportStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 发送一条消息；连接不可用时入本地队列稍后重试 */
  send(env: MessageEnvelope): Promise<void>;
  /** 某个同事当前是否可达 */
  isOnline(peerId: string): boolean;
  /** 退出前尽力向所有沟通方发出下线通告（同步、不等待） */
  sendOfflineNotice(): void;
}
