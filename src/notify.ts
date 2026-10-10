import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { log } from './logger';

/**
 * 系统级通知：写任务开始 / 结束时提醒本机用户（不打断工作）。
 * Linux 走 notify-send、macOS 走 osascript；不可用或平台不支持时退回 VS Code 内通知。
 * 这里只用系统自带命令，不引第三方依赖（扩展打包用 --no-dependencies）。
 */
export function notify(title: string, body: string, enabled = true): void {
  if (!enabled) {
    return;
  }
  void systemNotify(title, body).catch(err => {
    log(`[notify] 系统通知不可用（${String(err)}），退回 VS Code 内通知`);
    void vscode.window.showInformationMessage(`Copilot2Copilot · ${title}：${body}`);
  });
}

function systemNotify(title: string, body: string): Promise<void> {
  if (process.platform === 'linux') {
    return run('notify-send', ['-a', 'Copilot2Copilot', '-u', 'normal', title, body]);
  }
  if (process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    return run('osascript', ['-e', script]);
  }
  return Promise.reject(new Error(`当前平台不支持系统通知：${process.platform}`));
}

/** 启动一次即忘的命令（只关心能否启动，不等待退出码） */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
