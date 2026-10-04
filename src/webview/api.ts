import type {
  PanelAdminMemoryDetailMessage,
  PanelAdminMemoryMessage,
  PanelMemoryMessage,
  PanelStateMessage,
  WebviewMessage,
} from '../panelTypes';

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

/** 订阅扩展推送的记忆数据（面板请求 / 增删改后刷新） */
export function onMemoryState(handler: (msg: PanelMemoryMessage) => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data as PanelMemoryMessage | undefined;
    if (data && data.type === 'memoryState') {
      handler(data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** 订阅管理员记忆列表（数据库视图）推送 */
export function onAdminMemoryState(handler: (msg: PanelAdminMemoryMessage) => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data as PanelAdminMemoryMessage | undefined;
    if (data && data.type === 'adminMemoryState') {
      handler(data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** 订阅管理员记忆详情推送（entry 缺省表示关闭详情） */
export function onAdminMemoryDetail(handler: (msg: PanelAdminMemoryDetailMessage) => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data as PanelAdminMemoryDetailMessage | undefined;
    if (data && data.type === 'adminMemoryDetail') {
      handler(data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
