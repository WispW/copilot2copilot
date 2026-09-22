import { useState } from 'preact/hooks';
import { Chip, ConfirmButton, Hint, Section } from '../components';
import { post } from '../api';
import type { Snapshot } from '../state';

type Field = 'join' | 'rename' | 'passwd';

export function RoomsPage({ snap }: { snap: Snapshot }) {
  const state = snap.state;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // 每个房间的输入框内容：{ roomId: { join / rename / passwd } }
  const [forms, setForms] = useState<Record<string, Partial<Record<Field, string>>>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!state) {
    return null;
  }
  const myId = state.effectiveIdentity.id || '';
  const verified = state.admin.verified;
  const rooms = state.rooms;

  const roomOp = (op: string, payload: Record<string, unknown>): void => post({ type: 'roomOp', op, payload });
  const setField = (roomId: string, field: Field, value: string): void =>
    setForms(prev => ({ ...prev, [roomId]: { ...(prev[roomId] ?? {}), [field]: value } }));
  const toggleExpand = (roomId: string): void =>
    setExpanded(prev => (prev.includes(roomId) ? prev.filter(id => id !== roomId) : [...prev, roomId]));

  const create = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      // 不静默返回：空名时明确提示，避免"点了没反应"
      post({ type: 'uiHint', message: '请先填写新房间名，再点「创建房间」' });
      return;
    }
    roomOp('create', { name: trimmed, password });
    setName('');
    setPassword('');
  };

  return (
    <div>
      <Section
        title="创建房间"
        extra={<button onClick={() => post({ type: 'refreshRooms' })}>刷新列表</button>}
      >
        <div class="row-wrap">
          <label>
            房间名
            <input value={name} placeholder="如：订单服务组" maxlength={32} onInput={e => setName(e.currentTarget.value)} />
          </label>
          <label>
            加入密码（可选）
            <input
              type="password"
              value={password}
              placeholder="留空表示无需密码"
              onInput={e => setPassword(e.currentTarget.value)}
            />
          </label>
          <button class="primary" onClick={create}>创建房间</button>
        </div>
        <Hint>
          房间决定「谁能看到谁」：只能看到、也只能与同房间成员通信；
          <strong>未加入任何房间时与所有人互相不可见</strong>。创建后把密码告诉同事，对方加入即可互通。
          详细规则见「帮助」页。
        </Hint>
      </Section>

      {rooms.length === 0
        ? <div class="empty"><p>当前中继上还没有房间。创建第一个房间，把密码发给要通信的同事。</p></div>
        : rooms.map(room => {
          const owner = room.ownerId === myId;
          const canManage = owner || verified;
          const relayBanned = new Set(Array.isArray(room.bannedMembers) ? room.bannedMembers : []);
          const relayOnline = Array.isArray(room.onlineMembers) ? new Set(room.onlineMembers) : undefined;
          const fields = forms[room.id] ?? {};
          const isExpanded = expanded.includes(room.id);
          return (
            <section class="card room">
              <div class="card-head">
                <h2>{room.name}</h2>
                <span class="hint">所有者 {room.ownerId}</span>
                {room.hasPassword && <span class="hint">有密码</span>}
                {room.joined && <span class="hint">已加入</span>}
                {owner ? <span class="hint">所有者</span> : (verified ? <span class="hint">管理员</span> : '')}
                <span class="grow"></span>
                {!room.joined && (
                  <>
                    <input
                      type="password"
                      placeholder={room.hasPassword ? '输入房间密码' : '无需密码'}
                      value={fields.join ?? ''}
                      onInput={e => setField(room.id, 'join', e.currentTarget.value)}
                    />
                    <button class="primary small" onClick={() => roomOp('join', { roomId: room.id, password: fields.join ?? '' })}>加入</button>
                  </>
                )}
                {room.joined && !owner && (
                  <button class="small" onClick={() => roomOp('leave', { roomId: room.id })}>退出</button>
                )}
                {canManage && (
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
                        {canManage && member !== room.ownerId && (
                          <ConfirmButton
                            label="移出"
                            confirmLabel="确认移出"
                            onConfirm={() => roomOp('kick', { roomId: room.id, memberId: member })}
                          />
                        )}
                      </span>
                    ))}
                  </p>
                )
                : <p class="hint">成员：{room.memberCount} 人（加入后可查看明细）</p>}

              {canManage && isExpanded && (
                <div class="manage">
                  <label class="row-wrap">
                    改名
                    <input
                      value={fields.rename ?? ''}
                      placeholder={room.name}
                      maxlength={32}
                      onInput={e => setField(room.id, 'rename', e.currentTarget.value)}
                    />
                    <button
                      class="small"
                      onClick={() => roomOp('rename', { roomId: room.id, name: (fields.rename ?? '').trim() })}
                    >保存</button>
                  </label>
                  <label class="row-wrap">
                    改密码
                    <input
                      type="password"
                      value={fields.passwd ?? ''}
                      placeholder="留空表示清除密码"
                      onInput={e => setField(room.id, 'passwd', e.currentTarget.value)}
                    />
                    <button class="small" onClick={() => roomOp('passwd', { roomId: room.id, password: fields.passwd ?? '' })}>保存</button>
                  </label>
                  {Array.isArray(room.blocked) && room.blocked.length > 0 && (
                    <p class="chips">
                      <span class="hint">禁止再加入（解除后可凭密码重新加入）：</span>
                      {room.blocked.map(member => (
                        <span class="member" key={member}>
                          <Chip>{member}</Chip>
                          <button class="small" onClick={() => roomOp('unblock', { roomId: room.id, memberId: member })}>解除</button>
                        </span>
                      ))}
                    </p>
                  )}
                  <ConfirmButton
                    label="解散房间"
                    confirmLabel="确认解散？"
                    danger
                    onConfirm={() => roomOp('dissolve', { roomId: room.id })}
                  />
                </div>
              )}
            </section>
          );
        })}
    </div>
  );
}
