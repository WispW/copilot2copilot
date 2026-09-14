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
