import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ConfirmButton, Hint, Section } from '../components';
import { onMemoryState, post } from '../api';
import type { Snapshot } from '../state';
import type { MemoryEntry } from '../../protocol';

const parseTags = (raw: string): string[] =>
  raw.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean).slice(0, 8);

const formatTime = (ts: number): string => new Date(ts).toLocaleString();

export function MemoryPage({ snap }: { snap: Snapshot }) {
  const state = snap.state;
  const joinedRooms = useMemo(
    () => (state?.rooms ?? []).filter(room => room.joined),
    [state?.rooms],
  );
  const [roomId, setRoomId] = useState('');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'list' | 'search'>('list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draftText, setDraftText] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [editing, setEditing] = useState<{ id: string; revision: number; text: string; tags: string } | null>(null);
  const appendRef = useRef(false);

  // 默认选中第一个已加入的房间
  useEffect(() => {
    if (!roomId && joinedRooms.length > 0) {
      setRoomId(joinedRooms[0].id);
    }
  }, [joinedRooms, roomId]);

  // 订阅中继返回的记忆数据（列表 / 检索 / 增删改后的刷新）
  useEffect(() => onMemoryState(msg => {
    if (msg.mode === 'list' && msg.roomId && msg.roomId !== roomId) {
      return; // 忽略其它房间的迟到响应
    }
    setLoading(false);
    setError(msg.error ?? '');
    setMode(msg.mode);
    setEntries(prev => (msg.mode === 'search' || !appendRef.current ? msg.entries : [...prev, ...msg.entries]));
    appendRef.current = false;
    setTotal(msg.total);
    setNextCursor(msg.nextCursor);
  }), [roomId]);

  // 房间 / 回收站切换时重新拉取
  useEffect(() => {
    if (roomId) {
      appendRef.current = false;
      setLoading(true);
      post({ type: 'memoryList', roomId, includeDeleted });
    }
  }, [roomId, includeDeleted]);

  if (!state) {
    return null;
  }
  const online = state.status.state === 'online';

  const reload = (): void => {
    if (!roomId) {
      return;
    }
    appendRef.current = false;
    setQuery('');
    setLoading(true);
    post({ type: 'memoryList', roomId, includeDeleted });
  };

  const loadMore = (): void => {
    if (!roomId || !nextCursor) {
      return;
    }
    appendRef.current = true;
    setLoading(true);
    post({ type: 'memoryList', roomId, cursor: nextCursor, includeDeleted });
  };

  const search = (): void => {
    const value = query.trim();
    if (!value) {
      reload();
      return;
    }
    appendRef.current = false;
    setLoading(true);
    post({ type: 'memorySearch', roomId, query: value });
  };

  const create = (): void => {
    const text = draftText.trim();
    if (!roomId || !text) {
      post({ type: 'uiHint', message: '请先选择房间并填写要记住的内容' });
      return;
    }
    setLoading(true);
    post({ type: 'memoryCreate', roomId, text, tags: parseTags(draftTags), includeDeleted });
    setDraftText('');
    setDraftTags('');
  };

  const saveEdit = (): void => {
    if (!editing || !editing.text.trim()) {
      return;
    }
    setLoading(true);
    post({
      type: 'memoryUpdate',
      roomId,
      entryId: editing.id,
      revision: editing.revision,
      text: editing.text.trim(),
      tags: parseTags(editing.tags),
      includeDeleted,
    });
    setEditing(null);
  };

  const remove = (entry: MemoryEntry): void => {
    setLoading(true);
    post({ type: 'memoryDelete', roomId, entryId: entry.id, revision: entry.revision, includeDeleted });
  };

  const restore = (entry: MemoryEntry): void => {
    setLoading(true);
    post({ type: 'memoryRestore', roomId, entryId: entry.id, includeDeleted });
  };

  return (
    <div>
      <Section title="房间共享记忆" extra={<button onClick={reload} disabled={!roomId}>刷新</button>}>
        {!online && <div class="banner">共享记忆保存在中继上，需要先连接中继才能使用（「连接」页）。</div>}
        {joinedRooms.length === 0
          ? <div class="empty"><p>你还没有加入任何房间。共享记忆按房间隔离，请先到「房间」页加入房间。</p></div>
          : (
            <div class="row-wrap">
              <label>
                房间
                <select value={roomId} onChange={e => setRoomId(e.currentTarget.value)}>
                  {joinedRooms.map(room => (
                    <option value={room.id} key={room.id}>{room.name}（{room.memoryCount ?? 0} 条）</option>
                  ))}
                </select>
              </label>
              <label class="wide">
                搜索
                <input
                  value={query}
                  placeholder="关键词 / 标识符；回车或点「检索」"
                  onInput={e => setQuery(e.currentTarget.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      search();
                    }
                  }}
                />
              </label>
              <label class="row">
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={e => setIncludeDeleted(e.currentTarget.checked)}
                />
                含回收站
              </label>
              <button class="small" onClick={search} disabled={!roomId}>检索</button>
            </div>
          )}
        <Hint>
          房间内所有成员共享这份记忆、也都可以修改：向同事提问前 Copilot 会先检索这里，避免重复问答；修改保留历史版本。
          删除是<strong>软删除</strong>——勾选上方「含回收站」可以查看并恢复。
        </Hint>
        {error && <div class="banner">{error}</div>}
      </Section>

      {roomId && (
        <Section title="新增记忆">
          <label>
            内容（一条一个事实）
            <textarea
              rows={3}
              value={draftText}
              placeholder="例如：OrderService 的 pageSize 上限是 100，超过会截断（来源：同事答复）"
              onInput={e => setDraftText(e.currentTarget.value)}
            />
          </label>
          <div class="row-wrap">
            <label>
              标签（可选）
              <input
                value={draftTags}
                placeholder="空格或逗号分隔，最多 8 个"
                onInput={e => setDraftTags(e.currentTarget.value)}
              />
            </label>
            <button class="primary" onClick={create}>添加到共享记忆</button>
          </div>
          <Hint>写好后房间内所有成员（及其 Copilot）都能检索到；同内容自动去重。</Hint>
        </Section>
      )}

      {roomId && (
        <Section title={mode === 'search' ? `检索结果（${entries.length}）` : `记忆条目（${total}）`}>
          {entries.length === 0 && !loading && (
            <p class="hint">
              {mode === 'search'
                ? '没有匹配的条目。'
                : '这个房间还没有记忆：拿到同事的结论后，让 Copilot 用 talk2copilot_remember 记下来。'}
            </p>
          )}
          {entries.map(entry => (
            <div class={entry.deleted ? 'msg deleted-entry' : 'msg'} key={entry.id}>
              <div class="msg-head">
                <span class="badge">{entry.roomName || '—'}</span>
                <b>{entry.author}</b>
                <span class="hint">
                  修订 {entry.revision} · 最后修改 {entry.updatedBy} · {formatTime(entry.updatedAt)}
                  {entry.score !== undefined ? ` · 相关度 ${entry.score}` : ''}
                  {entry.sourceRequestId ? ` · 来源 ${entry.sourceRequestId}` : ''}
                </span>
                <span class="grow"></span>
                {entry.deleted && <span class="hint conflict">已删除</span>}
                {!entry.deleted && editing?.id !== entry.id && (
                  <>
                    <button
                      class="small"
                      onClick={() => setEditing({ id: entry.id, revision: entry.revision, text: entry.text, tags: entry.tags.join(' ') })}
                    >编辑</button>
                    <ConfirmButton
                      label="删除"
                      confirmLabel="确认删除（可在回收站恢复）"
                      danger
                      onConfirm={() => remove(entry)}
                    />
                  </>
                )}
                {entry.deleted && <button class="small" onClick={() => restore(entry)}>恢复</button>}
              </div>
              {editing?.id === entry.id
                ? (
                  <div class="manage">
                    <textarea
                      rows={3}
                      value={editing.text}
                      onInput={e => setEditing({ ...editing, text: e.currentTarget.value })}
                    />
                    <input
                      value={editing.tags}
                      placeholder="标签（空格或逗号分隔）"
                      onInput={e => setEditing({ ...editing, tags: e.currentTarget.value })}
                    />
                    <div class="row-wrap">
                      <button class="primary small" onClick={saveEdit}>保存（修订 {editing.revision}）</button>
                      <button class="small" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </div>
                )
                : (
                  <>
                    <pre class="body">{entry.text}</pre>
                    {entry.tags.length > 0 && (
                      <p class="chips">
                        {entry.tags.map(tag => <span class="chip" key={tag}>{tag}</span>)}
                      </p>
                    )}
                  </>
                )}
            </div>
          ))}
          {nextCursor && <button onClick={loadMore} disabled={loading}>加载更多</button>}
        </Section>
      )}
    </div>
  );
}
