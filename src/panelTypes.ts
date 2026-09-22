import type { AdminDevice, ColleagueProfile, RoomSummary } from './protocol';
import type { AppConfig, HistoryItem, WorkspaceIdentity } from './store';
import type { TransportStatus } from './transport/types';

/** 主界面状态快照：扩展推给 webview 的唯一数据源（两侧共用同一份类型定义） */
export interface PanelState {
  /** 全局配置；其中 identity 为“模板档案”，只用于给新工作区预填角色与负责内容 */
  config: AppConfig;
  /** 当前生效档案（恒为工作区档案） */
  effectiveIdentity: ColleagueProfile;
  /** 当前工作区的档案 */
  workspaceIdentity: WorkspaceIdentity;
  /** 当前工作区名（无工作区时为空串） */
  workspaceLabel: string;
  status: TransportStatus;
  messages: HistoryItem[];
  onlineIds: string[];
  identityMissing: string[];
  /** 房间列表（中继下发）：可见域，未加入房间时看不到其他设备 */
  rooms: RoomSummary[];
  /** 管理员面板：令牌是否已设置、是否验证通过、在线设备与封禁名单 */
  admin: { tokenSet: boolean; verified: boolean; devices: AdminDevice[]; bans: string[] };
  /** 中继运行版本与协议号（连接成功后获取，供版本对照） */
  relayInfo: { version: string; protocol: number };
  /** 本扩展版本（版本门禁要求与中继一致） */
  extensionVersion: string;
  /** 熔断阈值（供「行为 / 帮助」页说明文案使用，避免界面另抄一份常量） */
  loopGuard: { windowMs: number; limit: number };
}

/** 扩展 → webview：状态推送 */
export interface PanelStateMessage {
  type: 'state';
  /** 为 true 时丢弃界面上的草稿（保存成功后由扩展置位） */
  resetDraft: boolean;
  state: PanelState;
}

/** webview → 扩展：界面动作 */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'save'; config: AppConfig; identity: WorkspaceIdentity; token: string; adminToken: string }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'roomOp'; op: string; payload?: Record<string, unknown> }
  | { type: 'adminOp'; op: string; payload?: Record<string, unknown> }
  | { type: 'refreshRooms' }
  | { type: 'refreshAdmin' }
  | { type: 'clearHistory' }
  | { type: 'openFilesDir' }
  | { type: 'resetLoopGuard' }
  | { type: 'toggleColleague'; peerId: string; enabled: boolean }
  | { type: 'saveTemplate' }
  | { type: 'showLogs' }
  | { type: 'uiError'; message: string }
  | { type: 'uiHint'; message: string };
