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
      });
      renderScanHint();
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
      lanAddr: sc.lanAddr,
      lanAddrSource: sc.lanAddrSource,
      relayPeerId: sc.relayPeerId,
      source: sc.source,
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

/** 「扫描局域网」按钮只在局域网模式有意义 */
function renderScanHint() {
  const btn = $('btn-scan-lan');
  btn.hidden = draft.mode !== 'lan';
}

/** 把服务端权威的只读字段（对方档案、自动学习的地址）同步进正在编辑的 draft */
function syncReadonlyFields() {
  (state.config.colleagues || []).forEach(sc => {
    const dc = draft.colleagues.find(c => c.id === sc.id);
    if (!dc) {
      return;
    }
    dc.role = sc.role;
    dc.scope = sc.scope;
    // 用户没动过地址就跟随服务端，否则过期的草稿会把自动纠正过的地址又写回去
    if (!dc.lanAddrEdited) {
      dc.lanAddr = sc.lanAddr;
      dc.lanAddrSource = sc.lanAddrSource;
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
  renderScanHint();
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

  // 档案恒按工作区保存：本机多窗口因此各有各的 id
  const hasWorkspace = Boolean(wsState.label);
  $('ws-label').textContent = hasWorkspace ? wsState.label : '（未打开工作区，档案仍随本窗口保存）';
  const src = wsState.identity || {};
  $('id-id').value = src.id ?? '';
  $('id-role').value = src.role ?? '';
  $('id-scope').value = src.scope ?? '';
  $('identity-hint').textContent = '本工作区档案按窗口独立保存；换一个工作区或另开一个窗口就是另一份档案。';

  $('my-addrs').textContent = (state.myAddresses || []).join('  ');
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
  const peers = draft.colleagues || [];
  if (peers.length === 0) {
    el.innerHTML = '<p class="hint">暂无沟通方。连上中继或同一网段的对等端会被自动发现并加入；也可以点「添加」手工填写。</p>';
    return;
  }
  el.innerHTML = '';
  peers.forEach((c, i) => {
    const online = (state.onlineIds || []).includes(c.id);
    const profileReady = Boolean(c.role && c.scope);
    const selfConflict = Boolean(c.id) && c.id === draft.identity.id;
    const disabled = c.enabled === false;
    const auto = c.source === 'auto';
    const div = document.createElement('div');
    div.className = disabled ? 'peer disabled' : 'peer';
    div.innerHTML = `
      <div class="peer-head">
        <b>${escapeHtml(c.id || '（未设置 id）')}</b>
        <span class="hint online ${online ? 'yes' : ''}">${online ? '在线' : '离线'}</span>
        <span class="hint">${profileReady ? '档案已同步' : '档案未同步'}</span>
        ${auto ? '<span class="hint">自动发现</span>' : ''}
        ${disabled ? '<span class="hint conflict">已停用</span>' : ''}
        ${selfConflict ? '<span class="hint conflict">对方 id 与我的 id 相同，这里要填对方的 id</span>' : ''}
        <span style="flex:1"></span>
        <button class="small" data-toggle="${i}" title="停用后不参与通信，也不会出现在模型可见名单里">${disabled ? '启用' : '停用'}</button>
        ${auto ? '' : `<button class="danger small" data-del="${i}">删除</button>`}
      </div>
      <div class="grid">
        <label>对方 id <input data-i="${i}" data-f="id" value="${escapeHtml(c.id)}" placeholder="与对方“本工作区档案”中的 id 一致"></label>
        <label>局域网地址${c.lanAddrSource === 'auto' && c.lanAddr ? '（自动发现/学习，可能不可回连）' : ''} <input data-i="${i}" data-f="lanAddr" value="${escapeHtml(c.lanAddr)}" placeholder="192.168.5.40:3901（可只填 IP）"></label>
        <label>中继 id <input data-i="${i}" data-f="relayPeerId" value="${escapeHtml(c.relayPeerId)}" placeholder="对方在中继上的 id"></label>
        <label>角色（自动同步） <input value="${escapeHtml(c.role)}" readonly placeholder="等待对方同步"></label>
        <label>负责内容（自动同步） <input value="${escapeHtml(c.scope)}" readonly placeholder="等待对方同步"></label>
      </div>`;
    div.querySelectorAll('input[data-f]').forEach(inp => {
      inp.addEventListener('input', () => {
        const peer = draft.colleagues[Number(inp.dataset.i)];
        peer[inp.dataset.f] = inp.value;
        if (inp.dataset.f === 'lanAddr') {
          peer.lanAddrEdited = true;
        }
      });
    });
    const delBtn = div.querySelector('button[data-del]');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        const id = draft.colleagues[i].id;
        // 立即持久化删除，避免 5 秒热刷新把服务端仍存在的条目并回草稿（“删除复活”）
        vscode.postMessage({ type: 'removeColleague', peerId: id });
        draft.colleagues.splice(i, 1);
        renderPeers();
      });
    }
    div.querySelector('button[data-toggle]').addEventListener('click', () => {
      const peer = draft.colleagues[i];
      vscode.postMessage({ type: 'toggleColleague', peerId: peer.id, enabled: peer.enabled === false });
    });
    el.appendChild(div);
  });
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
  vscode.postMessage({
    type: 'save',
    config: draft,
    identity: wsState.identity,
    token: $('token').value,
  });
  $('token').value = '';
});

$('btn-reload').addEventListener('click', () => {
  draft = JSON.parse(JSON.stringify(state.config));
  render();
});

$('btn-logs').addEventListener('click', () => {
  vscode.postMessage({ type: 'showLogs' });
});

$('btn-scan-lan').addEventListener('click', () => {
  vscode.postMessage({ type: 'scanLan' });
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
    renderScanHint();
  });
});

$('lan-port').addEventListener('input', () => {
  draft.lan.listenPort = Number($('lan-port').value) || 3901;
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
