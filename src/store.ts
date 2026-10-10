import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { AdminDevice, ColleagueProfile, RoomCategory, RoomSummary } from './protocol';
import { log } from './logger';

export interface ColleagueConfig {
  id: string;
  /** 由中继/对端自动同步，本地只读展示 */
  role: string;
  scope: string;
  /** 中继上的路由 id（自动登记时等于 id；保留该字段以兼容历史配置） */
  relayPeerId: string;
  /** 允许该同事对我执行写操作（本地显式授权，默认关；变更后上报中继） */
  allowExec?: boolean;
  /** 停用后不参与工具层与自动注入；缺省视为启用 */
  enabled?: boolean;
}

/** 历史中继：连过 / 保存过的服务器（令牌另存 SecretStorage，按地址分开） */
export interface RelayRecord {
  url: string;
  /** 最近一次连接或保存的时间 */
  lastUsedAt: number;
}

/** 中继地址归一化：去空白、去结尾斜杠、协议与主机名小写（用于去重与令牌分键） */
export function normalizeRelayUrl(url: string): string {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

/** 令牌按中继分键存放：key 里带归一化地址，切换中继不用重新输令牌 */
function relaySecretKey(kind: 'token' | 'adminToken', url: string): string {
  return `talk2copilot.${kind}:${normalizeRelayUrl(url)}`;
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
  /** 历史中继列表（最近使用在前）：切换 / 删除都在「连接」页 */
  relays: RelayRecord[];
  behavior: {
    waitTimeoutSec: number;
    historyLimit: number;
    /** 无人值守：开启后收到同事消息自动交给本机 Copilot 处理；关闭（默认）只进收件箱，由用户手动处理 */
    unattended?: boolean;
    /** 写任务开始 / 结束时是否发系统通知（默认开；静音只影响通知，留痕不受影响） */
    notify?: boolean;
  };
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
  /** message 的意图标记（收到/发出时记下，用于收件箱区分问答与写任务） */
  intent?: 'ask' | 'task';
  ts: number;
  /** in：是否已回复；out：是否已收到回复 */
  done: boolean;
  /** out：用户手动取消了这条还没发出的排队消息 */
  canceled?: boolean;
  replyText?: string;
  /** 通过文件通道交接的文件（此时 id = 该次传输编号） */
  file?: HistoryFile;
}

function defaultConfig(): AppConfig {
  const user = os.userInfo().username || 'me';
  return {
    identity: { id: user, role: '', scope: '' },
    relay: { url: '', autoConnect: true },
    relays: [],
    behavior: { waitTimeoutSec: 90, historyLimit: 200, unattended: false, notify: true },
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
    relays: Array.isArray(raw.relays)
      ? [...new Map(
        raw.relays
          .map(r => ({ url: normalizeRelayUrl(String(r?.url ?? '')), lastUsedAt: Number(r?.lastUsedAt) || 0 }))
          .filter(r => r.url)
          .map(r => [r.url, r] as const),
      ).values()]
      : [],
    behavior: {
      ...base.behavior,
      ...(raw.behavior ?? {}),
      // 显式布尔化，容忍旧配置缺少该字段
      unattended: raw.behavior?.unattended === true,
      notify: raw.behavior?.notify !== false,
    },
    colleagues: Array.isArray(raw.colleagues)
      ? raw.colleagues.map(c => ({
        id: String(c?.id ?? ''),
        role: String(c?.role ?? ''),
        scope: String(c?.scope ?? ''),
        relayPeerId: String(c?.relayPeerId ?? ''),
        allowExec: c?.allowExec === true,
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

export class Store {
  private readonly configPath: string;
  private readonly historyPath: string;
  private cfg: AppConfig;
  private items: HistoryItem[] = [];
  private wsIdentity: WorkspaceIdentity = {};
  /** 房间列表（中继下发的可见域摘要）：仅内存缓存，连上后由中继下发 */
  private rooms: RoomSummary[] = [];
  /** 房间分类（中继下发，仅用于分组与排序）：仅内存缓存，连接后随 room-event 更新 */
  private categories: RoomCategory[] = [];
  /** 我被哪些同事授权可以派发写任务（中继下发，内存态，断线即清） */
  private grantedBy: string[] = [];
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
    // 密钥库是异步的：先做旧键迁移，再算出当前中继是否已设置管理令牌（界面据此显示管理页）
    void (async () => {
      await this.migrateLegacySecrets();
      this.adminTokenSet = Boolean(await this.readSecret('adminToken'));
      this.changeEmitter.fire();
    })().catch(() => undefined);
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

  /** 允许 / 禁止某位同事对我执行写操作（本地显式授权，默认关） */
  async setColleagueExecGrant(id: string, allow: boolean): Promise<void> {
    const idx = this.cfg.colleagues.findIndex(c => c.id === id);
    if (idx < 0 || this.cfg.colleagues[idx].allowExec === allow) {
      return;
    }
    this.cfg.colleagues[idx] = { ...this.cfg.colleagues[idx], allowExec: allow };
    await this.updateConfig(this.cfg);
  }

  /** 我授权了哪些同事可以对我执行写操作（上报中继的名单） */
  execGrantees(): string[] {
    return this.cfg.colleagues.filter(c => c.allowExec === true).map(c => c.id);
  }

  /** 我被哪些同事授权可以派发写任务（中继下发） */
  getGrantedBy(): string[] {
    return [...this.grantedBy];
  }

  /** 更新"我被授权"名单（中继下发；无变化时不触发变更通知） */
  setGrantedBy(ids: string[]): void {
    const next = [...new Set(ids)].sort();
    const current = [...this.grantedBy].sort();
    if (next.join(',') === current.join(',')) {
      return;
    }
    this.grantedBy = next;
    this.changeEmitter.fire();
  }

  /** 无人值守开关（收到同事消息是否自动交给本机 Copilot 处理） */
  async setUnattended(value: boolean): Promise<void> {
    if ((this.cfg.behavior.unattended === true) === value) {
      return;
    }
    this.cfg.behavior = { ...this.cfg.behavior, unattended: value };
    await this.updateConfig(this.cfg);
  }

  /** 静音 / 恢复系统通知（默认开） */
  async setNotify(value: boolean): Promise<void> {
    if ((this.cfg.behavior.notify !== false) === value) {
      return;
    }
    this.cfg.behavior = { ...this.cfg.behavior, notify: value };
    await this.updateConfig(this.cfg);
  }

  /** 取消所有写授权（一键全关）；返回被取消的人数 */
  async cancelAllExecGrants(): Promise<number> {
    const targets = this.cfg.colleagues.filter(c => c.allowExec === true);
    if (targets.length === 0) {
      return 0;
    }
    this.cfg.colleagues = this.cfg.colleagues.map(c => (c.allowExec === true ? { ...c, allowExec: false } : c));
    await this.updateConfig(this.cfg);
    return targets.length;
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

  async appendMessage(item: HistoryItem): Promise<void> {
    this.items.push(item);
    const limit = Math.max(this.cfg.behavior.historyLimit, 20);
    if (this.items.length > limit) {
      this.items = this.items.slice(-limit);
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

  /** 用户取消了这条还没发出的排队消息：标记一下，界面显示「已取消（未送达）」 */
  async markCanceled(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item || item.canceled) {
      return;
    }
    item.canceled = true;
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

  /** 历史中继（最近使用在前） */
  getRelays(): RelayRecord[] {
    return [...this.cfg.relays].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** 记下这个中继（连接 / 保存时调用）：已存在就只更新使用时间，最多留 20 条 */
  async rememberRelay(url: string): Promise<void> {
    const target = normalizeRelayUrl(url);
    if (!target) {
      return;
    }
    // 已经在最前面且刚记过：不重复写配置（连接流程会连续调用）
    const head = this.cfg.relays[0];
    if (head?.url === target && Date.now() - head.lastUsedAt < 5000) {
      return;
    }
    const list = [{ url: target, lastUsedAt: Date.now() }, ...this.cfg.relays.filter(r => r.url !== target)];
    try {
      await this.updateConfig({ ...this.cfg, relays: list.slice(0, 20) });
    } catch (err) {
      // 历史写入失败不该影响连接本身
      log(`[store] 历史中继写入失败：${String(err)}`);
    }
  }

  /** 从历史里删掉一个中继，连同它保存的令牌；当前地址不变时只是不再出现在列表里 */
  async forgetRelay(url: string): Promise<void> {
    const target = normalizeRelayUrl(url);
    if (!target) {
      return;
    }
    await this.updateConfig({ ...this.cfg, relays: this.cfg.relays.filter(r => r.url !== target) });
    await this.context.secrets.delete(relaySecretKey('token', target));
    await this.context.secrets.delete(relaySecretKey('adminToken', target));
    if (target === normalizeRelayUrl(this.cfg.relay.url)) {
      await this.refreshSecretFlags();
    }
  }

  /** 切换当前中继地址（令牌按中继分别取用，不需要在这里搬运） */
  async setRelayUrl(url: string): Promise<void> {
    const target = normalizeRelayUrl(url);
    await this.updateConfig({ ...this.cfg, relay: { ...this.cfg.relay, url: target || url } });
    await this.refreshSecretFlags();
  }

  /** 读当前中继的密钥：先按地址取，没有再回退到旧版本的全局键（迁移期兼容） */
  private async readSecret(kind: 'token' | 'adminToken'): Promise<string> {
    const scoped = await this.context.secrets.get(relaySecretKey(kind, this.cfg.relay.url));
    if (scoped) {
      return scoped;
    }
    const legacyKey = kind === 'token' ? 'talk2copilot.token' : 'talk2copilot.adminToken';
    return (await this.context.secrets.get(legacyKey)) ?? '';
  }

  /** 中继令牌，存入 SecretStorage 避免随设置同步（按中继分别保存） */
  async getToken(): Promise<string> {
    return this.readSecret('token');
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(relaySecretKey('token', this.cfg.relay.url), token);
  }

  /** 中继管理令牌（admin 权限）：与连接令牌分开存放 */
  async getAdminToken(): Promise<string> {
    return this.readSecret('adminToken');
  }

  async setAdminToken(token: string): Promise<void> {
    await this.context.secrets.store(relaySecretKey('adminToken', this.cfg.relay.url), token);
    this.adminTokenSet = true;
    this.changeEmitter.fire();
  }

  /** 切换中继后重算「管理令牌是否已设置」（界面据此显示管理页） */
  private async refreshSecretFlags(): Promise<void> {
    const value = await this.readSecret('adminToken');
    if (this.adminTokenSet !== Boolean(value)) {
      this.adminTokenSet = Boolean(value);
      this.changeEmitter.fire();
    }
  }

  /** 旧版本把令牌存在不带地址的键上：启动时复制一份到当前中继名下，之后各中继互不干扰 */
  private async migrateLegacySecrets(): Promise<void> {
    if (!normalizeRelayUrl(this.cfg.relay.url)) {
      return;
    }
    for (const kind of ['token', 'adminToken'] as const) {
      const legacyKey = kind === 'token' ? 'talk2copilot.token' : 'talk2copilot.adminToken';
      const legacy = await this.context.secrets.get(legacyKey);
      const scopedKey = relaySecretKey(kind, this.cfg.relay.url);
      if (legacy && !(await this.context.secrets.get(scopedKey))) {
        await this.context.secrets.store(scopedKey, legacy);
        log(`[store] 已把旧版${kind === 'token' ? '中继令牌' : '管理令牌'}迁移到当前中继名下`);
      }
    }
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

  getCategories(): RoomCategory[] {
    return this.categories;
  }

  setCategories(list: RoomCategory[]): void {
    this.categories = Array.isArray(list) ? list : [];
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
