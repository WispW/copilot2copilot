import type { PanelStateMessage, WebviewMessage } from '../panelTypes';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** webview 与扩展之间的唯一通道 */
export const vscode = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

/** 订阅扩展推送的状态快照；返回取消订阅函数 */
export function onPanelState(handler: (msg: PanelStateMessage) => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data as PanelStateMessage | undefined;
    if (data && data.type === 'state') {
      handler(data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
