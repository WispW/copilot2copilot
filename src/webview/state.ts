import { useEffect, useState } from 'preact/hooks';
import type { AppConfig, WorkspaceIdentity } from '../store';
import type { PanelState } from '../panelTypes';
import { onPanelState } from './api';

/** 界面草稿：只有需要「保存并应用」的字段才进草稿，其余以扩展推送的状态为准 */
export interface Draft {
  relayUrl: string;
  autoConnect: boolean;
  waitTimeoutSec: number;
  historyLimit: number;
}

export interface IdentityDraft {
  id: string;
  role: string;
  scope: string;
}

/** 令牌输入：与草稿一样需要用户点「保存并应用」才会写入，因此一并纳入 dirty 判定 */
export interface TokenDraft {
  token: string;
  adminToken: string;
}

export interface Snapshot {
  /** 扩展推来的状态；收到第一条消息前为 undefined */
  state?: PanelState;
  draft: Draft;
  identity: IdentityDraft;
  tokens: TokenDraft;
  /** 草稿与生效配置是否有差异（决定「保存并应用」是否可用） */
  dirty: boolean;
  /** 每次重新载入草稿自增，供受控输入重建初值 */
  revision: number;
}

const emptyDraft: Draft = { relayUrl: '', autoConnect: true, waitTimeoutSec: 90, historyLimit: 200 };
const emptyIdentity: IdentityDraft = { id: '', role: '', scope: '' };
const emptyTokens: TokenDraft = { token: '', adminToken: '' };

let snapshot: Snapshot = {
  draft: emptyDraft,
  identity: emptyIdentity,
  tokens: emptyTokens,
  dirty: false,
  revision: 0,
};
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { ...snapshot };
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function draftFrom(state: PanelState): { draft: Draft; identity: IdentityDraft } {
  return {
    draft: {
      relayUrl: state.config.relay.url,
      autoConnect: state.config.relay.autoConnect !== false,
      waitTimeoutSec: state.config.behavior.waitTimeoutSec,
      historyLimit: state.config.behavior.historyLimit,
    },
    identity: {
      id: state.workspaceIdentity.id ?? '',
      role: state.workspaceIdentity.role ?? '',
      scope: state.workspaceIdentity.scope ?? '',
    },
  };
}

function computeDirty(next: Snapshot): boolean {
  if (!next.state) {
    return false;
  }
  const { draft, identity } = draftFrom(next.state);
  return (
    JSON.stringify(draft) !== JSON.stringify(next.draft) ||
    JSON.stringify(identity) !== JSON.stringify(next.identity) ||
    next.tokens.token.trim() !== '' ||
    next.tokens.adminToken.trim() !== ''
  );
}

/** 订阅扩展推送的状态；resetDraft 为真时（保存成功）重载草稿 */
export function initState(): void {
  onPanelState(msg => {
    const next: Snapshot = { ...snapshot, state: msg.state };
    if (!snapshot.state || msg.resetDraft) {
      Object.assign(next, draftFrom(msg.state));
      next.tokens = emptyTokens;
      next.revision += 1;
    }
    next.dirty = computeDirty(next);
    snapshot = next;
    emit();
  });
}

export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState(snapshot);
  useEffect(() => subscribe(() => setSnap(snapshot)), []);
  return snap;
}

export function updateDraft(patch: Partial<Draft>): void {
  snapshot = { ...snapshot, draft: { ...snapshot.draft, ...patch } };
  snapshot.dirty = computeDirty(snapshot);
  emit();
}

export function updateIdentity(patch: Partial<IdentityDraft>): void {
  snapshot = { ...snapshot, identity: { ...snapshot.identity, ...patch } };
  snapshot.dirty = computeDirty(snapshot);
  emit();
}

export function updateTokens(patch: Partial<TokenDraft>): void {
  snapshot = { ...snapshot, tokens: { ...snapshot.tokens, ...patch } };
  snapshot.dirty = computeDirty(snapshot);
  emit();
}

/** 放弃草稿，恢复为当前生效配置 */
export function reloadDraft(): void {
  const current = snapshot.state;
  if (!current) {
    return;
  }
  snapshot = {
    ...snapshot,
    ...draftFrom(current),
    tokens: emptyTokens,
    revision: snapshot.revision + 1,
    dirty: false,
  };
  emit();
}

/** 组装「保存并应用」载荷：草稿覆盖对应字段，其余沿用扩展推来的配置 */
export function savePayload(): { config: AppConfig; identity: WorkspaceIdentity; token: string; adminToken: string } | undefined {
  const current = snapshot.state;
  if (!current) {
    return undefined;
  }
  const config: AppConfig = {
    ...current.config,
    relay: { url: snapshot.draft.relayUrl.trim(), autoConnect: snapshot.draft.autoConnect },
    behavior: {
      waitTimeoutSec: snapshot.draft.waitTimeoutSec,
      historyLimit: snapshot.draft.historyLimit,
    },
  };
  return {
    config,
    identity: {
      id: snapshot.identity.id.trim(),
      role: snapshot.identity.role.trim(),
      scope: snapshot.identity.scope.trim(),
    },
    token: snapshot.tokens.token,
    adminToken: snapshot.tokens.adminToken,
  };
}
