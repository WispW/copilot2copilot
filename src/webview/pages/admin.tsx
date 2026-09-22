import { Chip, ConfirmButton, Hint, Section } from '../components';
import { post } from '../api';
import type { Snapshot } from '../state';
import type { TabId } from '../app';

export function AdminPage({ snap, onGoto }: { snap: Snapshot; onGoto(tab: TabId): void }) {
  const state = snap.state;
  if (!state) {
    return null;
  }
  const admin = state.admin;
  const relay = state.relayInfo;
  const rooms = state.rooms;
  const roomNameOf = (id: string): string => rooms.find(room => room.id === id)?.name ?? id;
  const adminOp = (op: string, payload: Record<string, unknown>): void => post({ type: 'adminOp', op, payload });
  const roomOp = (op: string, payload: Record<string, unknown>): void => post({ type: 'roomOp', op, payload });

  // 房间移出名单：由各房间的 blocked 列表汇总（管理员对所有房间可见）
  const blocks: { roomId: string; roomName: string; member: string }[] = [];
  for (const room of rooms) {
    for (const member of (Array.isArray(room.blocked) ? room.blocked : [])) {
      blocks.push({ roomId: room.id, roomName: room.name, member });
    }
  }

  return (
    <div>
      <Section title="管理权限" extra={<button onClick={() => post({ type: 'refreshAdmin' })}>刷新</button>}>
        {!admin.tokenSet && (
          <div class="banner">
            未设置中继管理令牌。到「连接」页填写「中继管理令牌」并保存后，即可查看 / 踢出 / 封禁在线设备，并对所有房间拥有所有者权限。
            <button class="small" onClick={() => onGoto('conn')}>去连接页填写</button>
          </div>
        )}
        {admin.tokenSet && !admin.verified && (
          <div class="banner">
            管理令牌未通过验证：请确认与中继配置的 TALK2COPILOT_ADMIN_TOKEN 一致；若中继未配置该变量，管理功能整体不可用。
            <button class="small" onClick={() => onGoto('conn')}>去连接页修改</button>
          </div>
        )}
        {admin.verified && (
          <Hint>
            管理权限已生效{relay.version ? `（中继版本 ${relay.version}，协议 ${relay.protocol}）` : ''}。
            本页设备列表不受房间限制（供管理使用），但你的通信与 Copilot 列表仍受房间约束。
          </Hint>
        )}
      </Section>

      <Section title="在线设备">
        <Hint>「移出」把该设备从<strong>指定房间</strong>踢出；「踢出中继 / 封禁」是设备级操作，均需再点一次确认。</Hint>
        {admin.devices.length === 0 && <p class="hint">（无在线设备，或尚未获得管理权限）</p>}
        {admin.devices.map(device => (
          <div class="peer" key={device.id}>
            <div class="peer-head">
              <b>{device.id}</b>
              <span class="hint">扩展 {device.version}</span>
              {device.admin && <span class="hint">管理员</span>}
              <span class="grow"></span>
              <ConfirmButton
                label="踢出中继"
                confirmLabel="确认踢出中继"
                onConfirm={() => adminOp('kick', { target: device.id })}
              />
              <ConfirmButton
                label="封禁"
                confirmLabel="确认封禁"
                danger
                onConfirm={() => adminOp('ban', { target: device.id })}
              />
            </div>
            <p class="chips">
              <span class="hint">所在房间：</span>
              {(device.roomIds ?? []).length === 0 && <span class="hint">（无）</span>}
              {(device.roomIds ?? []).map(roomId => (
                <span class="member" key={roomId}>
                  <Chip>{roomNameOf(roomId)}</Chip>
                  <ConfirmButton
                    label="移出"
                    confirmLabel="确认移出"
                    onConfirm={() => roomOp('kick', { roomId, memberId: device.id })}
                  />
                </span>
              ))}
            </p>
          </div>
        ))}
      </Section>

      <Section title="房间移出名单">
        <Hint>被移出房间的成员无法再凭密码加入，只能在这里由管理员（或房间所有者）解除；这与下面的「中继封禁」是两回事。</Hint>
        {blocks.length === 0 && <p class="hint">（没有房间移出记录）</p>}
        {blocks.map(block => (
          <div class="peer" key={`${block.roomId}:${block.member}`}>
            <div class="peer-head">
              <b>{block.member}</b>
              <span class="hint">已被移出房间「{block.roomName}」</span>
              <span class="grow"></span>
              <button
                class="small"
                onClick={() => roomOp('unblock', { roomId: block.roomId, memberId: block.member })}
              >解除（允许再加入）</button>
            </div>
          </div>
        ))}
      </Section>

      <Section title="中继封禁名单">
        <Hint>
          封禁的设备会被断开且无法接入，因此会从上面的在线列表消失，但仍列在这里；
          解封后对方不会自动重连（本扩展不做自动重连），需对方手动点「重试连接」。
        </Hint>
        {admin.bans.length === 0 && <p class="hint">（无封禁设备）</p>}
        {admin.bans.map(id => (
          <div class="peer" key={id}>
            <div class="peer-head">
              <b>{id}</b>
              <span class="grow"></span>
              <button class="small" onClick={() => adminOp('unban', { target: id })}>解除封禁</button>
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
