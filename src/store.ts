import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { AdminDevice, ColleagueProfile, RoomSummary } from './protocol';
import { log } from './logger';

export interface ColleagueConfig {
  id: string;
  /** 由中继/对端自动同步，本地只读展示 */
  role: string;
  scope: string;
  /** 中继上的路由 id（自动登记时等于 id；保留该字段以兼容历史配置） */
  relayPeerId: string;
  /** 停用后不参与工具层与自动注入；缺省视为启用 */
  enabled?: boolean;
}

/** 沟通方是否参与通信：停用的不主动连接、不进工具列表、不自动注入（消息仍记入收件箱） */
export function colleagueEnabled(c: ColleagueConfig | undefined): boolean {
  return Boolean(c) && c?.enabled !== false;
}

export interface AppConfig {
  /** 模板档案：只用于给新工作区档案预填角色与负责内容，不参与通信身份 */
  identity: ColleagueProfile;
  /** autoConnect：扩展启动时是否自动连接一次；关掉则停在未连接态，等用户点「连接」 */
  relay: { url: string; autoConnect: boolean };
  behavior: { waitTimeoutSec: number; historyLimit: number };
  colleagues: ColleagueConfig[];
}

/** 文件通道：本条历史记录关联的文件 */
export interface HistoryFile {
  name: string;
  size: number;
  sha256: string;
  /** in：本机落盘路径；out：本机源文件路径 */
  path: string;
}

/** 一条历史消息：direction=in 为收到，out 为发出 */
export interface HistoryItem {
  id: string;
  direction: 'in' | 'out';
  peerId: string;
  text: string;
  snippet?: string;
  snippetLanguage?: string;
  ts: number;
  /** in：是否已回复；out：是否已收到回复 */
  done: boolean;
  replyText?: string;
  /** 通过文件通道交接的文件（此时 id = 该次传输编号） */
  file?: HistoryFile;
}

function defaultConfig(): AppConfig {
  const user = os.userInfo().username || 'me';
  return {
    identity: { id: user, role: '', scope: '' },
    relay: { url: '', autoConnect: true },
    behavior: { waitTimeoutSec: 90, historyLimit: 200 },
    colleagues: [],
  };
}

/** 合并默认值，容忍旧配置缺字段（mode / lan / lanAddr 等局域网时代的字段会被丢弃） */
function normalize(raw: Partial<AppConfig>): AppConfig {
  const base = defaultConfig();
  return {
    identity: {
      id: raw.identity?.id?.trim() || base.identity.id,
      role: raw.identity?.role ?? '',
      scope: raw.identity?.scope ?? '',
    },
    relay: { url: raw.relay?.url ?? '', autoConnect: raw.relay?.autoConnect !== false },
    behavior: { ...base.behavior, ...(raw.behavior ?? {}) },
    colleagues: Array.isArray(raw.colleagues)
      ? raw.colleagues.map(c => ({
        id: String(c?.id ?? ''),
        role: String(c?.role ?? ''),
        scope: String(c?.scope ?? ''),
        relayPeerId: String(c?.relayPeerId ?? ''),
        enabled: c?.enabled !== false,
      }))
      : [],
  };
}

/**
 * 工作区级档案：本机每个窗口各持一份（强制使用，不再有全局通信身份），
 * 因此多窗口可以各有各的 id，不会在中继上互相顶下线、也不会在同一端口上打架。
 */
export type WorkspaceIdentity = { id?: string; role?: string; scope?: string };

/** 为新工作区分配一个本机唯一的 id，避免多窗口撞名 */
function newPeerId(templateId: string): string {
  const base = (templateId || os.userInfo().username || 'me').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24) || 'me';
  return `${base}-${randomBytes(2).toString('hex')}`;
}

/**
 * 疑似无限往返的判定：与同一位同事在窗口内的往来条数达到上限即熔断。
 * 计数直接取自收件箱/历史记录本身，因此无需额外状态、重启后依然有效，
 * 且完全由本机掌握——对端无法通过伪造字段把计数降下来。
 */
export const LOOP_WINDOW_MS = 5 * 60 * 1000;
export const LOOP_MESSAGE_LIMIT = 10;

export class Store {
  private readonly configPath: string;
  private readonly historyPath: string;
  private cfg: AppConfig;
  private items: HistoryItem[] = [];
  private wsIdentity: WorkspaceIdentity = {};
  /** 手动重置熔断计数的起点：只统计此刻之后的往来 */
  private loopResetAt = 0;
  /** 房间列表（中继下发的可见域摘要）：仅内存缓存，连上后由中继下发 */
  private rooms: RoomSummary[] = [];
  /** 管理员视角的在线设备与封禁名单：由 admin.list 应答刷新的内存快照 */
  private adminDevices: AdminDevice[] = [];
  private adminBans: string[] = [];
  private adminVerified = false;
  private adminTokenSet = false;
  /** 中继运行版本与协议号：连接成功后从 /healthz 获取，供界面展示 */
  private relayInfo: { version: string; protocol: number } = { version: '', protocol: 0 };
  /** 本扩展版本：连接时上报，中继按它做版本门禁 */
  readonly extensionVersion: string;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const dir = context.globalStorageUri.fsPath;
    this.extensionVersion = context.extension.packageJSON.version as string;
    void context.secrets.get('talk2copilot.adminToken').then(value => {
      this.adminTokenSet = Boolean(value);
      this.changeEmitter.fire();
    }, () => undefined);
    fs.mkdirSync(dir, { recursive: true });
    this.configPath = path.join(dir, 'config.json');
    this.historyPath = path.join(dir, 'history.json');
    this.cfg = this.readConfig();
    this.items = this.readHistory();
    const stored = context.workspaceState.get<WorkspaceIdentity>('talk2copilot.identity');
    if (stored) {
      this.wsIdentity = stored;
    } else {
      // 首次在该工作区启用：用模板预填角色/负责内容，并分配本窗口专属 id
      this.wsIdentity = {
        id: newPeerId(this.cfg.identity.id),
        role: this.cfg.identity.role,
        scope: this.cfg.identity.scope,
      };
      void context.workspaceState.update('talk2copilot.identity', this.wsIdentity);
      log(`[store] 已为本工作区创建档案：id=${this.wsIdentity.id ?? ''}（角色与负责内容取自模板，可在界面修改）`);
    }
  }

  private readConfig(): AppConfig {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<AppConfig>);
    } catch {
      return defaultConfig();
    }
  }

  private readHistory(): HistoryItem[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyPath, 'utf8')) as HistoryItem[];
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  /** 对外配置：identity 为当前生效档案（恒为工作区档案） */
  get config(): AppConfig {
    return { ...this.cfg, identity: this.identity };
  }

  /** 模板档案：仅为新工作区预填角色与负责内容，不参与通信身份 */
  get templateIdentity(): ColleagueProfile {
    return this.cfg.identity;
  }

  /** 当前生效档案：恒取工作区档案（首次使用时构造阶段已预填） */
  get identity(): ColleagueProfile {
    return {
      id: this.wsIdentity.id?.trim() ?? '',
      role: this.wsIdentity.role ?? '',
      scope: this.wsIdentity.scope ?? '',
    };
  }

  /** 当前工作区已设置的覆盖项（供界面回显） */
  get workspaceIdentity(): WorkspaceIdentity {
    return this.wsIdentity;
  }

  /** 当前工作区名（无工作区时为空串） */
  workspaceLabel(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return '';
    }
    return folders.length === 1 ? folders[0].name : `${folders[0].name} 等 ${folders.length} 个工作区`;
  }

  /** 文件收件箱目录：同事发来的文件落在这里（不进入工作区） */
  filesDir(): string {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'files');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 传输中转目录：接收中的 .part 文件，校验通过后移入收件箱 */
  transfersDir(): string {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'transfers');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 保存当前工作区档案（恒为工作区档案，不再有全局身份） */
  async setWorkspaceIdentity(next: WorkspaceIdentity): Promise<void> {
    this.wsIdentity = {
      id: next.id?.trim() ?? '',
      role: next.role ?? '',
      scope: next.scope ?? '',
    };
    await this.context.workspaceState.update('talk2copilot.identity', this.wsIdentity);
    this.changeEmitter.fire();
  }

  /** 把当前档案的角色/负责内容存为模板，供新工作区预填（不保存 id，否则新窗口会撞名） */
  async saveTemplateFromCurrent(): Promise<void> {
    const { role, scope } = this.identity;
    await this.updateConfig({ ...this.cfg, identity: { ...this.cfg.identity, role, scope } });
  }

  /**
   * 按 id 或中继 id 找沟通方；未指定 id 且只有一位时返回唯一那位。
   * 指向本窗口自己的条目一律不可用——配置是全局的（globalStorage）、身份是按窗口的，
   * 别的窗口做自动发现时可能把本窗口登记进来（id 或中继 id 命中自己都算）。
   */
  findColleague(id?: string): ColleagueConfig | undefined {
    const mine = this.identity.id;
    const otherOf = (c: ColleagueConfig): boolean => c.id !== mine && c.relayPeerId !== mine;
    if (id) {
      return this.cfg.colleagues.find(c => (c.id === id || c.relayPeerId === id) && otherOf(c));
    }
    const others = this.cfg.colleagues.filter(otherOf);
    return others.length === 1 ? others[0] : undefined;
  }

  async updateConfig(next: AppConfig): Promise<void> {
    this.cfg = normalize(next);
    fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2), 'utf8');
    this.changeEmitter.fire();
  }

  /** 收到带 profile 的消息时更新联系人档案；未登记的对方自动登记（可信内网） */
  async applyPeerProfile(profile: ColleagueProfile, peerId: string): Promise<boolean> {
    const idx = this.cfg.colleagues.findIndex(c => c.id === peerId || c.relayPeerId === peerId);
    if (idx < 0) {
      this.cfg.colleagues.push({ id: peerId, role: profile.role, scope: profile.scope, relayPeerId: peerId });
      await this.updateConfig(this.cfg);
      return true;
    }
    const c = this.cfg.colleagues[idx];
    if (c.role === profile.role && c.scope === profile.scope) {
      return false;
    }
    this.cfg.colleagues[idx] = { ...c, role: profile.role, scope: profile.scope };
    await this.updateConfig(this.cfg);
    return true;
  }

  /**
   * 自动发现的沟通方：不存在则新增，已存在则只补空字段；停用状态保留。
   * @returns 配置是否发生变化
   */
  async upsertDiscoveredPeer(found: { id: string; role?: string; scope?: string; relayPeerId?: string }): Promise<boolean> {
    const id = found.id.trim();
    if (!id || id === this.identity.id) {
      return false;
    }
    const idx = this.cfg.colleagues.findIndex(c => c.id === id);
    if (idx < 0) {
      this.cfg.colleagues.push({
        id,
        role: found.role ?? '',
        scope: found.scope ?? '',
        relayPeerId: found.relayPeerId ?? '',
        enabled: true,
      });
      await this.updateConfig(this.cfg);
      return true;
    }
    const c = this.cfg.colleagues[idx];
    const merged = {
      role: found.role || c.role,
      scope: found.scope || c.scope,
      relayPeerId: c.relayPeerId || found.relayPeerId || '',
    };
    if (merged.role === c.role && merged.scope === c.scope && merged.relayPeerId === c.relayPeerId) {
      return false;
    }
    this.cfg.colleagues[idx] = { ...c, ...merged };
    await this.updateConfig(this.cfg);
    return true;
  }

  /**
   * 中继下发的在线档案目录（中继是档案的权威来源）：登记/更新对应 Copilot 的角色与负责内容。
   * 只动档案字段——本地地址、中继 id、启用状态、自动/手工来源保持不变；离线条目不受影响。
   */
  async applyRelayDirectory(list: ColleagueProfile[]): Promise<boolean> {
    let changed = false;
    for (const profile of list) {
      // 目录来自中继，仍按外部输入校验：只接受字符串并限长
      if (typeof profile?.id !== 'string') {
        continue;
      }
      const id = profile.id.trim().slice(0, 128);
      if (!id || id === this.identity.id) {
        continue;
      }
      const role = (typeof profile.role === 'string' ? profile.role : '').slice(0, 200);
      const scope = (typeof profile.scope === 'string' ? profile.scope : '').slice(0, 200);
      const idx = this.cfg.colleagues.findIndex(c => c.id === id || c.relayPeerId === id);
      if (idx < 0) {
        this.cfg.colleagues.push({ id, role, scope, relayPeerId: id, enabled: true });
        changed = true;
        continue;
      }
      const c = this.cfg.colleagues[idx];
      // 目录以 id 为准：顺手把历史脏值（relayPeerId 与 id 不一致）归一到 id——
      // 该字段在界面上已不可编辑，不归一的话这类条目会永远被判离线
      if (c.role === role && c.scope === scope && c.relayPeerId === id) {
        continue;
      }
      this.cfg.colleagues[idx] = { ...c, role, scope, relayPeerId: id };
      changed = true;
    }
    if (changed) {
      await this.updateConfig(this.cfg);
    }
    return changed;
  }

  /** 启用 / 停用某位沟通方（停用后不参与工具层与自动注入） */
  async setColleagueEnabled(id: string, enabled: boolean): Promise<void> {
    const idx = this.cfg.colleagues.findIndex(c => c.id === id);
    if (idx < 0 || this.cfg.colleagues[idx].enabled === enabled) {
      return;
    }
    this.cfg.colleagues[idx] = { ...this.cfg.colleagues[idx], enabled };
    await this.updateConfig(this.cfg);
  }

  /** 我的档案缺失的字段名（用于界面提示与通信前校验，按当前生效档案判断） */
  missingIdentityFields(): string[] {
    const { id, role, scope } = this.identity;
    const missing: string[] = [];
    if (!id.trim()) {
      missing.push('id');
    }
    if (!role.trim()) {
      missing.push('角色');
    }
    if (!scope.trim()) {
      missing.push('负责内容');
    }
    return missing;
  }

  /** 沟通方档案是否已通过自动同步补齐（角色与负责内容均非空） */
  hasPeerProfile(colleague: ColleagueConfig): boolean {
    return Boolean(colleague.role.trim() && colleague.scope.trim());
  }

  /**
   * 窗口内与某同事的往来条数，数据取自收件箱历史（收发都算；回复附在原消息上、
   * 不另计一条）。重置操作只影响此后的统计。
   */
  recentMessageCount(peerId: string): number {
    const since = Math.max(Date.now() - LOOP_WINDOW_MS, this.loopResetAt);
    return this.items.reduce((n, item) => (item.peerId === peerId && item.ts > since ? n + 1 : n), 0);
  }

  /** 是否疑似无限往返（窗口内往来条数已达上限） */
  isLoopSuspected(peerId: string): boolean {
    return this.recentMessageCount(peerId) >= LOOP_MESSAGE_LIMIT;
  }

  /** 手动重置熔断计数：只统计此刻之后的往来 */
  resetLoopGuard(): void {
    this.loopResetAt = Date.now();
  }

  async appendMessage(item: HistoryItem): Promise<void> {
    this.items.push(item);
    const limit = Math.max(this.cfg.behavior.historyLimit, 20);
    if (this.items.length > limit) {
      // 熔断计数取自历史，故窗口内的记录一律保留：否则其他同事的流量会把它们挤出，
      // 导致计数被截断、熔断被意外解除
      const cutoff = Date.now() - LOOP_WINDOW_MS;
      const withinWindow = this.items.filter(i => i.ts > cutoff).length;
      this.items = this.items.slice(-Math.max(limit, withinWindow));
    }
    this.persistHistory();
    this.changeEmitter.fire();
  }

  async markDone(id: string, replyText?: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item) {
      return;
    }
    item.done = true;
    if (replyText !== undefined) {
      item.replyText = replyText;
    }
    this.persistHistory();
    this.changeEmitter.fire();
  }

  findMessage(id: string): HistoryItem | undefined {
    return this.items.find(i => i.id === id);
  }

  listMessages(limit = 100): HistoryItem[] {
    return this.items.slice(-limit).reverse();
  }

  async clearMessages(): Promise<void> {
    this.items = [];
    this.persistHistory();
    this.changeEmitter.fire();
  }

  private persistHistory(): void {
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(this.items, null, 2), 'utf8');
    } catch {
      // 历史写入失败不影响主流程
    }
  }

  /** 中继令牌，存入 SecretStorage 避免随设置同步 */
  async getToken(): Promise<string> {
    return (await this.context.secrets.get('talk2copilot.token')) ?? '';
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store('talk2copilot.token', token);
  }

  /** 中继管理令牌（admin 权限）：与连接令牌分开存放 */
  async getAdminToken(): Promise<string> {
    return (await this.context.secrets.get('talk2copilot.adminToken')) ?? '';
  }

  async setAdminToken(token: string): Promise<void> {
    await this.context.secrets.store('talk2copilot.adminToken', token);
    this.adminTokenSet = true;
    this.changeEmitter.fire();
  }

  /** 是否已设置管理令牌（供界面回显） */
  hasAdminToken(): boolean {
    return this.adminTokenSet;
  }

  getRooms(): RoomSummary[] {
    return this.rooms;
  }

  setRooms(list: RoomSummary[]): void {
    this.rooms = Array.isArray(list) ? list : [];
    this.changeEmitter.fire();
  }

  getAdminState(): { devices: AdminDevice[]; bans: string[]; verified: boolean } {
    return { devices: this.adminDevices, bans: this.adminBans, verified: this.adminVerified };
  }

  setAdminState(devices: AdminDevice[], bans: string[], verified: boolean): void {
    this.adminDevices = devices;
    this.adminBans = bans;
    this.adminVerified = verified;
    this.changeEmitter.fire();
  }

  getRelayInfo(): { version: string; protocol: number } {
    return this.relayInfo;
  }

  setRelayInfo(version: string, protocol: number): void {
    this.relayInfo = { version, protocol };
    this.changeEmitter.fire();
  }
}
