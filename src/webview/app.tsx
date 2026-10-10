import { useEffect, useState } from 'preact/hooks';
import { post } from './api';
import { savePayload, useSnapshot } from './state';
import { AdminPage } from './pages/admin';
import { BehaviorPage } from './pages/behavior';
import { ConnectPage } from './pages/connect';
import { HelpPage } from './pages/help';
import { InboxPage } from './pages/inbox';
import { MemoryPage } from './pages/memory';
import { PeersPage } from './pages/peers';
import { RoomsPage } from './pages/rooms';

export type TabId = 'conn' | 'peers' | 'rooms' | 'memory' | 'admin' | 'inbox' | 'behavior' | 'help';

const TABS: { id: TabId; label: string }[] = [
  { id: 'conn', label: '连接' },
  { id: 'peers', label: 'Copilot 列表' },
  { id: 'rooms', label: '房间' },
  { id: 'memory', label: '记忆' },
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
  // 「刷新界面」在存在未保存修改时需要二次确认（webview 沙箱忽略原生 confirm）
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const state = snap.state;
  // 未填写管理密钥时不显示「管理」面板（已填但未通过验证仍显示，便于修改密钥）
  const adminVisible = state ? state.admin.tokenSet : false;

  useEffect(() => {
    if (!adminVisible && tab === 'admin') {
      setTab('conn');
    }
  }, [adminVisible, tab]);

  useEffect(() => {
    if (!confirmRefresh) {
      return;
    }
    const timer = setTimeout(() => setConfirmRefresh(false), 8000);
    return () => clearTimeout(timer);
  }, [confirmRefresh]);

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
  const execGrantCount = state.config.colleagues.filter(c => c.allowExec === true).length;

  const save = (): void => {
    const payload = savePayload();
    if (!payload) {
      return;
    }
    // 令牌输入等保存成功（扩展回推 resetDraft）后再清空，保存失败时用户不必重新粘贴
    post({ type: 'save', ...payload });
  };

  return (
    <div class="shell">
      <header>
        <div class="status-row">
          <span class={`dot ${status.state}`}></span>
          <b>{STATE_LABEL[status.state] ?? status.state}</b>
          <span class="hint">{status.detail}</span>
          {unread > 0 && <span class="badge danger">{unread} 条未回复</span>}
          <label class="switch" title="开启后，收到同事消息自动交给本机 Copilot 处理；关闭（默认）只进收件箱，由你手动处理">
            <input
              type="checkbox"
              checked={state.config.behavior.unattended === true}
              onChange={e => post({ type: 'setUnattended', value: e.currentTarget.checked })}
            />
            <span class="switch-track"><span class="switch-thumb"></span></span>
            无人值守
          </label>
          {execGrantCount > 0 && (
            <button
              class="badge warn"
              title="已允许这些同事要求本机 Copilot 执行写操作；点击到列表逐人管理"
              onClick={() => goto('peers')}
            >可执行授权 · {execGrantCount} 位</button>
          )}
        </div>
        <div class="actions">
          {online || connecting
            ? <button onClick={() => post({ type: 'disconnect' })}>断开连接</button>
            : <button class="primary" onClick={() => post({ type: 'connect' })}>{status.state === 'offline' ? '重试连接' : '连接'}</button>}
          <button onClick={() => post({ type: 'showLogs' })}>日志</button>
          <button
            class={confirmRefresh ? 'armed' : ''}
            title={snap.dirty
              ? '重新加载整个界面；有未保存的修改，点击后会再确认一次'
              : '重新加载整个界面（等同于关闭页面重新打开）'}
            onClick={() => {
              if (snap.dirty && !confirmRefresh) {
                setConfirmRefresh(true);
                return;
              }
              // 交给扩展重新注入页面（webview 内直接 location.reload() 会丢失注入环境导致黑屏）
              post({ type: 'reloadWebview' });
            }}
          >{confirmRefresh ? '确认刷新（丢弃修改）' : '刷新界面'}</button>
          <button
            class="primary"
            disabled={!snap.dirty}
            title={snap.dirty ? '保存并应用' : '当前没有未保存的修改'}
            onClick={save}
          >保存并应用</button>
        </div>
      </header>

      <div class="layout">
        <nav class="side">
          {TABS.filter(t => t.id !== 'admin' || adminVisible).map(t => (
            <button class={t.id === tab ? 'active' : ''} key={t.id} onClick={() => goto(t.id)}>
              <span class="label">{t.label}</span>
              {t.id === 'peers' && state.onlineIds.length > 0 && <span class="count">{state.onlineIds.length}</span>}
              {t.id === 'inbox' && unread > 0 && <span class="count alert">{unread}</span>}
            </button>
          ))}
          <div class="side-foot">
            <span class="hint">扩展 {state.extensionVersion || '未知'}</span>
            {state.relayInfo.version && <span class="hint">中继 {state.relayInfo.version}</span>}
          </div>
        </nav>

        <main>
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

          {tab === 'conn' && <ConnectPage snap={snap} />}
          {tab === 'peers' && <PeersPage snap={snap} onGoto={goto} />}
          {tab === 'rooms' && <RoomsPage snap={snap} />}
          {tab === 'memory' && <MemoryPage snap={snap} />}
          {tab === 'admin' && <AdminPage snap={snap} onGoto={goto} />}
          {tab === 'inbox' && <InboxPage snap={snap} />}
          {tab === 'behavior' && <BehaviorPage snap={snap} />}
          {tab === 'help' && <HelpPage snap={snap} />}
        </main>
      </div>
    </div>
  );
}
