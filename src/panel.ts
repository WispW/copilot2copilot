import * as vscode from 'vscode';
import { log, showLogs } from './logger';
import { AdminDevice, ColleagueProfile, RoomSummary } from './protocol';
import { AppConfig, ColleagueConfig, HistoryItem, LOOP_MESSAGE_LIMIT, LOOP_WINDOW_MS, Store, WorkspaceIdentity } from './store';
import { ControlResult, TransportStatus } from './transport/types';

interface PanelState {
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
}

interface PanelDeps {
  getStatus(): TransportStatus;
  getOnlineIds(): string[];
  restart(): Promise<void>;
  control(kind: 'room' | 'admin', op: string, payload?: Record<string, unknown>): Promise<ControlResult>;
  refreshAdmin(): Promise<void>;
}

export class ConsolePanel {
  private panel?: vscode.WebviewPanel;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly deps: PanelDeps,
  ) {
    this.store.onDidChange(() => this.postState());
    context.subscriptions.push(this.registerSerializer());
  }

  /** 接管被 VS Code 恢复的页面，避免重载后再次点击又开一个 */
  private registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer('talk2copilot.console', {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
        log('[panel] 接管已恢复的配置页面');
        this.attach(panel);
        this.postState();
      },
    });
  }

  /** 打开配置页面：已存在则只聚焦，保证全局单例 */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      this.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel('talk2copilot.console', 'Copilot2Copilot', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    log('[panel] 打开配置页面');
    this.attach(panel);
    this.postState();
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview, vscode.Uri.joinPath(this.context.extensionUri, 'media'));
    panel.webview.onDidReceiveMessage(msg => void this.handleMessage(msg), undefined, this.context.subscriptions);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
      this.stopRefresh();
    }, undefined, this.context.subscriptions);
    this.startRefresh();
  }

  /** 页面存在期间低频推送，保证界面始终最新（热刷新兜底） */
  private startRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setInterval(() => this.postState(), 5000);
  }

  private stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  postState(resetDraft = false): void {
    void this.panel?.webview.postMessage({ type: 'state', resetDraft, state: this.buildState() });
  }

  private buildState(): PanelState {
    return {
      config: { ...this.store.config, identity: this.store.templateIdentity },
      effectiveIdentity: this.store.identity,
      workspaceIdentity: this.store.workspaceIdentity,
      workspaceLabel: this.store.workspaceLabel(),
      status: this.deps.getStatus(),
      messages: this.store.listMessages(50),
      onlineIds: this.deps.getOnlineIds(),
      identityMissing: this.store.missingIdentityFields(),
      rooms: this.store.getRooms(),
      admin: { tokenSet: this.store.hasAdminToken(), ...this.store.getAdminState() },
      relayInfo: this.store.getRelayInfo(),
      extensionVersion: this.store.extensionVersion,
    };
  }

  private async handleMessage(msg: unknown): Promise<void> {
    const m = msg as {
      type?: string;
      config?: AppConfig;
      token?: string;
      adminToken?: string;
      peerId?: string;
      enabled?: boolean;
      identity?: ColleagueProfile;
      op?: string;
      payload?: Record<string, unknown>;
    };
    switch (m.type) {
      case 'ready':
        this.postState();
        break;
      case 'save': {
        log(`[panel] 保存配置：同事数=${m.config?.colleagues?.length ?? '?'}`);
        if (m.config) {
          // 对方档案（role/scope）以 store 中已同步的值为准，避免界面旧快照把它覆盖成空
          const merged: AppConfig = {
            ...m.config,
            colleagues: (m.config.colleagues as ColleagueConfig[]).map(raw => {
              const current = this.store.config.colleagues.find(x => x.id === raw.id);
              return {
                id: raw.id,
                role: current?.role ?? raw.role,
                scope: current?.scope ?? raw.scope,
                relayPeerId: raw.relayPeerId ?? current?.relayPeerId ?? '',
                enabled: raw.enabled !== false,
              };
            }),
          };
          await this.store.updateConfig(merged);
        }
        await this.store.setWorkspaceIdentity(m.identity ?? {});
        if (typeof m.token === 'string' && m.token.trim().length > 0) {
          await this.store.setToken(m.token.trim());
        }
        if (typeof m.adminToken === 'string' && m.adminToken.trim().length > 0) {
          await this.store.setAdminToken(m.adminToken.trim());
          log('[panel] 已保存中继管理令牌');
        }
        await this.deps.restart();
        this.postState(true);
        void vscode.window.showInformationMessage(
          `Copilot2Copilot：已保存本工作区档案（id=${this.store.identity.id || '未填'}）并应用`,
        );
        break;
      }
      case 'roomOp': {
        const op = String(m.op ?? '');
        log(`[panel] 房间操作 ${op}`);
        const result = await this.deps.control('room', op, m.payload);
        const data = result.env?.payload as { rooms?: RoomSummary[] } | undefined;
        if (result.ok && Array.isArray(data?.rooms)) {
          this.store.setRooms(data.rooms);
        }
        const roomName = String((m.payload as { name?: string } | undefined)?.name ?? '');
        const memberId = String((m.payload as { memberId?: string } | undefined)?.memberId ?? '');
        if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '房间操作失败'}`);
        } else {
          if (op === 'create') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已创建房间「${roomName}」，把房间名与密码告诉同事，对方加入后即可互相看到`);
          } else if (op === 'join') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已加入房间${roomName ? `「${roomName}」` : ''}，同房间成员会出现在列表中`);
          } else if (op === 'kick') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已把 ${memberId} 移出房间（已进入「管理 → 房间移出名单」，可在那里解除）`);
          } else if (op === 'unblock') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已解除 ${memberId} 的房间移出限制，对方可凭密码重新加入`);
          }
          // 房间成员变化会影响管理页的设备行与房间移出名单：一并刷新
          if (this.store.hasAdminToken()) {
            await this.deps.refreshAdmin();
          }
        }
        this.postState();
        break;
      }
      case 'refreshRooms': {
        const result = await this.deps.control('room', 'list');
        const data = result.env?.payload as { rooms?: RoomSummary[] } | undefined;
        if (result.ok && Array.isArray(data?.rooms)) {
          this.store.setRooms(data.rooms);
        } else if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '刷新房间列表失败'}`);
        }
        this.postState();
        break;
      }
      case 'adminOp': {
        const op = String(m.op ?? '');
        log(`[panel] 管理操作 ${op}`);
        const result = await this.deps.control('admin', op, m.payload);
        if (!result.ok) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：${result.error ?? '管理操作失败'}`);
        } else {
          log(`[panel] 管理操作 ${op} 已生效`);
          const target = String((m.payload as { target?: string } | undefined)?.target ?? '');
          if (op === 'ban') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已封禁 ${target}（它已断开且无法接入），可在「管理 → 封禁名单」解除`);
          } else if (op === 'unban') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已解除 ${target} 的封禁，对方会在 60 秒内自动重连`);
          } else if (op === 'kick') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已把 ${target} 移出中继（60 秒后它会自动重试）`);
          }
        }
        await this.deps.refreshAdmin();
        this.postState();
        break;
      }
      case 'refreshAdmin': {
        await this.deps.refreshAdmin();
        this.postState();
        break;
      }
      case 'clearHistory':
        await this.store.clearMessages();
        break;
      case 'openFilesDir': {
        const dir = this.store.filesDir();
        log(`[panel] 打开文件收件目录 ${dir}`);
        try {
          // openExternal 被系统拒绝时返回 false（不抛异常），两种失败都要给出路径提示
          if (!(await vscode.env.openExternal(vscode.Uri.file(dir)))) {
            throw new Error('系统未接受打开请求');
          }
        } catch {
          void vscode.window.showWarningMessage(`Copilot2Copilot：无法自动打开收件目录，路径为 ${dir}`);
        }
        break;
      }
      case 'resetLoopGuard': {
        this.store.resetLoopGuard();
        log('[panel] 已重置熔断计数');
        void vscode.window.showInformationMessage('Copilot2Copilot：熔断计数已重置，可以与同事继续通信。');
        this.postState();
        break;
      }
      case 'toggleColleague': {
        if (typeof m.peerId === 'string' && m.peerId) {
          await this.store.setColleagueEnabled(m.peerId, m.enabled === true);
          log(`[panel] ${m.enabled === true ? '启用' : '停用'}沟通方 ${m.peerId}`);
          this.postState();
        }
        break;
      }
      case 'saveTemplate': {
        await this.store.saveTemplateFromCurrent();
        log('[panel] 已把当前档案的角色/负责内容存为模板');
        void vscode.window.showInformationMessage('Copilot2Copilot：已把当前角色与负责内容存为模板，供新工作区预填（不含 id）。');
        this.postState();
        break;
      }
      case 'uiError':
        log(`[panel] 界面脚本错误：${(m as { message?: string }).message ?? '(未知)'}`);
        break;
      case 'uiHint':
        // 界面侧的输入校验提示（如房间名为空）：转成 VS Code 弹窗，避免"点了没反应"
        log(`[panel] 界面提示：${(m as { message?: string }).message ?? ''}`);
        void vscode.window.showWarningMessage(`Copilot2Copilot：${(m as { message?: string }).message ?? ''}`);
        break;
      case 'showLogs':
        showLogs();
        break;
      default:
        break;
    }
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Copilot2Copilot</title>
</head>
<body>
<header>
  <div class="status-row">
    <span id="status-dot" class="dot"></span>
    <span id="status-text">加载中…</span>
  </div>
  <div class="actions">
    <button id="btn-logs">查看日志</button>
    <button id="btn-reload" title="放弃未保存的修改，恢复为当前生效配置">重新载入</button>
    <button id="btn-save" class="primary">保存并应用</button>
  </div>
</header>
<nav id="tabs">
  <button data-tab="conn" class="active">连接</button>
  <button data-tab="peers">Copilot 列表</button>
  <button data-tab="rooms">房间</button>
  <button data-tab="admin">管理</button>
  <button data-tab="inbox">收件箱</button>
  <button data-tab="behavior">行为</button>
</nav>
<main>
  <section id="tab-conn">
    <h2>中继服务器</h2>
    <div id="relay-fields">
      <label>中继地址 <input id="relay-url" placeholder="wss://relay.example.com"></label>
      <label>中继令牌（可选） <input id="token" type="password" placeholder="留空表示保持不变"></label>
      <label>中继管理令牌（可选） <input id="admin-token" type="password" placeholder="留空表示保持不变"></label>
      <p class="hint">令牌保存在系统密钥库（SecretStorage）。管理令牌用于获得中继管理权限（查看/踢出/封禁在线设备，并对所有房间拥有所有者权限）；中继未配置管理令牌时该功能不可用。</p>
      <p class="hint" id="relay-version"></p>
      <p class="hint">中继 id 即下面的「档案 id」，本机每个窗口各用各的档案，因此不会互相顶下线。</p>
    </div>
    <h2>本工作区档案（对方在其 Copilot 中可见）</h2>
    <p class="hint">当前工作区：<code id="ws-label"></code>。档案按工作区保存，本机多个窗口因此可以各有各的 id。</p>
    <div id="identity-warning" class="banner" hidden></div>
    <div class="grid">
      <label>id <input id="id-id" placeholder="唯一标识，双方约定一致"></label>
      <label>角色 <input id="id-role" placeholder="如：后端工程师"></label>
      <label>负责内容 <input id="id-scope" placeholder="如：订单服务、支付网关"></label>
    </div>
    <p class="hint" id="identity-hint"></p>
    <p class="hint">请把上面的 id 告诉同事——双方的档案会经中继互相同步，无需手工登记。</p>
  </section>
  <section id="tab-peers" hidden>
    <div class="section-head">
      <h2>Copilot 列表</h2>
    </div>
    <p class="hint">列表由中继自动维护：只显示在线的 Copilot（对方下线后条目会自动消失），角色与负责内容由中继下发；不需要手工添加或编辑。</p>
    <div id="peers"></div>
  </section>
  <section id="tab-rooms" hidden>
    <div class="section-head">
      <h2>房间</h2>
      <button id="btn-refresh-rooms">刷新</button>
    </div>
    <p class="hint">房间决定「谁能看到谁」：设备只能看到、并只能与同房间成员通信；<strong>未加入任何房间时与所有人互相不可见</strong>。创建房间后把密码告诉同事，对方加入即可互通。房间由创建者（所有者）管理：改密码、移出成员（移出后无法再凭密码加入，需所有者或管理员解除）、解散。</p>
    <div id="room-create">
      <label>新房间名 <input id="room-name" placeholder="如：订单服务组" maxlength="32"></label>
      <label>加入密码（可选） <input id="room-password" type="password" placeholder="留空表示无需密码"></label>
      <button id="btn-create-room" class="primary">创建房间</button>
    </div>
    <div id="rooms"></div>
  </section>
  <section id="tab-admin" hidden>
    <div class="section-head">
      <h2>管理</h2>
      <button id="btn-refresh-admin">刷新</button>
    </div>
    <p class="hint" id="admin-hint"></p>
    <h2>在线设备</h2>
    <p class="hint">每行列出该设备所在的房间，点房间后面的「移出」可把它从<strong>那个房间</strong>踢出（两步确认：再点一次「确认移出」）；「踢出中继 / 封禁」则是设备级操作。</p>
    <div id="admin-devices"></div>
    <h2>房间移出名单</h2>
    <p class="hint">被移出房间的成员无法再凭密码加入，只能在这里由管理员（或房间所有者）解除；这与下面的「中继封禁」是两回事。</p>
    <div id="admin-room-blocks"></div>
    <h2>中继封禁名单</h2>
    <p class="hint">封禁的设备会被断开且无法接入，因此会从上面的在线列表消失，但仍列在这里；点「解除封禁」后对方会在 60 秒内自动重连。房间成员的封禁状态也会在该房间的成员列表里标注。</p>
    <div id="admin-bans"></div>
  </section>
  <section id="tab-inbox" hidden>
    <div class="section-head"><h2>收件箱</h2><button id="btn-open-files">打开收件目录</button></div>
    <p class="hint">同事发来的文件保存在扩展私有目录（不进入工作区），点上面的按钮可在文件管理器中打开。</p>
    <div id="inbox"></div>
  </section>
  <section id="tab-behavior" hidden>
    <h2>收发行为</h2>
    <p class="hint">收到同事的消息或回复时，会直接触发本机 Copilot 对话进行处理（不再弹出通知）。</p>
    <label>等待回复默认超时（秒） <input id="wait-timeout" type="number" min="5" max="180"></label>
    <label>历史消息保留条数 <input id="history-limit" type="number" min="20" max="1000"></label>
    <div class="section-head"><h2>维护</h2></div>
    <button id="btn-save-template">把当前角色/负责内容存为模板</button>
    <p class="hint">模板用于给以后新开的工作区预填角色与负责内容（<strong>不含 id</strong>，避免新窗口与现有窗口撞名）。</p>
    <button id="btn-reset-loop">重置熔断计数</button>
    <p class="hint">与同一位同事在 ${LOOP_WINDOW_MS / 60000} 分钟内的往来达到 ${LOOP_MESSAGE_LIMIT} 条时会自动中止（防止两端无限对话）。点此立即重新计数；窗口随时间滑动，稍后也会自动恢复。</p>
    <button id="btn-clear-history" class="danger">清空消息历史</button>
  </section>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
