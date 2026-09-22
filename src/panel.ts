import * as vscode from 'vscode';
import { log, showLogs } from './logger';
import { PanelState } from './panelTypes';
import { ColleagueProfile, RoomSummary } from './protocol';
import { AppConfig, ColleagueConfig, LOOP_MESSAGE_LIMIT, LOOP_WINDOW_MS, Store } from './store';
import { ControlResult, TransportStatus } from './transport/types';

interface PanelDeps {
  getStatus(): TransportStatus;
  getOnlineIds(): string[];
  /** 重新连接：保存并应用，以及界面上的「连接 / 重试连接」都走这里 */
  restart(): Promise<void>;
  /** 手动断开：停止通道，之后不再自动重连 */
  disconnect(): Promise<void>;
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
      // 只放开实际被加载的两个目录：脚本在 dist/（构建产物）、样式在 media/
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    });
    log('[panel] 打开配置页面');
    this.attach(panel);
    this.postState();
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview, this.context.extensionUri);
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
      loopGuard: { windowMs: LOOP_WINDOW_MS, limit: LOOP_MESSAGE_LIMIT },
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
      case 'connect':
        log('[panel] 界面请求连接中继');
        await this.deps.restart();
        this.postState();
        break;
      case 'disconnect':
        log('[panel] 界面请求断开中继');
        await this.deps.disconnect();
        this.postState();
        break;
      case 'save': {
        log(`[panel] 保存配置：同事数=${m.config?.colleagues?.length ?? '?'}`);
        if (m.config) {
          // 以 store 现有列表为基：快照里没有的条目（保存瞬间刚被中继发现的同事）必须保留，
          // 否则这次保存会把它从配置里删掉；role/scope 一律以 store 的同步值为准，
          // 避免界面旧快照把它们覆盖成空
          const byId = new Map((m.config.colleagues as ColleagueConfig[]).map(raw => [raw.id, raw]));
          const merged: AppConfig = {
            ...m.config,
            colleagues: this.store.config.colleagues.map(current => {
              const raw = byId.get(current.id);
              if (!raw) {
                return current;
              }
              return {
                id: current.id,
                role: current.role,
                scope: current.scope,
                relayPeerId: raw.relayPeerId ?? current.relayPeerId,
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
            void vscode.window.showInformationMessage(`Copilot2Copilot：已解除 ${target} 的封禁，对方可点「重试连接」重新接入（不会自动重连）`);
          } else if (op === 'kick') {
            void vscode.window.showInformationMessage(`Copilot2Copilot：已把 ${target} 移出中继，对方需手动点「重试连接」才能恢复（不会自动重连）`);
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

  private renderHtml(webview: vscode.Webview, root: vscode.Uri): string {
    // 界面脚本是构建产物（src/webview/ → dist/webview.js），样式仍是手写文件
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'main.css'));
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
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
