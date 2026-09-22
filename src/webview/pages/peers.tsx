import { Hint } from '../components';
import { post } from '../api';
import type { Snapshot } from '../state';
import type { TabId } from '../app';

export function PeersPage({ snap, onGoto }: { snap: Snapshot; onGoto(tab: TabId): void }) {
  const state = snap.state;
  if (!state) {
    return null;
  }
  // 列表数据源 = 在线 id（中继 presence）；与「停用」无关：停用的对端仍在线，条目必须保留才能再启用
  const onlineIds = new Set(state.onlineIds);
  const myId = state.effectiveIdentity.id || '';
  const rows = state.config.colleagues
    .filter(c => c.id !== myId && c.relayPeerId !== myId)
    .filter(c => onlineIds.has(c.id));
  const joined = state.rooms.some(room => room.joined);

  return (
    <div>
      <Hint>列表由中继自动维护：只显示在线的 Copilot（对方下线后条目自动消失），角色与负责内容由中继下发，无需手工添加或编辑。</Hint>
      {rows.length === 0 && (
        <div class="empty">
          <p>当前没有在线的 Copilot。</p>
          {state.status.state !== 'online' && <p>尚未连接中继：先到「连接」页确认地址并连接。</p>}
          {state.status.state === 'online' && joined && <p>已连接中继，但房间里暂时没有其他在线成员；对方上线后会自动出现在这里。</p>}
          {state.status.state === 'online' && !joined && <p>你还没有加入任何房间，因此看不到其他人——房间决定「谁能看到谁」。</p>}
          {state.status.state !== 'online'
            ? <button class="primary" onClick={() => onGoto('conn')}>去连接页</button>
            : (!joined && <button class="primary" onClick={() => onGoto('rooms')}>去创建 / 加入房间</button>)}
        </div>
      )}
      {rows.map(c => {
        const disabled = c.enabled === false;
        const profileReady = Boolean(c.role && c.scope);
        return (
          <div key={c.id} class={disabled ? 'peer disabled' : 'peer'}>
            <div class="peer-head">
              <b>{c.id}</b>
              <span class="hint">{profileReady ? '档案已同步' : '档案未同步'}</span>
              {disabled && <span class="hint conflict">已停用</span>}
              <span class="grow"></span>
              <button
                class="small"
                title="停用后不参与通信，也不会出现在模型可见名单里"
                onClick={() => post({ type: 'toggleColleague', peerId: c.id, enabled: disabled })}
              >{disabled ? '启用' : '停用'}</button>
            </div>
            <p class="hint">
              角色：<b>{c.role || '（等待中继同步）'}</b> · 负责内容：<b>{c.scope || '（等待中继同步）'}</b>
            </p>
          </div>
        );
      })}
    </div>
  );
}
