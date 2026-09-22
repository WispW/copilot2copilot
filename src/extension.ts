import * as vscode from 'vscode';
import { FileHub } from './files';
import { Injector } from './injector';
import { disposeLogger, log, logError, showLogs } from './logger';
import { ConsolePanel } from './panel';
import { AdminDevice } from './protocol';
import { StatusBar } from './statusBar';
import { Store } from './store';
import { registerTools, ReplyWaiter, ToolDeps } from './tools';
import { RelayTransport } from './transport/relay';
import { Transport, TransportStatus } from './transport/types';

let currentTransport: Transport | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log('扩展已激活');
  const store = new Store(context);
  const waiters = new ReplyWaiter();
  const injector = new Injector(store, waiters, context.extensionUri);
  const fileHub = new FileHub(store, () => currentTransport, arrival => injector.injectFile(arrival));
  fileHub.cleanupStaleTransferFiles();
  let status: TransportStatus = { state: 'stopped', detail: '未启动' };
  let transportDisposables: vscode.Disposable[] = [];

  /**
   * 在线同事 id：状态栏与列表共用的实时数据源。
   * 只排除"指向自己"的条目；**不能**在这里排除已停用条目——列表用它判断"是否在线"，
   * 一旦剔除，用户点「停用」会让整行消失且无法再启用（停用的对端本身仍是在线的）。
   */
  const getOnlineIds = (): string[] =>
    store.config.colleagues
      .filter(c => c.id !== store.config.identity.id && c.relayPeerId !== store.config.identity.id)
      .filter(c => currentTransport?.isOnline(c.id))
      .map(c => c.id);

  const statusBar = new StatusBar(store, getOnlineIds);
  context.subscriptions.push(statusBar);

  /** 刷新管理员视角的在线设备与封禁名单（管理令牌未通过时清空并标记未验证） */
  const refreshAdmin = async (): Promise<void> => {
    const transport = currentTransport;
    if (!transport) {
      store.setAdminState([], [], false);
      return;
    }
    const result = await transport.controlOp('admin', 'list');
    if (!result.ok || !result.env) {
      store.setAdminState([], [], false);
      return;
    }
    const data = (result.env.payload ?? {}) as { devices?: AdminDevice[]; bans?: string[] };
    store.setAdminState(data.devices ?? [], data.bans ?? [], true);
  };

  const restart = async (): Promise<void> => {
    log('重启通道：中继模式');
    transportDisposables.forEach(d => d.dispose());
    transportDisposables = [];
    await currentTransport?.stop();

    // 复用同一个传输实例：断开期间入队的未发消息保存在它的队列里，重连后补发；
    // 每次重建实例会让队列连同旧实例一起被丢弃（消息静默消失）
    const transport: Transport = currentTransport instanceof RelayTransport
      ? currentTransport
      : new RelayTransport(store);
    currentTransport = transport;
    transportDisposables.push(
      transport.onMessage(env => {
        // 文件通道由 FileHub 接管，其余信封交给消息注入
        if (!fileHub.handle(env)) {
          void injector.handleIncoming(env);
        }
      }),
      transport.onRejected(env => {
        // 中继拒收回执（如与目标没有共同房间）：立刻终结等待中的工具调用，避免空等到超时
        log(`中继拒收回执：${env.error ?? ''}（原消息 ${env.refId ?? ''}）`);
        const notified = Boolean(env.refId) && waiters.fail(env.refId as string, env.error ?? '被中继拒绝');
        if (!notified) {
          void vscode.window.showWarningMessage(`Copilot2Copilot：消息未送达——${env.error ?? '被中继拒绝'}`);
        }
      }),
      transport.onStatus(s => {
        log(`状态：${s.state} · ${s.detail}`);
        status = s;
        statusBar.update(s);
        if (s.state === 'online') {
          void refreshAdmin();
        }
        panel.postState();
      }),
    );
    try {
      await transport.start();
    } catch (err) {
      logError('通道启动失败', err);
    }
  };

  /** 手动断开：停止通道并停在「已断开」，之后不再自动重连（点界面上的「连接」恢复） */
  const disconnect = async (): Promise<void> => {
    log('手动断开中继通道');
    transportDisposables.forEach(d => d.dispose());
    transportDisposables = [];
    await currentTransport?.stop();
    currentTransport = undefined;
    status = { state: 'stopped', detail: '已手动断开（点「连接」恢复）' };
    statusBar.update(status);
    panel.postState();
  };

  const panel = new ConsolePanel(context, store, {
    getStatus: () => status,
    getOnlineIds,
    restart,
    disconnect,
    control: (kind, op, payload) => currentTransport
      ? currentTransport.controlOp(kind, op, payload)
      : Promise.resolve({ ok: false, error: '通信通道未启动，请点击「保存并应用」后重试' }),
    refreshAdmin,
  });

  const deps: ToolDeps = { store, waiters, getTransport: () => currentTransport, fileHub };
  registerTools(context, deps);

  context.subscriptions.push(
    vscode.commands.registerCommand('talk2copilot.openConsole', () => panel.show()),
    vscode.commands.registerCommand('talk2copilot.showLogs', () => showLogs()),
    vscode.commands.registerCommand('talk2copilot.testConnection', async () => {
      await restart();
      void vscode.window.showInformationMessage(`Copilot2Copilot：${status.detail}`);
    }),
    vscode.commands.registerCommand('talk2copilot.disconnect', async () => {
      await disconnect();
      void vscode.window.showInformationMessage('Copilot2Copilot：已断开中继连接（可在配置界面点「连接」恢复）。');
    }),
    store.onDidChange(() => statusBar.update(status)),
    new vscode.Disposable(() => {
      void currentTransport?.stop();
      currentTransport = undefined;
    }),
  );

  // 自动连接只做一次：失败即停在离线态，由用户点「连接」重试（不做任何后台重连）
  if (store.config.relay.autoConnect === false) {
    log('配置为启动时不自动连接，等待用户手动连接');
    status = { state: 'stopped', detail: '未自动连接（点「连接」开始）' };
    statusBar.update(status);
  } else {
    await restart();
    statusBar.update(status);
  }

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
