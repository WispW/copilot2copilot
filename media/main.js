// @ts-check
const vscode = acquireVsCodeApi();

/** @type {any} */
let state = null;
/** @type {any} */
let draft = null;
/** 当前工作区档案（label 为空表示未打开工作区） */
let wsState = { label: '', identity: {} };

const missingIds = new Set();

/** 取元素；缺失时返回占位元素并上报一次，避免单个元素缺失导致后续脚本全部中断 */
const $ = id => {
  const el = document.getElementById(id);
  if (el) {
    return el;
  }
  if (!missingIds.has(id)) {
    missingIds.add(id);
    console.warn(`[talk2copilot] 缺少界面元素: ${id}`);
    try {
      vscode.postMessage({ type: 'uiError', message: `缺少界面元素: ${id}` });
    } catch {
      // 忽略上报失败
    }
  }
  return document.createElement('div');
};

window.addEventListener('error', event => {
  vscode.postMessage({ type: 'uiError', message: `${event.message} @${event.filename}:${event.lineno}` });
});

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'state') {
    state = msg.state;
    if (!draft || msg.resetDraft) {
      draft = JSON.parse(JSON.stringify(state.config));
      wsState = {
        label: state.workspaceLabel || '',
        identity: JSON.parse(JSON.stringify(state.workspaceIdentity || {})),
      };
      render();
    } else {
      mergeColleagues();
      if (state.workspaceLabel) {
        wsState.label = state.workspaceLabel;
      }
      renderStatus();
      renderInbox();
      // 重绘会重建 DOM，因此用焦点/光标保留包住，取代原先"聚焦就跳过重绘"的冻结做法
      withFocusPreserved(() => {
        renderConn();
        renderPeers();
        renderRooms();
        renderAdmin();
      });
    }
  }
});

/** 把服务端新出现的沟通方并入草稿（自动发现的结果）；只增不减，避免打断正在编辑的条目 */
function mergeColleagues() {
  const server = (state.config && state.config.colleagues) || [];
  draft.colleagues = draft.colleagues || [];
  const known = new Set(draft.colleagues.map(c => c.id));
  server.forEach(sc => {
    if (known.has(sc.id)) {
      return;
    }
    draft.colleagues.push({
      id: sc.id,
      role: sc.role,
      scope: sc.scope,
      relayPeerId: sc.relayPeerId,
      enabled: sc.enabled,
    });
  });
  syncReadonlyFields();
}

/** 重建 DOM 前后保留输入焦点与光标位置，让实时刷新不再需要"跳过重绘" */
function withFocusPreserved(renderFn) {
  const active = document.activeElement;
  const isInput = active && active.tagName === 'INPUT';
  const key = isInput ? `${active.dataset.i ?? ''}|${active.dataset.f ?? ''}|${active.id ?? ''}` : '';
  const start = isInput ? active.selectionStart : null;
  const end = isInput ? active.selectionEnd : null;
  renderFn();
  if (!key) {
    return;
  }
  const next = [...document.querySelectorAll('input')]
    .find(el => `${el.dataset.i ?? ''}|${el.dataset.f ?? ''}|${el.id ?? ''}` === key);
  if (!next) {
    return;
  }
  next.focus();
  if (typeof start === 'number' && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(start, end ?? start);
    } catch {
      // 数字/复选类输入不支持选区，忽略
    }
  }
}

/** 把服务端权威的只读字段（对方档案、停用状态）同步进正在编辑的 draft */
function syncReadonlyFields() {
  (state.config.colleagues || []).forEach(sc => {
    const dc = draft.colleagues.find(c => c.id === sc.id);
    if (!dc) {
      return;
    }
    dc.role = sc.role;
    dc.scope = sc.scope;
    // 停用状态以服务端为准：否则点「停用」后草稿不更新，界面永远停在原状态
    dc.enabled = sc.enabled !== false;
  });
}

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
    ['conn', 'peers', 'rooms', 'admin', 'inbox', 'behavior'].forEach(t => {
      $(`tab-${t}`).hidden = t !== btn.dataset.tab;
    });
    // 切到房间 / 管理页时顺手拉一次最新状态（可见性与封禁变化只在服务端）
    if (btn.dataset.tab === 'rooms') {
      vscode.postMessage({ type: 'refreshRooms' });
    }
    if (btn.dataset.tab === 'admin') {
      vscode.postMessage({ type: 'refreshAdmin' });
    }
  });
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) {
    return `${n} 字节`;
  }
  if (n < 1048576) {
    return `${(n / 1024).toFixed(1)} KiB`;
  }
  return `${(n / 1048576).toFixed(2)} MiB`;
}

function render() {
  renderStatus();
  renderConn();
  renderPeers();
  renderInbox();
  renderBehavior();
  renderRooms();
  renderAdmin();
}

function renderStatus() {
  const s = (state && state.status) || { state: 'stopped', detail: '' };
  const labels = { stopped: '已停止', connecting: '连接中', online: '已连接', offline: '离线' };
  $('status-dot').className = `dot ${s.state}`;
  $('status-text').textContent = `${labels[s.state] || s.state} · ${s.detail || ''}`;
}

function renderConn() {
  const cfg = draft;
  $('relay-url').value = cfg.relay.url;

  // 版本门禁：扩展与中继版本必须一致，否则中继拒绝接入（4008）
  const relay = (state && state.relayInfo) || { version: '', protocol: 0 };
  const mine = (state && state.extensionVersion) || '';
  $('relay-version').textContent = relay.version
    ? `中继运行版本：${relay.version}（协议 ${relay.protocol}）· 本机扩展版本：${mine}。两者必须一致，否则中继会拒绝接入。`
    : `本机扩展版本：${mine}。中继运行版本将在连接成功后显示；两者必须一致，否则中继会拒绝接入。`;

  // 档案恒按工作区保存：本机多窗口因此各有各的 id
  const hasWorkspace = Boolean(wsState.label);
  $('ws-label').textContent = hasWorkspace ? wsState.label : '（未打开工作区，档案仍随本窗口保存）';
  const src = wsState.identity || {};
  $('id-id').value = src.id ?? '';
  $('id-role').value = src.role ?? '';
  $('id-scope').value = src.scope ?? '';
  $('identity-hint').textContent = '本工作区档案按窗口独立保存；换一个工作区或另开一个窗口就是另一份档案。';

  const missing = state.identityMissing || [];
  const warn = $('identity-warning');
  warn.hidden = missing.length === 0;
  if (missing.length > 0) {
    warn.textContent = `请先完善“我的档案”：缺少 ${missing.join('、')}，未完成前无法与同事通信。`;
  }
}

/** 档案编辑目标：恒为当前工作区档案 */
function identityTarget() {
  return wsState.identity;
}

function renderBehavior() {
  $('wait-timeout').value = draft.behavior.waitTimeoutSec;
  $('history-limit').value = draft.behavior.historyLimit;
}

function renderPeers() {
  const el = $('peers');
  const all = draft.colleagues || [];
  const onlineIds = new Set(state?.onlineIds || []);
  const myId = (state && state.effectiveIdentity && state.effectiveIdentity.id) || '';
  // 列表由中继目录自动维护：只显示在线条目，且不显示指向自己（id 或中继 id 命中自己）的条目
  const rows = all.map((c, i) => ({ c, i }))
    .filter(({ c }) => c.id !== myId && c.relayPeerId !== myId)
    .filter(({ c }) => onlineIds.has(c.id));
  if (rows.length === 0) {
    el.innerHTML = '<p class="hint">当前没有在线的 Copilot。连上中继后，在线设备的条目会自动出现在这里（由中继下发）。</p>';
    return;
  }
  el.innerHTML = '';
  rows.forEach(({ c, i }) => {
    const profileReady = Boolean(c.role && c.scope);
    const disabled = c.enabled === false;
    const div = document.createElement('div');
    div.className = disabled ? 'peer disabled' : 'peer';
    div.innerHTML = `
      <div class="peer-head">
        <b>${escapeHtml(c.id || '（未设置 id）')}</b>
        <span class="hint">${profileReady ? '档案已同步' : '档案未同步'}</span>
        ${disabled ? '<span class="hint conflict">已停用</span>' : ''}
        <span style="flex:1"></span>
        <button class="small" data-toggle="${i}" title="停用后不参与通信，也不会出现在模型可见名单里">${disabled ? '启用' : '停用'}</button>
      </div>
      <p class="hint">角色：<b>${escapeHtml(c.role || '（等待中继同步）')}</b> · 负责内容：<b>${escapeHtml(c.scope || '（等待中继同步）')}</b></p>`;
    div.querySelector('button[data-toggle]').addEventListener('click', () => {
      const peer = draft.colleagues[i];
      vscode.postMessage({ type: 'toggleColleague', peerId: peer.id, enabled: peer.enabled === false });
    });
    el.appendChild(div);
  });
}

/** 房间 / 管理操作统一走中继控制面 */
function roomOp(op, payload) {
  vscode.postMessage({ type: 'roomOp', op, payload });
}

function adminOp(op, payload) {
  vscode.postMessage({ type: 'adminOp', op, payload });
}

/**
 * 危险操作的两步确认：VS Code webview 的沙箱会忽略原生 confirm()（静默返回 false），
 * 会让按钮"点了没反应"，因此改为"再点一次确认"。
 * 待确认状态存在内存里（键 → 到期时间），5 秒热刷新重绘不会丢失。
 */
const armedActions = new Map();

function isArmed(key) {
  const until = armedActions.get(key);
  return Boolean(until && until > Date.now());
}

/** @returns true 表示该操作已处于待确认状态，本次点击应真正执行 */
function armOrConfirm(key, ttlMs = 8000) {
  if (isArmed(key)) {
    armedActions.delete(key);
    return true;
  }
  armedActions.set(key, Date.now() + ttlMs);
  return false;
}

/** 展开了「管理」区的房间 id：界面每 5 秒热刷新重建 DOM，展开状态必须存在内存里才不会被打断 */
const expandedRooms = new Set();

function renderRooms() {
  const el = $('rooms');
  const rooms = (state && state.rooms) || [];
  const myId = (state && state.effectiveIdentity && state.effectiveIdentity.id) || '';
  const verified = Boolean(state && state.admin && state.admin.verified);
  if (rooms.length === 0) {
    el.innerHTML = '<p class="hint">当前中继上还没有房间。创建一个房间并把密码发给要通信的同事；对方加入后你们就能互相看到并通信。</p>';
    return;
  }
  el.innerHTML = '';
  rooms.forEach((room, i) => {
    const owner = room.ownerId === myId;
    const canManage = owner || verified;
    const chip = m => `<span class="chip${m === myId ? ' me' : ''}">${escapeHtml(m)}</span>`;
    const relayBanned = new Set(Array.isArray(room.bannedMembers) ? room.bannedMembers : []);
    const memberChips = Array.isArray(room.members)
      ? room.members.map(m => {
        const armed = isArmed(`kick:${room.id}:${m}`);
        const bannedHint = relayBanned.has(m) ? ' <span class="hint conflict">已被中继封禁（需管理员解封）</span>' : '';
        return `${chip(m)}${bannedHint}${canManage && m !== room.ownerId
          ? ` <button class="small${armed ? ' danger' : ''}" data-room-action="kick" data-member="${escapeHtml(m)}">${armed ? '确认移出' : '移出'}</button>`
          : ''}`;
      }).join(' ')
      : '';
    const memberSection = memberChips
      ? `<p class="hint">成员（${room.memberCount}）：</p><p>${memberChips}</p>`
      : `<p class="hint">成员：${room.memberCount} 人（加入后可查看明细）</p>`;
    const blockedSection = canManage && Array.isArray(room.blocked) && room.blocked.length > 0
      ? `<p class="hint">禁止再加入（解除后可凭密码重新加入）：</p><p>${room.blocked.map(m => `${chip(m)} <button class="small" data-room-action="unblock" data-member="${escapeHtml(m)}">解除</button>`).join(' ')}</p>`
      : '';
    const manageForm = canManage ? `
      <label>改名 <input data-room-input="rename" placeholder="${escapeHtml(room.name)}" maxlength="32"> <button class="small" data-room-action="rename">保存</button></label>
      <label>改密码 <input data-room-input="passwd" type="password" placeholder="留空表示清除密码"> <button class="small" data-room-action="passwd">保存</button></label>` : '';
    const dissolveArmed = isArmed(`dissolve:${room.id}`);
    // 成员与「移出」直接显示在卡片上（不藏在折叠区里）；改名/改密码/禁止名单/解散放进可折叠的管理区
    const manageBox = canManage
      ? `<div class="room-manage"${expandedRooms.has(room.id) ? '' : ' hidden'}>${manageForm}${blockedSection}<button class="small danger" data-room-action="dissolve">${dissolveArmed ? '确认解散？' : '解散房间'}</button></div>`
      : '';
    const badges = [
      room.hasPassword ? '<span class="hint">🔒 有密码</span>' : '',
      room.joined ? '<span class="hint">已加入</span>' : '',
      owner ? '<span class="hint">所有者</span>' : (verified ? '<span class="hint">管理员</span>' : ''),
    ].filter(Boolean).join(' ');
    const joinBox = !room.joined
      ? `<label>密码 <input data-room-input="join-password" type="password" placeholder="${room.hasPassword ? '输入房间密码' : '无需密码'}"></label>
         <button class="small" data-room-action="join">加入</button>`
      : (owner ? '' : '<button class="small" data-room-action="leave">退出</button>');
    const div = document.createElement('div');
    div.className = 'room';
    div.dataset.room = String(i);
    div.innerHTML = `
      <div class="peer-head">
        <b>${escapeHtml(room.name)}</b>
        <span class="hint">所有者 ${escapeHtml(room.ownerId)}</span>
        ${badges}
        <span style="flex:1"></span>
        ${joinBox}
        ${canManage ? '<button class="small" data-room-action="manage">管理</button>' : ''}
      </div>
      ${memberSection}
      ${manageBox}`;
    el.appendChild(div);
  });
}

function renderAdmin() {
  const admin = (state && state.admin) || { tokenSet: false, verified: false, devices: [], bans: [] };
  const relay = (state && state.relayInfo) || { version: '', protocol: 0 };
  const hint = $('admin-hint');
  if (!admin.tokenSet) {
    hint.textContent = '未设置中继管理令牌：到「连接」页填写并保存后，即可查看/踢出/封禁在线设备，并对所有房间拥有所有者权限。';
  } else if (!admin.verified) {
    hint.textContent = '管理令牌未通过验证：请确认与中继配置的 TALK2COPILOT_ADMIN_TOKEN 一致；若中继未配置该变量，管理功能整体不可用。';
  } else {
    hint.textContent = `管理权限已生效${relay.version ? `（中继版本 ${relay.version}，协议 ${relay.protocol}）` : ''}。封禁后设备会从「在线设备」消失，可在下方「封禁名单」解除；解封后对方会在 60 秒内自动重连。注意：本页设备列表不受房间限制（供管理使用），但你的通信与 Copilot 列表仍受房间约束。`;
  }
  const devices = admin.devices || [];
  const rooms = (state && state.rooms) || [];
  const roomNameOf = id => {
    const room = rooms.find(r => r.id === id);
    return room ? room.name : id;
  };
  $('admin-devices').innerHTML = devices.length === 0
    ? '<p class="hint">（无在线设备，或尚未获得管理权限）</p>'
    : devices.map(d => {
      const kickArmed = isArmed(`devkick:${d.id}`);
      const banArmed = isArmed(`ban:${d.id}`);
      const roomChips = (d.roomIds || []).map(rid => {
        const armed = isArmed(`roomkick:${rid}:${d.id}`);
        return `<span class="chip">${escapeHtml(roomNameOf(rid))}</span> <button class="small${armed ? ' danger' : ''}" data-admin-action="roomkick" data-room="${escapeHtml(rid)}" data-device="${escapeHtml(d.id)}">${armed ? '确认移出' : '移出'}</button>`;
      }).join(' ');
      return `<div class="peer">
        <div class="peer-head">
          <b>${escapeHtml(d.id)}</b>
          <span class="hint">扩展 ${escapeHtml(d.version)}</span>
          ${d.admin ? '<span class="hint">管理员</span>' : ''}
          <span style="flex:1"></span>
          <button class="small${kickArmed ? ' danger' : ''}" data-admin-action="kick" data-device="${escapeHtml(d.id)}">${kickArmed ? '确认踢出中继' : '踢出中继'}</button>
          <button class="small danger" data-admin-action="ban" data-device="${escapeHtml(d.id)}">${banArmed ? '确认封禁' : '封禁'}</button>
        </div>
        <p class="hint">所在房间：${roomChips || '（无）'}</p>
      </div>`;
    }).join('');

  // 房间移出名单：由各房间的 blocked 列表汇总（管理员对所有房间可见）
  const roomBlocks = [];
  for (const room of rooms) {
    for (const member of (Array.isArray(room.blocked) ? room.blocked : [])) {
      roomBlocks.push({ roomId: room.id, roomName: room.name, member });
    }
  }
  $('admin-room-blocks').innerHTML = roomBlocks.length === 0
    ? '<p class="hint">（没有房间移出记录）</p>'
    : roomBlocks.map(b => `<div class="peer">
        <div class="peer-head">
          <b>${escapeHtml(b.member)}</b>
          <span class="hint">已被移出房间「${escapeHtml(b.roomName)}」</span>
          <span style="flex:1"></span>
          <button class="small" data-admin-action="roomunblock" data-room="${escapeHtml(b.roomId)}" data-member="${escapeHtml(b.member)}">解除（允许再加入）</button>
        </div>
      </div>`).join('');
  const bans = admin.bans || [];
  $('admin-bans').innerHTML = bans.length === 0
    ? '<p class="hint">（无封禁设备）</p>'
    : bans.map(id => `<div class="peer"><div class="peer-head"><b>${escapeHtml(id)}</b><span style="flex:1"></span><button class="small" data-admin-action="unban" data-device="${escapeHtml(id)}">解除封禁</button></div></div>`).join('');
}

function renderOnline() {
  if (!draft || $('tab-peers').hidden) {
    return;
  }
  renderPeers();
}

function renderInbox() {
  const items = (state && state.messages) || [];
  const el = $('inbox');
  if (items.length === 0) {
    el.innerHTML = '<p class="hint">暂无消息。</p>';
    return;
  }
  el.innerHTML = items.map(m => {
    const dir = m.direction === 'in' ? '收到' : '发出';
    const status = m.done
      ? (m.direction === 'in' ? '已回复' : '已收到回复')
      : (m.direction === 'in' ? '未回复' : '等待回复');
    const time = new Date(m.ts).toLocaleString();
    const snippet = m.snippet
      ? `<details><summary>代码片段</summary><pre class="body">${escapeHtml(m.snippet)}</pre></details>`
      : '';
    const file = m.file
      ? `<div class="file">文件：<b>${escapeHtml(m.file.name)}</b>（${formatSize(m.file.size)}，sha256 ${escapeHtml(String(m.file.sha256 || '').slice(0, 12))}…）${m.direction === 'in' && m.file.path ? `<br>已保存到：<code>${escapeHtml(m.file.path)}</code>` : ''}</div>`
      : '';
    const reply = m.direction === 'out' && m.replyText
      ? `<div class="reply">对方回复：${escapeHtml(m.replyText)}</div>`
      : '';
    const body = m.text ? `<pre class="body">${escapeHtml(m.text)}</pre>` : '';
    return `<div class="msg ${m.direction}">
      <div class="msg-head">
        <span class="badge">${dir}</span>
        <b>${escapeHtml(m.peerId)}</b>
        <span class="hint">${time} · ${status} · ${escapeHtml(m.id)}</span>
      </div>
      ${body}
      ${file}
      ${snippet}
      ${reply}
    </div>`;
  }).join('');
}

$('btn-save').addEventListener('click', () => {
  vscode.postMessage({
    type: 'save',
    config: draft,
    identity: wsState.identity,
    token: $('token').value,
    adminToken: $('admin-token').value,
  });
  $('token').value = '';
  $('admin-token').value = '';
});

$('btn-reload').addEventListener('click', () => {
  draft = JSON.parse(JSON.stringify(state.config));
  render();
});

$('btn-logs').addEventListener('click', () => {
  vscode.postMessage({ type: 'showLogs' });
});

$('btn-open-files').addEventListener('click', () => {
  vscode.postMessage({ type: 'openFilesDir' });
});

$('btn-save-template').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveTemplate' });
});

$('btn-reset-loop').addEventListener('click', () => {
  vscode.postMessage({ type: 'resetLoopGuard' });
});

$('btn-clear-history').addEventListener('click', () => {
  vscode.postMessage({ type: 'clearHistory' });
});

$('btn-create-room').addEventListener('click', () => {
  const name = $('room-name').value.trim();
  if (!name) {
    // 不再静默返回：空名时明确提示，避免"点了没反应"
    vscode.postMessage({ type: 'uiHint', message: '请先填写新房间名，再点「创建房间」' });
    return;
  }
  roomOp('create', { name, password: $('room-password').value });
  $('room-name').value = '';
  $('room-password').value = '';
});

$('btn-refresh-rooms').addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshRooms' });
});

$('btn-refresh-admin').addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshAdmin' });
});

// 房间卡片内的按钮（内容动态重建，走事件委托）
$('rooms').addEventListener('click', event => {
  const btn = event.target.closest('button[data-room-action]');
  if (!btn) {
    return;
  }
  const card = btn.closest('.room');
  const index = Number(card && card.dataset.room);
  const room = ((state && state.rooms) || [])[index];
  if (!room) {
    return;
  }
  const input = key => {
    const el = card.querySelector(`input[data-room-input="${key}"]`);
    return el ? el.value : '';
  };
  const action = btn.dataset.roomAction;
  if (action === 'join') {
    roomOp('join', { roomId: room.id, password: input('join-password') });
  } else if (action === 'leave') {
    roomOp('leave', { roomId: room.id });
  } else if (action === 'manage') {
    if (expandedRooms.has(room.id)) {
      expandedRooms.delete(room.id);
    } else {
      expandedRooms.add(room.id);
    }
    renderRooms();
  } else if (action === 'rename') {
    const name = input('rename').trim();
    if (name) {
      roomOp('rename', { roomId: room.id, name });
    }
  } else if (action === 'passwd') {
    roomOp('passwd', { roomId: room.id, password: input('passwd') });
  } else if (action === 'kick') {
    if (armOrConfirm(`kick:${room.id}:${btn.dataset.member}`)) {
      roomOp('kick', { roomId: room.id, memberId: btn.dataset.member });
    } else {
      renderRooms();
    }
  } else if (action === 'unblock') {
    roomOp('unblock', { roomId: room.id, memberId: btn.dataset.member });
  } else if (action === 'dissolve') {
    if (armOrConfirm(`dissolve:${room.id}`)) {
      roomOp('dissolve', { roomId: room.id });
    } else {
      renderRooms();
    }
  }
});

// 管理页按钮（内容动态重建，走事件委托）
$('admin-devices').addEventListener('click', event => {
  const btn = event.target.closest('button[data-admin-action]');
  if (!btn) {
    return;
  }
  const target = btn.dataset.device;
  const action = btn.dataset.adminAction;
  if (action === 'kick') {
    if (armOrConfirm(`devkick:${target}`)) {
      adminOp('kick', { target });
    } else {
      renderAdmin();
    }
  } else if (action === 'ban') {
    if (armOrConfirm(`ban:${target}`)) {
      adminOp('ban', { target });
    } else {
      renderAdmin();
    }
  } else if (action === 'roomkick') {
    // 把某个成员从指定房间踢出（两步确认）
    const roomId = btn.dataset.room;
    if (armOrConfirm(`roomkick:${roomId}:${target}`)) {
      roomOp('kick', { roomId, memberId: target });
    } else {
      renderAdmin();
    }
  }
});

// 房间移出名单：解除后该成员可凭密码重新加入
$('admin-room-blocks').addEventListener('click', event => {
  const btn = event.target.closest('button[data-admin-action="roomunblock"]');
  if (btn) {
    roomOp('unblock', { roomId: btn.dataset.room, memberId: btn.dataset.member });
  }
});

$('admin-bans').addEventListener('click', event => {
  const btn = event.target.closest('button[data-admin-action="unban"]');
  if (btn) {
    adminOp('unban', { target: btn.dataset.device });
  }
});

$('relay-url').addEventListener('input', () => {
  draft.relay.url = $('relay-url').value.trim();
});
$('id-id').addEventListener('input', () => {
  identityTarget().id = $('id-id').value.trim();
});
$('id-role').addEventListener('input', () => {
  identityTarget().role = $('id-role').value.trim();
});
$('id-scope').addEventListener('input', () => {
  identityTarget().scope = $('id-scope').value.trim();
});
$('wait-timeout').addEventListener('input', () => {
  draft.behavior.waitTimeoutSec = Number($('wait-timeout').value) || 90;
});
$('history-limit').addEventListener('input', () => {
  draft.behavior.historyLimit = Number($('history-limit').value) || 200;
});

vscode.postMessage({ type: 'ready' });
