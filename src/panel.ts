import * as os from 'os';
import * as vscode from 'vscode';
import { log, showLogs } from './logger';
import { ColleagueProfile } from './protocol';
import { AppConfig, HistoryItem, Store, WorkspaceIdentity } from './store';
import { TransportStatus } from './transport/types';

interface PanelState {
  /** 全局配置；其中 identity 为“默认档案”，供编辑默认值时使用 */
  config: AppConfig;
  /** 当前生效档案（已合并工作区覆盖） */
  effectiveIdentity: ColleagueProfile;
  /** 当前工作区的独立档案（未设置时为空对象） */
  workspaceIdentity: WorkspaceIdentity;
  /** 当前工作区名（无工作区时为空串） */
  workspaceLabel: string;
  status: TransportStatus;
  messages: HistoryItem[];
  onlineIds: string[];
  myAddresses: string[];
  identityMissing: string[];
}

interface PanelDeps {
  getStatus(): TransportStatus;
  getOnlineIds(): string[];
  restart(): Promise<void>;
  connectPeer(peerId: string): void;
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
    const panel = vscode.window.createWebviewPanel('talk2copilot.console', 'Copilot Bridge', vscode.ViewColumn.Active, {
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
      config: { ...this.store.config, identity: this.store.defaultIdentity },
      effectiveIdentity: this.store.identity,
      workspaceIdentity: this.store.workspaceIdentity,
      workspaceLabel: this.store.workspaceLabel(),
      status: this.deps.getStatus(),
      messages: this.store.listMessages(50),
      onlineIds: this.deps.getOnlineIds(),
      myAddresses: this.myAddresses(),
      identityMissing: this.store.missingIdentityFields(),
    };
  }

  private myAddresses(): string[] {
    const port = this.store.config.lan.listenPort;
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

  private async handleMessage(msg: unknown): Promise<void> {
    const m = msg as {
      type?: string;
      config?: AppConfig;
      token?: string;
      peerId?: string;
      identity?: ColleagueProfile;
      workspaceOverride?: boolean;
    };
    switch (m.type) {
      case 'ready':
        this.postState();
        break;
      case 'save': {
        log(`[panel] 保存配置：模式=${m.config?.mode ?? '(未提供)'} 同事数=${m.config?.colleagues?.length ?? '?'} 工作区独立档案=${m.workspaceOverride ? '是' : '否'}`);
        if (m.config) {
          // 对方档案（role/scope）以 store 中已同步的值为准，避免界面旧快照把它覆盖成空
          const merged: AppConfig = {
            ...m.config,
            colleagues: m.config.colleagues.map(c => {
              const current = this.store.config.colleagues.find(x => x.id === c.id);
              return current
                ? { ...c, role: current.role, scope: current.scope, lanAddr: c.lanAddr || current.lanAddr }
                : c;
            }),
          };
          await this.store.updateConfig(merged);
        }
        await this.store.setWorkspaceIdentity(m.workspaceOverride ? m.identity : undefined);
        if (typeof m.token === 'string' && m.token.trim().length > 0) {
          await this.store.setToken(m.token.trim());
        }
        await this.deps.restart();
        this.postState(true);
        void vscode.window.showInformationMessage(
          m.workspaceOverride
            ? 'Copilot Bridge：已保存为该工作区的独立档案并应用'
            : 'Copilot Bridge 配置已保存并应用',
        );
        break;
      }
      case 'restart': {
        log('[panel] 测试连接（重启通道）');
        await this.deps.restart();
        this.postState();
        break;
      }
      case 'clearHistory':
        await this.store.clearMessages();
        break;
      case 'uiError':
        log(`[panel] 界面脚本错误：${(m as { message?: string }).message ?? '(未知)'}`);
        break;
      case 'showLogs':
        showLogs();
        break;
      case 'connectPeer':
        if (typeof m.peerId === 'string' && m.peerId) {
          const peerId = m.peerId;
          log(`[panel] 手动连接同事 ${peerId}`);
          this.deps.connectPeer(peerId);
          this.postState();
          setTimeout(() => {
            if (!this.deps.getOnlineIds().includes(peerId)) {
              void vscode.window.showWarningMessage(
                `Copilot Bridge：暂未连接到 ${peerId}。请检查对方是否已启动、地址是否正确、防火墙是否放行。`,
              );
            }
          }, 6000);
        }
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
<title>Copilot Bridge</title>
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
    <button id="btn-test">测试连接</button>
    <button id="btn-save" class="primary">保存并应用</button>
  </div>
</header>
<nav id="tabs">
  <button data-tab="conn" class="active">连接</button>
  <button data-tab="peers">沟通方</button>
  <button data-tab="inbox">收件箱</button>
  <button data-tab="behavior">行为</button>
</nav>
<main>
  <section id="tab-conn">
    <h2>通信模式</h2>
    <div class="mode-row">
      <label><input type="radio" name="mode" value="lan"> 局域网直连</label>
      <label><input type="radio" name="mode" value="relay"> 中继服务器</label>
    </div>
    <div id="lan-fields">
      <label>监听端口 <input id="lan-port" type="number" min="1" max="65535"></label>
      <p class="hint">本机地址（可告诉同事填到他们的“局域网地址”里）：<code id="my-addrs"></code></p>
      <p class="hint">局域网模式需要系统防火墙放行该端口，且双方处于同一网段。</p>
    </div>
    <div id="relay-fields">
      <label>中继地址 <input id="relay-url" placeholder="wss://relay.example.com"></label>
      <label>我的中继 id <input id="relay-myid"></label>
      <label>中继令牌（可选） <input id="token" type="password" placeholder="留空表示保持不变"></label>
      <p class="hint">令牌保存在系统密钥库（SecretStorage）。局域网模式面向可信内网，只校验对方 id，不校验令牌。</p>
    </div>
    <h2>我的档案（对方在其 Copilot 中可见）</h2>
    <p class="hint">当前工作区：<code id="ws-label"></code></p>
    <div id="identity-warning" class="banner" hidden></div>
    <label class="row"><input id="ws-override" type="checkbox"> 本工作区使用独立档案（不勾选则编辑“默认档案”，对所有工作区生效）</label>
    <div class="grid">
      <label>id <input id="id-id" placeholder="唯一标识，双方约定一致"></label>
      <label>角色 <input id="id-role" placeholder="如：后端工程师"></label>
      <label>负责内容 <input id="id-scope" placeholder="如：订单服务、支付网关"></label>
    </div>
    <p class="hint" id="identity-hint"></p>
  </section>
  <section id="tab-peers" hidden>
    <div class="section-head">
      <h2>沟通方</h2>
      <button id="btn-add-peer">添加</button>
    </div>
    <p class="hint">只需填写对方 id 与地址；对方的角色与负责内容会在连接后自动同步，档案同步完成前无法收发消息。</p>
    <div id="peers"></div>
  </section>
  <section id="tab-inbox" hidden>
    <div class="section-head"><h2>收件箱</h2></div>
    <div id="inbox"></div>
  </section>
  <section id="tab-behavior" hidden>
    <h2>收发行为</h2>
    <p class="hint">收到同事的消息或回复时，会直接触发本机 Copilot 对话进行处理（不再弹出通知）。</p>
    <label>等待回复默认超时（秒） <input id="wait-timeout" type="number" min="5" max="180"></label>
    <label>历史消息保留条数 <input id="history-limit" type="number" min="20" max="1000"></label>
    <div class="section-head"><h2>维护</h2></div>
    <button id="btn-clear-history" class="danger">清空消息历史</button>
  </section>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
