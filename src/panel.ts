import * as os from 'os';
import * as vscode from 'vscode';
import { log, showLogs } from './logger';
import { AppConfig, HistoryItem, Store } from './store';
import { TransportStatus } from './transport/types';

interface PanelState {
  config: AppConfig;
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly deps: PanelDeps,
  ) {
    this.store.onDidChange(() => this.postState());
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      this.postState();
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('talk2copilot.console', 'Talk2Copilot', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview, mediaRoot);
    panel.webview.onDidReceiveMessage(msg => void this.handleMessage(msg), undefined, this.context.subscriptions);
    panel.onDidDispose(() => {
      this.panel = undefined;
    }, undefined, this.context.subscriptions);
  }

  postState(resetDraft = false): void {
    void this.panel?.webview.postMessage({ type: 'state', resetDraft, state: this.buildState() });
  }

  private buildState(): PanelState {
    return {
      config: this.store.config,
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
    const m = msg as { type?: string; config?: AppConfig; token?: string; peerId?: string };
    switch (m.type) {
      case 'ready':
        this.postState();
        break;
      case 'save': {
        log(`[panel] 保存配置：模式=${m.config?.mode ?? '(未提供)'} 同事数=${m.config?.colleagues?.length ?? '?'}`);
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
        if (typeof m.token === 'string' && m.token.trim().length > 0) {
          await this.store.setToken(m.token.trim());
        }
        await this.deps.restart();
        this.postState(true);
        void vscode.window.showInformationMessage('Talk2Copilot 配置已保存并应用');
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
                `Talk2Copilot：暂未连接到 ${peerId}。请检查对方是否已启动、地址是否正确、防火墙是否放行。`,
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
<title>Talk2Copilot</title>
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
    <div id="identity-warning" class="banner" hidden></div>
    <div class="grid">
      <label>id <input id="id-id" placeholder="唯一标识，双方约定一致"></label>
      <label>角色 <input id="id-role" placeholder="如：后端工程师"></label>
      <label>负责内容 <input id="id-scope" placeholder="如：订单服务、支付网关"></label>
    </div>
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
