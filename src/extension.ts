import * as vscode from 'vscode';
import { Injector } from './injector';
import { disposeLogger, log, logError, showLogs } from './logger';
import { ConsolePanel } from './panel';
import { StatusBar } from './statusBar';
import { Store } from './store';
import { registerTools, ReplyWaiter, ToolDeps } from './tools';
import { LanTransport } from './transport/lan';
import { RelayTransport } from './transport/relay';
import { Transport, TransportStatus } from './transport/types';

let currentTransport: Transport | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log('扩展已激活');
  const store = new Store(context);
  const waiters = new ReplyWaiter();
  const injector = new Injector(store, waiters, context.extensionUri);
  let status: TransportStatus = { state: 'stopped', detail: '未启动' };
  let transportDisposables: vscode.Disposable[] = [];

  /** 在线同事 id：状态栏与面板共用的实时数据源 */
  const getOnlineIds = (): string[] =>
    store.config.colleagues.filter(c => currentTransport?.isOnline(c.id)).map(c => c.id);

  const statusBar = new StatusBar(store, getOnlineIds);
  context.subscriptions.push(statusBar);

  const restart = async (): Promise<void> => {
    log(`重启通道：模式=${store.config.mode}`);
    transportDisposables.forEach(d => d.dispose());
    transportDisposables = [];
    await currentTransport?.stop();
    currentTransport = undefined;

    const transport: Transport = store.config.mode === 'relay' ? new RelayTransport(store) : new LanTransport(store);
    currentTransport = transport;
    transportDisposables.push(
      transport.onMessage(env => void injector.handleIncoming(env)),
      transport.onStatus(s => {
        log(`状态：${s.state} · ${s.detail}`);
        status = s;
        statusBar.update(s);
        panel.postState();
      }),
    );
    try {
      await transport.start();
    } catch (err) {
      logError('通道启动失败', err);
    }
  };

  const panel = new ConsolePanel(context, store, {
    getStatus: () => status,
    getOnlineIds,
    restart,
    connectPeer: peerId => currentTransport?.connectPeer(peerId),
  });

  const deps: ToolDeps = { store, waiters, getTransport: () => currentTransport };
  registerTools(context, deps);

  context.subscriptions.push(
    vscode.commands.registerCommand('talk2copilot.openConsole', () => panel.show()),
    vscode.commands.registerCommand('talk2copilot.showLogs', () => showLogs()),
    vscode.commands.registerCommand('talk2copilot.testConnection', async () => {
      await restart();
      void vscode.window.showInformationMessage(`Copilot Bridge：${status.detail}`);
    }),
    store.onDidChange(() => statusBar.update(status)),
    new vscode.Disposable(() => {
      void currentTransport?.stop();
      currentTransport = undefined;
    }),
  );

  await restart();
  statusBar.update(status);

  if (!context.globalState.get('talk2copilot.consoleShown')) {
    await context.globalState.update('talk2copilot.consoleShown', true);
    panel.show();
  }
}

export function deactivate(): void {
  log('扩展已停用，向沟通方发出下线通告');
  currentTransport?.sendOfflineNotice();
  void currentTransport?.stop();
  currentTransport = undefined;
  disposeLogger();
}
