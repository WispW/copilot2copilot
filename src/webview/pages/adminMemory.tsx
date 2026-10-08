import { useEffect, useRef, useState } from 'preact/hooks';
import { ConfirmButton, Hint, Section } from '../components';
import { onAdminMemoryDetail, onAdminMemoryState, post } from '../api';
import type { Snapshot } from '../state';
import type { AdminMemoryFilters, AdminMemoryRoomStats } from '../../panelTypes';
import type { MemoryEntry } from '../../protocol';

type StatusFilter = 'all' | 'active' | 'deleted';

interface FilterDraft {
  roomId: string;
  q: string;
  author: string;
  tag: string;
  status: StatusFilter;
}

const emptyDraft: FilterDraft = { roomId: '', q: '', author: '', tag: '', status: 'all' };

const parseTags = (raw: string): string[] =>
  raw.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean).slice(0, 8);

const formatTime = (ts: number): string => new Date(ts).toLocaleString();

const summarize = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** 界面筛选草稿 → 中继查询参数（状态映射为 includeDeleted / deletedOnly） */
function toFilters(draft: FilterDraft, cursor?: string): AdminMemoryFilters {
  return {
    includeDeleted: draft.status !== 'active',
    ...(draft.status === 'deleted' ? { deletedOnly: true } : {}),
    ...(draft.roomId ? { roomId: draft.roomId } : {}),
    ...(draft.q.trim() ? { q: draft.q.trim() } : {}),
    ...(draft.author.trim() ? { author: draft.author.trim() } : {}),
    ...(draft.tag.trim() ? { tag: draft.tag.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** 管理页的「记忆管理」区块：数据库式浏览 / 筛选 / 详情 / 历史回滚 / 恢复 / 彻底删除 / 导出 */
export function AdminMemorySection({ snap }: { snap: Snapshot }) {
  const rooms = snap.state?.rooms ?? [];
  const [draft, setDraft] = useState<FilterDraft>(emptyDraft);
  const [applied, setApplied] = useState<AdminMemoryFilters>({ includeDeleted: true });
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState('');
  const [roomStats, setRoomStats] = useState<AdminMemoryRoomStats[]>([]);
  const [detail, setDetail] = useState<MemoryEntry | null>(null);
  const [editText, setEditText] = useState('');
  const [editTags, setEditTags] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const appendRef = useRef(false);

  useEffect(() => onAdminMemoryState(msg => {
    setLoading(false);
    setError(msg.error ?? '');
    setEntries(prev => (appendRef.current ? [...prev, ...msg.entries] : msg.entries));
    appendRef.current = false;
    setTotal(msg.total);
    setNextCursor(msg.nextCursor);
    setRoomStats(msg.rooms ?? []);
    setApplied(msg.filters ?? { includeDeleted: true });
  }), []);

  useEffect(() => onAdminMemoryDetail(msg => {
    if (!msg.entry) {
      setDetail(null);
      return;
    }
    setDetail(msg.entry);
    setEditText(msg.entry.text);
    setEditTags(msg.entry.tags.join(' '));
  }), []);

  const fetchPage = (filters: AdminMemoryFilters, appendMode: boolean): void => {
    appendRef.current = appendMode;
    setLoading(true);
    post({ type: 'adminMemoryList', filters });
  };

  // 首次进入自动拉一页（默认：全部房间、含回收站）
  useEffect(() => {
    fetchPage({ includeDeleted: true }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = (): void => {
    const filters = toFilters(draft);
    setApplied(filters);
    fetchPage(filters, false);
  };

  const reset = (): void => {
    setDraft(emptyDraft);
    const filters = toFilters(emptyDraft);
    setApplied(filters);
    fetchPage(filters, false);
  };

  const loadMore = (): void => {
    if (nextCursor) {
      fetchPage({ ...applied, cursor: nextCursor }, true);
    }
  };

  const openDetail = (entryId: string): void => {
    post({ type: 'adminMemoryGet', entryId });
  };

  const saveEdit = (): void => {
    if (!detail) {
      return;
    }
    setLoading(true);
    post({ type: 'adminMemoryUpdate', entryId: detail.id, text: editText, tags: parseTags(editTags), filters: applied });
  };

  const restoreEntry = (): void => {
    if (!detail) {
      return;
    }
    setLoading(true);
    post({ type: 'adminMemoryRestore', entryId: detail.id, filters: applied });
  };

  const rollbackTo = (revision: number): void => {
    if (!detail) {
      return;
    }
    post({ type: 'adminMemoryRestore', entryId: detail.id, revision, filters: applied });
  };

  const purgeEntry = (): void => {
    if (!detail) {
      return;
    }
    post({ type: 'adminMemoryPurge', entryId: detail.id, filters: applied });
  };

  const purgeRoom = (): void => {
    const roomId = applied.roomId ?? draft.roomId;
    if (!roomId) {
      post({ type: 'uiHint', message: '请先在筛选里选择一个房间，再执行「清空所选房间记忆」' });
      return;
    }
    post({ type: 'adminMemoryPurge', roomId, filters: applied });
  };

  const exportData = (format: 'json' | 'csv'): void => {
    post({ type: 'adminMemoryExport', format, filters: applied });
  };

  const totals = roomStats.reduce(
    (acc, room) => ({
      total: acc.total + room.total,
      active: acc.active + room.active,
      deleted: acc.deleted + room.deleted,
      bytes: acc.bytes + room.bytes,
    }),
    { total: 0, active: 0, deleted: 0, bytes: 0 },
  );

  return (
    <Section
      title="记忆管理（数据库视图）"
      extra={(
        <span class="row-wrap">
          <button class="small" onClick={() => fetchPage(applied, false)} disabled={loading}>刷新</button>
          <button class="small" onClick={() => exportData('json')}>导出 JSON</button>
          <button class="small" onClick={() => exportData('csv')}>导出 CSV</button>
        </span>
      )}
    >
      <Hint>
        跨房间查看与维护共享记忆：筛选 / 分页 / 历史版本 / 回滚 / 恢复 / 彻底删除。
        这里能读到全部房间的记忆内容（与消息不同，管理需要）。
      </Hint>
      <div class="filters">
        <label>
          房间
          <select value={draft.roomId} onChange={e => setDraft({ ...draft, roomId: e.currentTarget.value })}>
            <option value="">全部房间</option>
            {rooms.map(room => <option value={room.id} key={room.id}>{room.name}</option>)}
          </select>
        </label>
        <label>
          关键词
          <input value={draft.q} placeholder="正文 / 标签包含" onInput={e => setDraft({ ...draft, q: e.currentTarget.value })} />
        </label>
        <label>
          作者
          <input value={draft.author} placeholder="设备 id" onInput={e => setDraft({ ...draft, author: e.currentTarget.value })} />
        </label>
        <label>
          标签
          <input value={draft.tag} placeholder="完整标签" onInput={e => setDraft({ ...draft, tag: e.currentTarget.value })} />
        </label>
        <label>
          状态
          <select value={draft.status} onChange={e => setDraft({ ...draft, status: e.currentTarget.value as StatusFilter })}>
            <option value="all">全部（含回收站）</option>
            <option value="active">仅未删除</option>
            <option value="deleted">仅已删除</option>
          </select>
        </label>
        <span class="actions">
          <button class="primary small" onClick={search} disabled={loading}>查询</button>
          <button class="small" onClick={reset}>重置</button>
        </span>
      </div>
      <p class="hint">
        当前筛选 {total} 条 · 全部房间合计 {totals.total} 条（可见 {totals.active} / 回收站 {totals.deleted}，
        {(totals.bytes / 1024).toFixed(1)} KiB）
      </p>
      {error && <div class="banner">{error}</div>}
      {entries.length === 0 && !loading && <p class="hint">没有匹配的记忆条目。</p>}
      {entries.length > 0 && (
        <table class="mem-table">
          <thead>
            <tr>
              <th>房间</th>
              <th>摘要</th>
              <th>标签</th>
              <th>作者</th>
              <th>最后修改</th>
              <th>修订</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr
                key={entry.id}
                class={entry.deleted ? 'deleted-entry' : ''}
                onClick={() => openDetail(entry.id)}
                title="点击查看详情与历史版本"
              >
                <td>{entry.roomName}</td>
                <td class="mem-text">{summarize(entry.text)}</td>
                <td>{entry.tags.join(' ')}</td>
                <td>{entry.author}</td>
                <td>{entry.updatedBy}<br /><span class="hint">{formatTime(entry.updatedAt)}</span></td>
                <td>r{entry.revision}</td>
                <td>{entry.deleted ? '已删除' : '正常'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nextCursor && <button class="small" onClick={loadMore} disabled={loading}>加载更多</button>}
      <div class="row-wrap">
        <ConfirmButton
          label="清空所选房间记忆"
          confirmLabel="确认清空该房间全部记忆？不可恢复"
          danger
          onConfirm={purgeRoom}
        />
      </div>
      {detail && (
        <div class="manage">
          <h3 class="group-title">
            条目详情 · {detail.deleted ? '已删除' : '正常'} · r{detail.revision} · {detail.roomName}
          </h3>
          <p class="hint">
            id {detail.id} · 创建 {detail.author} @ {formatTime(detail.createdAt)}
            · 最后修改 {detail.updatedBy} @ {formatTime(detail.updatedAt)}
            {detail.sourceRequestId ? ` · 来源 ${detail.sourceRequestId}` : ''}
          </p>
          <label>
            正文
            <textarea rows={4} value={editText} onInput={e => setEditText(e.currentTarget.value)} />
          </label>
          <div class="row-wrap">
            <label>
              标签
              <input value={editTags} onInput={e => setEditTags(e.currentTarget.value)} />
            </label>
            <button class="primary small" onClick={saveEdit} disabled={loading}>保存修改</button>
            {detail.deleted && <button class="small" onClick={restoreEntry}>恢复条目</button>}
            <ConfirmButton label="彻底删除" confirmLabel="确认彻底删除？不可恢复" danger onConfirm={purgeEntry} />
            <button class="small" onClick={() => setDetail(null)}>关闭详情</button>
          </div>
          <h3 class="group-title">历史版本（{detail.history?.length ?? 0}）</h3>
          {(detail.history ?? []).length === 0 && <p class="hint">没有历史版本（尚未被修改过）。</p>}
          {(detail.history ?? []).slice().reverse().map(version => (
            <div class="peer" key={version.revision}>
              <div class="peer-head">
                <b>r{version.revision}</b>
                <span class="hint">{version.by} · {formatTime(version.at)}</span>
                <span class="grow"></span>
                <button class="small" onClick={() => rollbackTo(version.revision)} disabled={loading}>回滚到此版本</button>
              </div>
              <pre class="body">{version.text}</pre>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
