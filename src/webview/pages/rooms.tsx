import { useState } from 'preact/hooks';
import { Chip, ConfirmButton, Hint, Section } from '../components';
import { post } from '../api';
import type { Snapshot } from '../state';
import type { RoomSummary } from '../../protocol';

/** 某个房间的管理表单（改名 / 改密码 / 归类）当前编辑中的值 */
interface RoomEdit {
  rename?: string;
  passwd?: string;
  category?: string;
}

export function RoomsPage({ snap }: { snap: Snapshot }) {
  const state = snap.state;
  const [joinPw, setJoinPw] = useState<Record<string, string>>({});
  const [roomEdits, setRoomEdits] = useState<Record<string, RoomEdit>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [newRoom, setNewRoom] = useState({ name: '', password: '', categoryId: '' });
  const [newCategory, setNewCategory] = useState('');
  const [catRenames, setCatRenames] = useState<Record<string, string>>({});
  if (!state) {
    return null;
  }
  const myId = state.effectiveIdentity.id || '';
  const verified = state.admin.verified;
  const rooms = state.rooms;
  const categories = state.categories ?? [];

  const roomOp = (op: string, payload: Record<string, unknown>): void => post({ type: 'roomOp', op, payload });
  const adminOp = (op: string, payload: Record<string, unknown>): void => post({ type: 'adminOp', op, payload });
  const edit = (roomId: string, patch: RoomEdit): void =>
    setRoomEdits(prev => ({ ...prev, [roomId]: { ...(prev[roomId] ?? {}), ...patch } }));
  const toggleExpand = (roomId: string): void =>
    setExpanded(prev => (prev.includes(roomId) ? prev.filter(id => id !== roomId) : [...prev, roomId]));

  const createRoom = (): void => {
    const name = newRoom.name.trim();
    if (!name) {
      // 不静默返回：空名时明确提示，避免"点了没反应"
      post({ type: 'uiHint', message: '请先填写房间名，再点「创建房间」' });
      return;
    }
    adminOp('room-create', { name, password: newRoom.password, categoryId: newRoom.categoryId });
    setNewRoom({ name: '', password: '', categoryId: '' });
  };

  const createCategory = (): void => {
    const name = newCategory.trim();
    if (!name) {
      post({ type: 'uiHint', message: '请先填写分类名，再点「新建分类」' });
      return;
    }
    adminOp('category-create', { name });
    setNewCategory('');
  };

  // 分类分组：中继下发的分类（按创建顺序）+「未分类」。管理员看到全部分组（含空分类），成员只看有房间的分组
  const groups = [
    ...categories.map(category => ({
      id: category.id,
      name: category.name,
      rooms: rooms.filter(room => room.categoryId === category.id),
    })),
    { id: '', name: '未分类', rooms: rooms.filter(room => !room.categoryId) },
  ];

  const roomCard = (room: RoomSummary) => {
    const fields = roomEdits[room.id] ?? {};
    const isExpanded = expanded.includes(room.id);
    const relayOnline = Array.isArray(room.onlineMembers) ? new Set(room.onlineMembers) : undefined;
    const relayBanned = new Set(Array.isArray(room.bannedMembers) ? room.bannedMembers : []);
    return (
      <section class="card room" key={room.id}>
        <div class="card-head">
          <h2>{room.name}</h2>
          <span class="hint">成员 {room.memberCount}</span>
          {(room.memoryCount ?? 0) > 0 && <span class="hint">记忆 {room.memoryCount} 条</span>}
          {room.hasPassword && <span class="hint">有密码</span>}
          {room.joined && <span class="hint">已加入</span>}
          {room.createdBy && <span class="hint">创建者 {room.createdBy}</span>}
          <span class="grow"></span>
          {!room.joined && (
            <>
              <input
                type="password"
                placeholder={room.hasPassword ? '输入房间密码' : '无需密码'}
                value={joinPw[room.id] ?? ''}
                onInput={e => setJoinPw(prev => ({ ...prev, [room.id]: e.currentTarget.value }))}
              />
              <button
                class="primary small"
                onClick={() => roomOp('join', { roomId: room.id, password: joinPw[room.id] ?? '' })}
              >加入</button>
            </>
          )}
          {room.joined && (
            <button class="small" onClick={() => roomOp('leave', { roomId: room.id })}>退出</button>
          )}
          {verified && (
            <button class="small" onClick={() => toggleExpand(room.id)}>{isExpanded ? '收起管理' : '管理'}</button>
          )}
        </div>

        {Array.isArray(room.members) && room.members.length > 0
          ? (
            <p class="chips">
              <span class="hint">成员（{room.memberCount}{relayOnline ? `，在线 ${relayOnline.size}` : ''}）：</span>
              {room.members.map(member => (
                <span class="member" key={member}>
                  <Chip mine={member === myId}>{member}</Chip>
                  {relayOnline && !relayOnline.has(member) && <span class="hint">（离线）</span>}
                  {relayBanned.has(member) && <span class="hint conflict">已被中继封禁（需管理员解封）</span>}
                  {verified && member !== myId && (
                    <ConfirmButton
                      label="移出"
                      confirmLabel="确认移出"
                      onConfirm={() => adminOp('room-kick', { roomId: room.id, memberId: member })}
                    />
                  )}
                </span>
              ))}
            </p>
          )
          : <p class="hint">成员：{room.memberCount} 人（加入后可查看明细）</p>}

        {verified && isExpanded && (
          <div class="manage">
            <label class="row-wrap">
              改名
              <input
                value={fields.rename ?? ''}
                placeholder={room.name}
                maxlength={32}
                onInput={e => edit(room.id, { rename: e.currentTarget.value })}
              />
              <button
                class="small"
                onClick={() => adminOp('room-update', { roomId: room.id, name: (fields.rename ?? '').trim() })}
              >保存</button>
            </label>
            <label class="row-wrap">
              改密码
              <input
                type="password"
                value={fields.passwd ?? ''}
                placeholder="留空表示清除密码"
                onInput={e => edit(room.id, { passwd: e.currentTarget.value })}
              />
              <button
                class="small"
                onClick={() => adminOp('room-update', { roomId: room.id, password: fields.passwd ?? '' })}
              >保存</button>
            </label>
            <label class="row-wrap">
              分类
              <select
                value={fields.category ?? room.categoryId ?? ''}
                onChange={e => edit(room.id, { category: e.currentTarget.value })}
              >
                <option value="">未分类</option>
                {categories.map(category => <option value={category.id} key={category.id}>{category.name}</option>)}
              </select>
              <button
                class="small"
                onClick={() => adminOp('room-update', { roomId: room.id, categoryId: fields.category ?? room.categoryId ?? '' })}
              >保存</button>
            </label>
            {Array.isArray(room.blocked) && room.blocked.length > 0 && (
              <p class="chips">
                <span class="hint">禁止再加入（解除后可凭密码重新加入）：</span>
                {room.blocked.map(member => (
                  <span class="member" key={member}>
                    <Chip>{member}</Chip>
                    <button
                      class="small"
                      onClick={() => adminOp('room-unblock', { roomId: room.id, memberId: member })}
                    >解除</button>
                  </span>
                ))}
              </p>
            )}
            <ConfirmButton
              label="解散房间"
              confirmLabel="确认解散？"
              danger
              onConfirm={() => adminOp('room-dissolve', { roomId: room.id })}
            />
          </div>
        )}
      </section>
    );
  };

  return (
    <div class="page">
      {verified && (
        <Section
          title="新建房间"
          extra={<button onClick={() => post({ type: 'refreshRooms' })}>刷新列表</button>}
        >
          <div class="row-wrap">
            <label>
              房间名
              <input
                value={newRoom.name}
                placeholder="如：订单服务组"
                maxlength={32}
                onInput={e => setNewRoom(prev => ({ ...prev, name: e.currentTarget.value }))}
              />
            </label>
            <label>
              分类
              <select
                value={newRoom.categoryId}
                onChange={e => setNewRoom(prev => ({ ...prev, categoryId: e.currentTarget.value }))}
              >
                <option value="">未分类</option>
                {categories.map(category => <option value={category.id} key={category.id}>{category.name}</option>)}
              </select>
            </label>
            <label>
              加入密码（可选）
              <input
                type="password"
                value={newRoom.password}
                placeholder="留空表示无需密码"
                onInput={e => setNewRoom(prev => ({ ...prev, password: e.currentTarget.value }))}
              />
            </label>
            <button class="primary" onClick={createRoom}>创建房间</button>
          </div>
          <Hint>
            房间由中继管理员统一创建与管理；房间列表（名称 / 分类 / 人数 / 是否有密码）
            <strong>对所有设备可见</strong>，同事凭密码加入。创建者会自动加入房间，不需要的话可以退出（房间不会因此消失）。
          </Hint>
        </Section>
      )}

      {!verified && (
        <div class="row-wrap">
          <span class="grow"></span>
          <button onClick={() => post({ type: 'refreshRooms' })}>刷新列表</button>
        </div>
      )}

      {rooms.length === 0 && (
        <div class="empty">
          <p>
            {verified
              ? '中继上还没有房间：用上面的「新建房间」创建第一个房间，把密码发给同事。'
              : '当前中继上还没有房间，请联系中继管理员创建。'}
          </p>
        </div>
      )}

      {groups.map(group => {
        if (!verified && group.rooms.length === 0) {
          return null;
        }
        return (
          <div key={group.id || 'uncategorized'}>
            <h3 class="group-title">
              {group.name}{group.id ? `（${group.rooms.length}）` : ''}
            </h3>
            {group.rooms.length === 0 && <p class="hint">（该分类下还没有房间）</p>}
            {group.rooms.map(roomCard)}
          </div>
        );
      })}

      {verified && (
        <Section title="分类管理">
          <div class="row-wrap">
            <label>
              新分类
              <input
                value={newCategory}
                placeholder="如：订单组"
                maxlength={32}
                onInput={e => setNewCategory(e.currentTarget.value)}
              />
            </label>
            <button class="small" onClick={createCategory}>新建分类</button>
          </div>
          {categories.length === 0 && <p class="hint">（还没有分类。分类只用于分组与排序，不影响任何权限）</p>}
          {categories.map(category => (
            <div class="peer" key={category.id}>
              <div class="peer-head">
                <b>{category.name}</b>
                <span class="hint">{rooms.filter(room => room.categoryId === category.id).length} 个房间</span>
                <span class="grow"></span>
                <input
                  value={catRenames[category.id] ?? ''}
                  placeholder="改名"
                  maxlength={32}
                  onInput={e => setCatRenames(prev => ({ ...prev, [category.id]: e.currentTarget.value }))}
                />
                <button
                  class="small"
                  onClick={() => adminOp('category-rename', { categoryId: category.id, name: (catRenames[category.id] ?? '').trim() })}
                >保存</button>
                <ConfirmButton
                  label="删除"
                  confirmLabel="确认删除？"
                  danger
                  onConfirm={() => adminOp('category-delete', { categoryId: category.id })}
                />
              </div>
            </div>
          ))}
          <Hint>删除分类不会删除房间：其下房间会回到「未分类」。</Hint>
        </Section>
      )}
    </div>
  );
}
