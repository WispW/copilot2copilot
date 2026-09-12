import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ColleagueProfile } from './protocol';

export interface ColleagueConfig {
  id: string;
  /** 由对方自动同步，本地只读展示 */
  role: string;
  scope: string;
  /** 局域网地址，形如 192.168.5.40:3901 */
  lanAddr: string;
  /** manual=界面手填，不自动覆盖；auto=自动学习，可被后续学习结果纠正 */
  lanAddrSource?: 'manual' | 'auto';
  /** 中继模式下的对端 id */
  relayPeerId: string;
}

export type TransportMode = 'lan' | 'relay';

export interface AppConfig {
  mode: TransportMode;
  identity: ColleagueProfile;
  lan: { listenPort: number };
  relay: { url: string; myPeerId: string };
  behavior: { waitTimeoutSec: number; historyLimit: number };
  colleagues: ColleagueConfig[];
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
}

function defaultConfig(): AppConfig {
  const user = os.userInfo().username || 'me';
  return {
    mode: 'lan',
    identity: { id: user, role: '', scope: '' },
    lan: { listenPort: 3901 },
    relay: { url: '', myPeerId: user },
    behavior: { waitTimeoutSec: 90, historyLimit: 200 },
    colleagues: [],
  };
}

/** 合并默认值，容忍旧配置缺字段 */
function normalize(raw: Partial<AppConfig>): AppConfig {
  const base = defaultConfig();
  return {
    mode: raw.mode === 'relay' ? 'relay' : 'lan',
    identity: {
      id: raw.identity?.id?.trim() || base.identity.id,
      role: raw.identity?.role ?? '',
      scope: raw.identity?.scope ?? '',
    },
    lan: { listenPort: raw.lan?.listenPort || base.lan.listenPort },
    relay: { url: raw.relay?.url ?? '', myPeerId: raw.relay?.myPeerId || base.relay.myPeerId },
    behavior: { ...base.behavior, ...(raw.behavior ?? {}) },
    colleagues: Array.isArray(raw.colleagues)
      ? raw.colleagues.map(c => ({
        id: String(c?.id ?? ''),
        role: String(c?.role ?? ''),
        scope: String(c?.scope ?? ''),
        lanAddr: String(c?.lanAddr ?? ''),
        lanAddrSource: c?.lanAddrSource === 'manual' ? 'manual' : 'auto',
        relayPeerId: String(c?.relayPeerId ?? ''),
      }))
      : [],
  };
}

/**
 * 挑选该同事的可回连地址。连接源 IP 在隧道/转发/多实例场景下可能是第三方地址，
 * 故优先采用对端自报的地址；其中与源 IP 同址的那条最可信（顺便拿到对方端口）。
 */
function pickLanAddr(declared: unknown, observed: string): string {
  const list = (Array.isArray(declared) ? declared : [])
    .filter((a: unknown): a is string => typeof a === 'string')
    .map(a => a.trim())
    .filter(a => a.length > 0);
  if (!observed) {
    return list[0] ?? '';
  }
  const matched = list.find(a => a === observed || a.startsWith(`${observed}:`));
  return matched ?? list[0] ?? observed;
}

/** 工作区级档案覆盖（未设置的项回落全局默认） */
export type WorkspaceIdentity = { id?: string; role?: string; scope?: string };

export class Store {
  private readonly configPath: string;
  private readonly historyPath: string;
  private cfg: AppConfig;
  private items: HistoryItem[] = [];
  private wsIdentity: WorkspaceIdentity = {};

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    this.configPath = path.join(dir, 'config.json');
    this.historyPath = path.join(dir, 'history.json');
    this.cfg = this.readConfig();
    this.items = this.readHistory();
    this.wsIdentity = context.workspaceState.get<WorkspaceIdentity>('talk2copilot.identity') ?? {};
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

  /** 对外配置：identity 为当前生效档案（已合并工作区覆盖） */
  get config(): AppConfig {
    return { ...this.cfg, identity: this.identity };
  }

  /** 全局默认档案（界面在“未启用独立档案”时编辑它） */
  get defaultIdentity(): ColleagueProfile {
    return this.cfg.identity;
  }

  /** 当前生效档案：工作区覆盖 > 全局默认 */
  get identity(): ColleagueProfile {
    const base = this.cfg.identity;
    return {
      id: this.wsIdentity.id?.trim() || base.id,
      role: this.wsIdentity.role ?? base.role,
      scope: this.wsIdentity.scope ?? base.scope,
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

  /** 本机可被回连的局域网地址（含监听端口），随档案声明给同事并在面板展示 */
  myAddresses(): string[] {
    const port = this.cfg.lan.listenPort;
    const out: string[] = [];
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === 'IPv4' && !info.internal) {
          out.push(`${info.address}:${port}`);
        }
      }
    }
    return out;
  }

  /** 设置或清除当前工作区的独立档案 */
  async setWorkspaceIdentity(next: WorkspaceIdentity | undefined): Promise<void> {
    const normalized = next && (next.id?.trim() || next.role?.trim() || next.scope?.trim()) ? next : undefined;
    this.wsIdentity = normalized ?? {};
    await this.context.workspaceState.update('talk2copilot.identity', normalized);
    this.changeEmitter.fire();
  }

  /** 按 id 或中继 id 找沟通方；未指定 id 且只有一位时返回唯一那位 */
  findColleague(id?: string): ColleagueConfig | undefined {
    if (id) {
      return this.cfg.colleagues.find(c => c.id === id || c.relayPeerId === id);
    }
    return this.cfg.colleagues.length === 1 ? this.cfg.colleagues[0] : undefined;
  }

  async updateConfig(next: AppConfig): Promise<void> {
    this.cfg = normalize(next);
    fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2), 'utf8');
    this.changeEmitter.fire();
  }

  /** 收到 hello 或任意消息时更新联系人档案；未登记的对方自动登记（可信内网） */
  async applyPeerProfile(profile: ColleagueProfile, peerId: string, suggestedAddr = ''): Promise<boolean> {
    const learned = pickLanAddr(profile.addrs, suggestedAddr);
    const idx = this.cfg.colleagues.findIndex(c => c.id === peerId || c.relayPeerId === peerId);
    if (idx < 0) {
      this.cfg.colleagues.push({
        id: peerId,
        role: profile.role,
        scope: profile.scope,
        lanAddr: learned,
        lanAddrSource: 'auto',
        relayPeerId: '',
      });
      await this.updateConfig(this.cfg);
      return true;
    }
    const c = this.cfg.colleagues[idx];
    // 界面手填的地址不覆盖；自动学到的地址允许被后续学习结果纠正
    const lanAddr = c.lanAddr && c.lanAddrSource === 'manual' ? c.lanAddr : (learned || c.lanAddr);
    if (c.role === profile.role && c.scope === profile.scope && c.lanAddr === lanAddr) {
      return false;
    }
    this.cfg.colleagues[idx] = {
      ...c,
      role: profile.role,
      scope: profile.scope,
      lanAddr,
      // 手填值不存在时退回自动学习，避免空地址连同 manual 标记一起被锁死
      lanAddrSource: c.lanAddrSource === 'manual' && lanAddr ? 'manual' : 'auto',
    };
    await this.updateConfig(this.cfg);
    return true;
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

  /** 局域网/中继共用令牌，存入 SecretStorage 避免随设置同步 */
  async getToken(): Promise<string> {
    return (await this.context.secrets.get('talk2copilot.token')) ?? '';
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store('talk2copilot.token', token);
  }
}
