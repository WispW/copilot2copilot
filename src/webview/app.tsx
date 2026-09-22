import { useState } from 'preact/hooks';
import { post } from './api';
import { reloadDraft, savePayload, useSnapshot } from './state';
import { AdminPage } from './pages/admin';
import { BehaviorPage } from './pages/behavior';
import { ConnectPage } from './pages/connect';
import { HelpPage } from './pages/help';
import { InboxPage } from './pages/inbox';
import { PeersPage } from './pages/peers';
import { RoomsPage } from './pages/rooms';

export type TabId = 'conn' | 'peers' | 'rooms' | 'admin' | 'inbox' | 'behavior' | 'help';

const TABS: { id: TabId; label: string }[] = [
  { id: 'conn', label: '连接' },
  { id: 'peers', label: 'Copilot 列表' },
  { id: 'rooms', label: '房间' },
  { id: 'admin', label: '管理' },
  { id: 'inbox', label: '收件箱' },
  { id: 'behavior', label: '行为' },
  { id: 'help', label: '帮助' },
];

const STATE_LABEL: Record<string, string> = {
  stopped: '未连接',
  connecting: '连接中',
  online: '已连接',
  offline: '连接失败',
};

export function App() {
  const snap = useSnapshot();
  const [tab, setTab] = useState<TabId>('conn');
  const state = snap.state;

  const goto = (next: TabId): void => {
    setTab(next);
    // 可见性与封禁变化只发生在服务端，已连接时切页顺手拉一次最新状态；
    // 未连接时跳过，否则只会弹出「请先连接」这类无用的警告
    if (snap.state?.status.state !== 'online') {
      return;
    }
    if (next === 'rooms') {
      post({ type: 'refreshRooms' });
    }
    if (next === 'admin') {
      post({ type: 'refreshAdmin' });
    }
  };

  if (!state) {
    return <div class="loading">正在读取扩展状态…</div>;
  }

  const status = state.status;
  const connecting = status.state === 'connecting';
  const online = status.state === 'online';
  const unread = state.messages.filter(m => m.direction === 'in' && !m.done).length;

  const save = (): void => {
    const payload = savePayload();
    if (!payload) {
      return;
    }
    // 令牌输入等保存成功（扩展回推 resetDraft）后再清空，保存失败时用户不必重新粘贴
    post({ type: 'save', ...payload });
  };

  return (
    <div>
      <header>
        <div class="status-row">
          <span class={`dot ${status.state}`}></span>
          <b>{STATE_LABEL[status.state] ?? status.state}</b>
          <span class="hint">{status.detail}</span>
          {unread > 0 && <span class="badge">{unread} 条未回复</span>}
        </div>
        <div class="actions">
          {online || connecting
            ? <button onClick={() => post({ type: 'disconnect' })}>断开连接</button>
            : <button class="primary" onClick={() => post({ type: 'connect' })}>{status.state === 'offline' ? '重试连接' : '连接'}</button>}
          <button onClick={() => post({ type: 'showLogs' })}>日志</button>
          <button
            disabled={!snap.dirty}
            title="放弃未保存的修改，恢复为当前生效配置"
            onClick={reloadDraft}
          >重新载入</button>
          <button
            class="primary"
            disabled={!snap.dirty}
            title={snap.dirty ? '保存并应用' : '当前没有未保存的修改'}
            onClick={save}
          >保存并应用</button>
        </div>
      </header>

      {snap.dirty && (
        <div class="banner dirty">
          有未保存的修改（字段高亮处已改动），点右上角「保存并应用」生效。
        </div>
      )}
      {state.identityMissing.length > 0 && (
        <div class="banner">
          本工作区档案缺少 {state.identityMissing.join('、')}，补全前无法与同事通信。
          {tab !== 'conn' && <button class="small" onClick={() => goto('conn')}>去连接页</button>}
        </div>
      )}

      <nav id="tabs">
        {TABS.map(t => (
          <button class={t.id === tab ? 'active' : ''} key={t.id} onClick={() => goto(t.id)}>
            {t.label}{t.id === 'peers' && state.onlineIds.length > 0 ? ` (${state.onlineIds.length})` : ''}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'conn' && <ConnectPage snap={snap} />}
        {tab === 'peers' && <PeersPage snap={snap} onGoto={goto} />}
        {tab === 'rooms' && <RoomsPage snap={snap} />}
        {tab === 'admin' && <AdminPage snap={snap} onGoto={goto} />}
        {tab === 'inbox' && <InboxPage snap={snap} />}
        {tab === 'behavior' && <BehaviorPage snap={snap} />}
        {tab === 'help' && <HelpPage snap={snap} />}
      </main>
    </div>
  );
}
