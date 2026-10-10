import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { ConfirmButton, Hint, Section } from '../components';
import { post } from '../api';
import type { Snapshot } from '../state';
import type { HistoryItem } from '../../store';

function formatSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) {
    return `${n} 字节`;
  }
  if (n < 1048576) {
    return `${(n / 1024).toFixed(1)} KiB`;
  }
  return `${(n / 1048576).toFixed(2)} MiB`;
}

/** 一条会话：与某位同事的全部往来（含文件交接），按时间升序 */
interface Conversation {
  peerId: string;
  items: HistoryItem[];
  /** 还没回复的来信条数（与顶部「N 条未回复」同一口径） */
  pending: number;
  lastTs: number;
  last: HistoryItem;
}

function groupByPeer(messages: HistoryItem[]): Conversation[] {
  const map = new Map<string, HistoryItem[]>();
  for (const item of messages) {
    const list = map.get(item.peerId);
    if (list) {
      list.push(item);
    } else {
      map.set(item.peerId, [item]);
    }
  }
  return [...map.entries()]
    .map(([peerId, items]) => {
      const sorted = [...items].sort((a, b) => a.ts - b.ts);
      const last = sorted[sorted.length - 1];
      return {
        peerId,
        items: sorted,
        pending: sorted.filter(item => item.direction === 'in' && !item.done).length,
        lastTs: last.ts,
        last,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}

/** 会话列表里的一行摘要：让人一眼看出最后说了什么 */
function summarize(item: HistoryItem): string {
  const body = (item.direction === 'out' ? item.replyText ?? item.text : item.text) ?? '';
  const flat = body.replace(/\s+/g, ' ').trim();
  const prefix = item.direction === 'out'
    ? (item.replyText ? '已收到回复：' : '已发送：')
    : (item.intent === 'task' ? '写任务：' : '收到：');
  const file = item.file ? `[文件 ${item.file.name}]` : '';
  return `${prefix}${file}${flat.slice(0, 48)}${flat.length > 48 ? '…' : ''}`;
}

function statusOf(item: HistoryItem): string {
  if (item.direction === 'in') {
    return item.done ? '已回复' : '未回复';
  }
  if (item.canceled) {
    return '已取消（未送达）';
  }
  return item.done ? '已收到回复' : '等待回复';
}

/** 一条记录：收到居左、发出居右；写任务用特殊卡片样式区分 */
function Bubble({ m, queued }: { m: HistoryItem; queued: boolean }) {
  return (
    <Fragment>
      <div class={`chat-row ${m.direction}`}>
        <div class={`bubble ${m.direction}${m.intent === 'task' ? ' task' : ''}`}>
          <div class="bubble-meta">
            <b>{m.peerId}</b>
            <span>{new Date(m.ts).toLocaleString()}</span>
            <span>{statusOf(m)}</span>
            {m.intent === 'task' && <span class="badge warn">写任务</span>}
            <span class="bubble-id">{m.id}</span>
          </div>
          {m.text && <div class="bubble-text">{m.text}</div>}
          {m.file && (
            <div class="file">
              文件：<b>{m.file.name}</b>（{formatSize(m.file.size)}，sha256 {String(m.file.sha256 || '').slice(0, 12)}…）
              {m.direction === 'in' && m.file.path && <><br />已保存到：<code>{m.file.path}</code></>}
            </div>
          )}
          {m.snippet && (
            <details>
              <summary>代码片段</summary>
              <pre class="body">{m.snippet}</pre>
            </details>
          )}
          {((m.direction === 'in' && !m.done) || (m.direction === 'out' && Boolean(m.replyText))) && (
            <div class="row-wrap">
              <button class="small" onClick={() => post({ type: 'manualInject', id: m.id })}>交给 Copilot</button>
            </div>
          )}
          {queued && !m.canceled && (
            <div class="row-wrap">
              <ConfirmButton
                label="取消排队"
                confirmLabel="确认取消发送？"
                danger
                onConfirm={() => post({ type: 'cancelSend', id: m.id })}
              />
              <span class="hint">还没发出去；取消后对方上线也不会补发</span>
            </div>
          )}
        </div>
      </div>
      {m.direction === 'out' && m.replyText && (
        <div class="chat-row in">
          <div class="bubble in">
            <div class="bubble-meta">
              <b>{m.peerId}</b>
              <span>回复</span>
              <span class="bubble-id">{m.id}</span>
            </div>
            <div class="bubble-text">{m.replyText}</div>
          </div>
        </div>
      )}
    </Fragment>
  );
}

export function InboxPage({ snap }: { snap: Snapshot }) {
  const messages = snap.state?.messages ?? [];
  const queued = new Set(snap.state?.queuedIds ?? []);
  // 会话列表 ↔ 气泡详情：不同会话互相独立，切换只影响这一页
  const [activePeer, setActivePeer] = useState<string | undefined>(undefined);
  const conversations = groupByPeer(messages);
  const active = conversations.find(c => c.peerId === activePeer);

  /** 会话列表上的快捷处理：只有一条待处理就直接交给 Copilot，多条则进会话逐条挑 */
  const pendingOf = (c: Conversation) => c.items.filter(i => i.direction === 'in' && !i.done);
  const act = (c: Conversation): void => {
    const pending = pendingOf(c);
    if (pending.length === 1) {
      post({ type: 'manualInject', id: pending[0].id });
      return;
    }
    setActivePeer(c.peerId);
  };

  if (active) {
    return (
      <Section
        title={`与 ${active.peerId} 的会话`}
        extra={<button onClick={() => setActivePeer(undefined)}>返回会话列表</button>}
      >
        <Hint>「交给 Copilot」会把这条记录注入当前对话处理；无人值守关闭时收到的新消息都留在这里等你决定。</Hint>
        <div class="chat">
          {active.items.map(m => <Bubble key={m.id} m={m} queued={queued.has(m.id)} />)}
        </div>
      </Section>
    );
  }

  return (
    <Section title="收件箱" extra={<button onClick={() => post({ type: 'openFilesDir' })}>打开收件目录</button>}>
      <Hint>按同事分会话：点一条会话查看气泡详情。同事发来的文件保存在扩展私有目录（不进入工作区），点上面的按钮可在文件管理器中打开。</Hint>
      {conversations.length === 0 && <p class="hint">暂无消息。</p>}
      {conversations.length > 0 && (
        <div class="conversations">
          {conversations.map(c => {
            const pending = pendingOf(c);
            return (
              <div class="conversation" key={c.peerId}>
                <button class="conversation-main" onClick={() => setActivePeer(c.peerId)}>
                  <span class="conversation-head">
                    <b>{c.peerId}</b>
                    <span class="hint">{new Date(c.lastTs).toLocaleString()}</span>
                    {c.pending > 0 && <span class="badge danger">{c.pending} 条待处理</span>}
                  </span>
                  <span class="conversation-summary">{summarize(c.last)}</span>
                </button>
                {pending.length > 0 && (
                  <button
                    class="small"
                    title={pending.length === 1
                      ? '把这条交给本机 Copilot 处理'
                      : `有 ${pending.length} 条待处理，进入会话逐条处理`}
                    onClick={() => act(c)}
                  >{pending.length === 1 ? '交给 Copilot' : '逐条处理'}</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
