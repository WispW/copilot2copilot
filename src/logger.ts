import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** 全局日志：输出到“输出”面板的 Copilot Bridge 通道 */
export function log(message: string): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Copilot Bridge');
  }
  channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  let detail = '';
  if (err instanceof Error) {
    detail = err.message;
  } else if (err !== undefined) {
    detail = String(err);
  }
  log(`ERROR ${message}${detail ? ` :: ${detail}` : ''}`);
}

export function showLogs(): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Copilot Bridge');
  }
  channel.show(true);
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
