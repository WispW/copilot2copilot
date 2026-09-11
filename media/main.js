// @ts-check
const vscode = acquireVsCodeApi();

/** @type {any} */
let state = null;
/** @type {any} */
let draft = null;
/** 当前工作区档案（label 为空表示未打开工作区） */
let wsState = { label: '', identity: {} };
/** 是否为本工作区保存独立档案 */
let wsOverride = false;

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
      wsOverride = Boolean(wsState.identity.id || wsState.identity.role || wsState.identity.scope);
      render();
    } else {
      syncReadonlyFields();
      if (state.workspaceLabel) {
        wsState.label = state.workspaceLabel;
      }
      renderStatus();
      renderInbox();
      renderOnline();
      // 热刷新时重绘档案区，但避免打断正在输入的内容
      const focused = document.activeElement;
      if (!focused || (focused.tagName !== 'INPUT' && focused.tagName !== 'SELECT')) {
        renderConn();
      }
    }
  }
});

/** 把服务端权威的只读字段（对方档案、自动补全的地址）同步进正在编辑的 draft */
function syncReadonlyFields() {
  (state.config.colleagues || []).forEach(sc => {
    const dc = draft.colleagues.find(c => c.id === sc.id);
    if (!dc) {
      return;
    }
    dc.role = sc.role;
    dc.scope = sc.scope;
    if (!dc.lanAddr) {
      dc.lanAddr = sc.lanAddr;
    }
  });
}

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
    ['conn', 'peers', 'inbox', 'behavior'].forEach(t => {
      $(`tab-${t}`).hidden = t !== btn.dataset.tab;
    });
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

function render() {
  renderStatus();
  renderConn();
  renderPeers();
  renderInbox();
  renderBehavior();
}

function renderStatus() {
  const s = (state && state.status) || { state: 'stopped', detail: '' };
  const labels = { stopped: '已停止', connecting: '连接中', online: '已连接', offline: '离线' };
  $('status-dot').className = `dot ${s.state}`;
  $('status-text').textContent = `${labels[s.state] || s.state} · ${s.detail || ''}`;
}

function renderConn() {
  const cfg = draft;
  document.querySelectorAll('input[name="mode"]').forEach(el => {
    el.checked = el.value === cfg.mode;
  });
  $('lan-fields').hidden = cfg.mode !== 'lan';
  $('relay-fields').hidden = cfg.mode !== 'relay';
  $('lan-port').value = cfg.lan.listenPort;
  $('relay-url').value = cfg.relay.url;
  $('relay-myid').value = cfg.relay.myPeerId;

  // 我的档案：默认档案 或 当前工作区独立档案
  const hasWorkspace = Boolean(wsState.label);
  const overrideEl = $('ws-override');
  overrideEl.disabled = !hasWorkspace;
  overrideEl.checked = wsOverride && hasWorkspace;
  $('ws-label').textContent = hasWorkspace ? wsState.label : '（未打开工作区，使用默认档案）';
  const src = wsOverride && hasWorkspace ? (wsState.identity || {}) : cfg.identity;
  const fallback = cfg.identity;
  $('id-id').value = src.id ?? fallback.id ?? '';
  $('id-role').value = src.role ?? fallback.role ?? '';
  $('id-scope').value = src.scope ?? fallback.scope ?? '';
  $('identity-hint').textContent = wsOverride && hasWorkspace
    ? '正在编辑该工作区的独立档案；留空的项会继承默认档案'
    : '正在编辑默认档案（所有未设置独立档案的工作区共用）';

  $('my-addrs').textContent = (state.myAddresses || []).join('  ');
  const missing = state.identityMissing || [];
  const warn = $('identity-warning');
  warn.hidden = missing.length === 0;
  if (missing.length > 0) {
    warn.textContent = `请先完善“我的档案”：缺少 ${missing.join('、')}，未完成前无法与同事通信。`;
  }
}

/** 当前编辑目标：工作区独立档案 或 默认档案 */
function identityTarget() {
  return wsOverride && wsState.label ? wsState.identity : draft.identity;
}

function renderBehavior() {
  $('wait-timeout').value = draft.behavior.waitTimeoutSec;
  $('history-limit').value = draft.behavior.historyLimit;
}

function renderPeers() {
  const el = $('peers');
  const peers = draft.colleagues || [];
  if (peers.length === 0) {
    el.innerHTML = '<p class="hint">尚未添加沟通方。填上对方的 id 与地址即可（对方的角色与负责内容会在连接后自动同步）。</p>';
    return;
  }
  el.innerHTML = '';
  peers.forEach((c, i) => {
    const online = (state.onlineIds || []).includes(c.id);
    const profileReady = Boolean(c.role && c.scope);
    const selfConflict = Boolean(c.id) && c.id === draft.identity.id;
    const div = document.createElement('div');
    div.className = 'peer';
    div.innerHTML = `
      <div class="peer-head">
        <b>${escapeHtml(c.id || '（未设置 id）')}</b>
        <span class="hint online ${online ? 'yes' : ''}">${online ? '在线' : '离线'}</span>
        <span class="hint">${profileReady ? '档案已同步' : '档案未同步'}</span>
        ${selfConflict ? '<span class="hint conflict">对方 id 与我的 id 相同，这里要填对方的 id</span>' : ''}
        <span style="flex:1"></span>
        <button class="small" data-connect="${i}" title="立即尝试连接该同事">连接</button>
        <button class="danger small" data-del="${i}">删除</button>
      </div>
      <div class="grid">
        <label>对方 id <input data-i="${i}" data-f="id" value="${escapeHtml(c.id)}" placeholder="与对方“我的档案”中的 id 一致"></label>
        <label>局域网地址 <input data-i="${i}" data-f="lanAddr" value="${escapeHtml(c.lanAddr)}" placeholder="192.168.5.40:3901（可只填 IP）"></label>
        <label>中继 id <input data-i="${i}" data-f="relayPeerId" value="${escapeHtml(c.relayPeerId)}" placeholder="对方在中继上的 id"></label>
        <label>角色（自动同步） <input value="${escapeHtml(c.role)}" readonly placeholder="等待对方同步"></label>
        <label>负责内容（自动同步） <input value="${escapeHtml(c.scope)}" readonly placeholder="等待对方同步"></label>
      </div>`;
    div.querySelectorAll('input[data-f]').forEach(inp => {
      inp.addEventListener('input', () => {
        draft.colleagues[Number(inp.dataset.i)][inp.dataset.f] = inp.value;
      });
    });
    div.querySelector('button[data-del]').addEventListener('click', () => {
      draft.colleagues.splice(i, 1);
      renderPeers();
    });
    div.querySelector('button[data-connect]').addEventListener('click', event => {
      const btn = event.currentTarget;
      vscode.postMessage({ type: 'connectPeer', peerId: draft.colleagues[i].id });
      btn.textContent = '连接中…';
      btn.disabled = true;
      // 状态推送不一定每次都触发重绘，这里兜底恢复按钮
      setTimeout(() => {
        if (btn.isConnected) {
          btn.textContent = '连接';
          btn.disabled = false;
        }
      }, 3000);
    });
    el.appendChild(div);
  });
}

function renderOnline() {
  if (!draft || $('tab-peers').hidden) {
    return;
  }
  // 在线状态刷新：用户正在输入框中编辑时暂不重建，避免打断输入
  const focused = document.activeElement;
  if (focused && focused.tagName === 'INPUT') {
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
    const reply = m.direction === 'out' && m.replyText
      ? `<div class="reply">对方回复：${escapeHtml(m.replyText)}</div>`
      : '';
    return `<div class="msg ${m.direction}">
      <div class="msg-head">
        <span class="badge">${dir}</span>
        <b>${escapeHtml(m.peerId)}</b>
        <span class="hint">${time} · ${status} · ${escapeHtml(m.id)}</span>
      </div>
      <pre class="body">${escapeHtml(m.text)}</pre>
      ${snippet}
      ${reply}
    </div>`;
  }).join('');
}

$('btn-save').addEventListener('click', () => {
  const useWorkspace = wsOverride && Boolean(wsState.label);
  vscode.postMessage({
    type: 'save',
    config: draft,
    identity: useWorkspace ? wsState.identity : undefined,
    workspaceOverride: useWorkspace,
    token: $('token').value,
  });
  $('token').value = '';
});

$('btn-reload').addEventListener('click', () => {
  draft = JSON.parse(JSON.stringify(state.config));
  render();
});

$('btn-test').addEventListener('click', () => {
  vscode.postMessage({ type: 'restart' });
});

$('btn-logs').addEventListener('click', () => {
  vscode.postMessage({ type: 'showLogs' });
});

$('btn-clear-history').addEventListener('click', () => {
  vscode.postMessage({ type: 'clearHistory' });
});

$('btn-add-peer').addEventListener('click', () => {
  draft.colleagues.push({
    id: `peer${Date.now().toString(36)}`,
    role: '',
    scope: '',
    lanAddr: '',
    relayPeerId: '',
  });
  renderPeers();
});

document.querySelectorAll('input[name="mode"]').forEach(el => {
  el.addEventListener('change', () => {
    if (!el.checked) {
      return;
    }
    draft.mode = el.value;
    $('lan-fields').hidden = draft.mode !== 'lan';
    $('relay-fields').hidden = draft.mode !== 'relay';
  });
});

$('lan-port').addEventListener('input', () => {
  draft.lan.listenPort = Number($('lan-port').value) || 3901;
});
$('relay-url').addEventListener('input', () => {
  draft.relay.url = $('relay-url').value.trim();
});
$('relay-myid').addEventListener('input', () => {
  draft.relay.myPeerId = $('relay-myid').value.trim();
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
$('ws-override').addEventListener('change', () => {
  wsOverride = $('ws-override').checked;
  if (wsOverride && wsState.label && !wsState.identity) {
    wsState.identity = {};
  }
  renderConn();
});
$('wait-timeout').addEventListener('input', () => {
  draft.behavior.waitTimeoutSec = Number($('wait-timeout').value) || 90;
});
$('history-limit').addEventListener('input', () => {
  draft.behavior.historyLimit = Number($('history-limit').value) || 200;
});

vscode.postMessage({ type: 'ready' });
