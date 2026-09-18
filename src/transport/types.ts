import { Event } from 'vscode';
import { MessageEnvelope } from '../protocol';

export type ConnState = 'stopped' | 'connecting' | 'online' | 'offline';

export interface TransportStatus {
  state: ConnState;
  detail: string;
}

/** 中继控制面（房间 / 管理）操作结果 */
export interface ControlResult {
  ok: boolean;
  error?: string;
  /** 原始应答信封（ok=true 时携带 rooms / room / devices / bans 等载荷） */
  env?: MessageEnvelope;
}

/** 通信通道统一抽象（当前实现为中继转发） */
export interface Transport {
  readonly onMessage: Event<MessageEnvelope>;
  readonly onStatus: Event<TransportStatus>;
  /** 中继拒收回执：原消息 id 在 refId，原因在 error（如与目标没有共同房间） */
  readonly onRejected: Event<MessageEnvelope>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 发送一条消息；连接不可用时入本地队列稍后重试 */
  send(env: MessageEnvelope): Promise<void>;
  /** 某个同事当前是否可达 */
  isOnline(peerId: string): boolean;
  /** 退出前尽力向所有沟通方发出下线通告（同步、不等待） */
  sendOfflineNotice(): void;
  /** 中继控制面操作；通道未启动、无中继或服务端过旧（无响应）时返回 ok=false 与原因 */
  controlOp(kind: 'room' | 'admin', op: string, payload?: Record<string, unknown>): Promise<ControlResult>;
}
