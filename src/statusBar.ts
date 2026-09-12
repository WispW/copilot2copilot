import * as vscode from 'vscode';
import { Store } from './store';
import { TransportStatus } from './transport/types';

/** 左下角状态栏入口：显示连接状态与未读角标，点击打开主界面 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly store: Store,
    private readonly getOnlineIds: () => string[],
  ) {
    this.item = vscode.window.createStatusBarItem('talk2copilot.status', vscode.StatusBarAlignment.Left, 1000);
    this.item.name = 'Copilot Bridge';
    this.item.command = 'talk2copilot.openConsole';
    this.item.show();
    this.update({ state: 'stopped', detail: '未启动' });
  }

  update(status: TransportStatus): void {
    const unread = this.store.listMessages(200).filter(m => m.direction === 'in' && !m.done).length;
    const badge = unread > 0 ? ` ${unread}` : '';
    const missing = this.store.missingIdentityFields();
    const total = this.store.config.colleagues.length;
    const online = this.getOnlineIds().length;

    if (missing.length > 0) {
      this.item.text = `$(warning) Copilot Bridge${badge}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
      switch (status.state) {
        case 'online':
          this.item.text = `$(comment-discussion) Copilot Bridge${badge}`;
          break;
        case 'connecting':
          this.item.text = '$(sync~spin) Copilot Bridge';
          break;
        case 'offline':
          this.item.text = `$(warning) Copilot Bridge${badge}`;
          break;
        default:
          this.item.text = '$(circle-slash) Copilot Bridge';
      }
    }

    const lines = [
      `${status.detail}${total > 0 ? ` · ${online}/${total} 同事在线` : ''}`,
      `模式：${this.store.config.mode === 'relay' ? '中继' : '局域网'}`,
    ];
    if (unread > 0) {
      lines.push(`未回复消息：${unread} 条`);
    }
    if (missing.length > 0) {
      lines.push(`注意：请先完善“我的档案”（缺少：${missing.join('、')}），未完成前无法与同事通信`);
    }
    lines.push('点击打开配置界面');
    this.item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
  }

  dispose(): void {
    this.item.dispose();
  }
}
