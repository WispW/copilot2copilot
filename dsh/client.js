/**
 * Client half: a sidebar entry plus its main panel.
 *
 * Reads the host half through /copilot2copilot/state, which mirrors the relay
 * connection the host holds. No second relay connection is made here.
 */
window.__ModuleLoader__.load({
  id: '@local/copilot2copilot-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const C2C_CSS = `
      .c2c-root {
        --c2c-border: var(--dsh-border-weak, rgba(128,128,128,0.28));
        --c2c-card: var(--dsh-surface, rgba(127,127,127,0.06));
        --c2c-muted: var(--dsh-text-weak, rgba(128,128,128,0.95));
        height: 100%; display: flex; flex-direction: column; font-size: 13px; color: inherit;
      }
      .c2c-header { flex: none; display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 10px 16px; border-bottom: 1px solid var(--c2c-border); }
      .c2c-title { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
      .c2c-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--c2c-muted); border: 1px solid var(--c2c-border); border-radius: 999px; padding: 2px 10px; white-space: nowrap; }
      .c2c-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--c2c-muted); }
      .c2c-dot.online { background: #3fb950; }
      .c2c-dot.connecting { background: #d29922; animation: c2c-pulse 1.2s ease-in-out infinite; }
      .c2c-dot.offline, .c2c-dot.stopped { background: #f85149; }
      @keyframes c2c-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      .c2c-layout { flex: 1; min-height: 0; display: flex; }
      .c2c-nav { flex: none; width: 168px; display: flex; flex-direction: column; gap: 2px; padding: 10px; border-right: 1px solid var(--c2c-border); overflow-y: auto; }
      .c2c-nav button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: none; border-radius: 4px; background: none; background-image: none; color: inherit; font: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer; }
      .c2c-nav button:hover { background: rgba(127,127,127,.14); }
      .c2c-nav button.active { background: rgba(127,127,127,.22); }
      .c2c-nav .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .c2c-nav .count { flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 8px; background: rgba(127,127,127,.18); }
      .c2c-nav .count.alert { background: rgba(248,81,73,.18); color: #f85149; }
      .c2c-nav .foot { margin-top: auto; padding: 10px 8px 2px; border-top: 1px solid var(--c2c-border); display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--c2c-muted); }
      .c2c-main { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px 40px; }
      .c2c-page { display: flex; flex-direction: column; gap: 12px; }
      .c2c-card { background: var(--c2c-card); border: 1px solid var(--c2c-border); border-radius: 6px; padding: 12px 14px; }
      .c2c-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      .c2c-card-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
      .c2c-hint { color: var(--c2c-muted); font-size: 12px; margin: 4px 0; line-height: 1.5; }
      .c2c-badge { font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: 8px; background: rgba(127,127,127,.18); color: inherit; white-space: nowrap; }
      .c2c-badge.ok { background: rgba(63,185,80,.2); color: #3fb950; }
      .c2c-badge.warn { background: rgba(210,153,34,.2); color: #d29922; }
      .c2c-badge.danger { background: rgba(248,81,73,.18); color: #f85149; }
      .c2c-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px; border: 1px dashed var(--c2c-border); border-radius: 6px; color: var(--c2c-muted); }
      .c2c-empty p { margin: 0; color: inherit; }
      .c2c-banner { padding: 8px 12px; border-left: 3px solid #d29922; background: rgba(210,153,34,.15); border-radius: 4px; font-size: 12.5px; line-height: 1.5; }
      .c2c-banner.danger { border-left-color: #f85149; background: rgba(248,81,73,.12); color: #f85149; }
      .c2c-status-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      .c2c-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px 16px; margin-top: 4px; }
      .c2c-kv > div { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .c2c-kv .k { color: var(--c2c-muted); flex: none; }
      .c2c-kv .v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
      .c2c-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .c2c-stat { padding: 10px 12px; border: 1px solid var(--c2c-border); border-radius: 6px; background: var(--c2c-card); }
      .c2c-stat b { display: block; font-size: 18px; line-height: 24px; }
      .c2c-stat span { font-size: 11.5px; color: var(--c2c-muted); }
      .c2c-peer { background: var(--c2c-card); border: 1px solid var(--c2c-border); border-radius: 6px; padding: 10px 12px; }
      .c2c-peer-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .c2c-person { margin: 4px 0 0; font-size: 12px; color: var(--c2c-muted); line-height: 1.5; }
      .c2c-person b { color: inherit; font-weight: 500; }
      .c2c-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      .c2c-chip { display: inline-block; padding: 1px 8px; border-radius: 10px; background: rgba(127,127,127,.18); font-size: 12px; line-height: 16px; }
      .c2c-chip.me { outline: 1px solid rgba(14,99,156,.65); }
      .c2c-convs { display: flex; flex-direction: column; gap: 8px; }
      .c2c-conv { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 10px 12px; border: 1px solid var(--c2c-border); border-radius: 6px; background: var(--c2c-card); color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .c2c-conv:hover { border-color: rgba(14,99,156,.65); }
      .c2c-conv-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--c2c-muted); }
      .c2c-conv-head b { color: inherit; font-size: 13px; }
      .c2c-conv-sum { font-size: 12px; color: var(--c2c-muted); word-break: break-word; }
      .c2c-chat { display: flex; flex-direction: column; gap: 10px; }
      .c2c-bubble { max-width: 82%; padding: 8px 12px; border: 1px solid var(--c2c-border); border-radius: 10px; background: var(--c2c-card); }
      .c2c-bubble.reply { margin-left: auto; background: rgba(14,99,156,.16); border-color: rgba(14,99,156,.45); }
      .c2c-bubble-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--c2c-muted); }
      .c2c-bubble-meta b { color: inherit; font-size: 12px; }
      .c2c-bubble-text { margin-top: 6px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
      .c2c-bubble-id { margin-top: 4px; font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--c2c-muted); word-break: break-all; }
      .c2c-file { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--c2c-border); border-radius: 6px; background: var(--c2c-card); }
      .c2c-file-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .c2c-file-path { font-family: ui-monospace, monospace; font-size: 11.5px; color: var(--c2c-muted); word-break: break-all; }
      .c2c-btn { font: inherit; font-size: 12px; color: inherit; background: rgba(127,127,127,.15); border: 1px solid var(--c2c-border); border-radius: 4px; padding: 3px 10px; line-height: 18px; cursor: pointer; white-space: nowrap; }
      .c2c-btn:hover { background: rgba(127,127,127,.24); }
      .c2c-btn.primary { background: rgba(14,99,156,.22); border-color: rgba(14,99,156,.5); }
      .c2c-btn.danger { background: rgba(248,81,73,.16); border-color: rgba(248,81,73,.4); color: #f85149; }
      .c2c-btn:disabled { opacity: .5; cursor: default; }
      .c2c-form { display: flex; flex-direction: column; gap: 10px; }
      .c2c-form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
      .c2c-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; min-width: 0; }
      .c2c-field > span { color: var(--c2c-muted); }
      .c2c-input { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 18px; padding: 6px 8px; border: 1px solid var(--c2c-border); border-radius: 4px; background: var(--dsh-input-background, transparent); color: inherit; min-width: 0; }
      .c2c-input:focus { outline: 1px solid rgba(14,99,156,.7); outline-offset: 0; }
      .c2c-textarea { width: 100%; box-sizing: border-box; min-height: 70px; resize: vertical; font: inherit; font-size: 13px; line-height: 1.5; padding: 6px 8px; border: 1px solid var(--c2c-border); border-radius: 4px; background: var(--dsh-input-background, transparent); color: inherit; }
      .c2c-textarea:focus { outline: 1px solid rgba(14,99,156,.7); outline-offset: 0; }
      .c2c-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .c2c-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--c2c-muted); }
      @media (max-width: 640px) { .c2c-nav { width: 128px; padding: 8px; } .c2c-main { padding: 12px; } .c2c-title { font-size: 14px; } }
    `;

    const STATUS_LABEL = { online: '已连接', connecting: '连接中', offline: '连接失败', stopped: '未连接' };

    function Dot({ status }) {
      return h('span', { class: `c2c-dot ${status || 'offline'}`, 'aria-hidden': true });
    }

    function Badge({ kind, children }) {
      return h('span', { class: `c2c-badge${kind ? ' ' + kind : ''}` }, children);
    }

    function Card({ title, extra, children }) {
      return h('section', { class: 'c2c-card' }, [
        h('div', { key: 'head', class: 'c2c-card-head' }, [
          h('h2', { key: 't' }, title),
          extra ? h('span', { key: 'x' }, extra) : null,
        ]),
        h('div', { key: 'body' }, children),
      ]);
    }

    function Empty({ children, action }) {
      return h('div', { class: 'c2c-empty' }, [
        h('div', { key: 'b' }, children),
        action ? h('div', { key: 'a' }, action) : null,
      ]);
    }

    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function fmtSize(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
      return `${(n / 1024 / 1024).toFixed(1)} MiB`;
    }

    function Clip({ value, len }) {
      const text = String(value || '');
      return text.length > len ? text.slice(0, len) + '…' : text;
    }

    function Kv({ items }) {
      return h('div', { class: 'c2c-kv' }, items.map(([k, v], index) => h('div', { key: index }, [
        h('span', { key: 'k', class: 'k' }, k),
        h('span', { key: 'v', class: 'v' }, v),
      ])));
    }

    function CopyButton({ text, label }) {
      const [copied, setCopied] = React.useState(false);
      React.useEffect(() => {
        if (!copied) return undefined;
        const timer = setTimeout(() => setCopied(false), 1800);
        return () => clearTimeout(timer);
      }, [copied]);
      return h('button', {
        class: 'c2c-btn',
        type: 'button',
        disabled: !text,
        onClick: () => {
          const value = String(text || '');
          if (!value) return;
          const fallback = () => {
            try {
              const area = document.createElement('textarea');
              area.value = value;
              area.style.position = 'fixed';
              area.style.opacity = '0';
              document.body.appendChild(area);
              area.select();
              document.execCommand('copy');
              area.remove();
              setCopied(true);
            } catch {
              /* ignore */
            }
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(fallback);
          } else {
            fallback();
          }
        },
      }, copied ? '已复制' : (label || '复制'));
    }

    function statCard(label, value) {
      return h('div', { class: 'c2c-stat', key: label }, [
        h('b', { key: 'b' }, String(value)),
        h('span', { key: 's' }, label),
      ]);
    }

    function groupInbox(inbox) {
      const groups = new Map();
      for (const item of inbox) {
        const peer = item.from || '(未知)';
        let group = groups.get(peer);
        if (!group) {
          group = { peer, items: [], unread: 0, last: item };
          groups.set(peer, group);
        }
        group.items.push(item);
        if ((item.at || 0) > (group.last.at || 0)) group.last = item;
        if (item.kind !== 'reply' && !item.read) group.unread += 1;
      }
      return [...groups.values()].sort((a, b) => (b.last.at || 0) - (a.last.at || 0));
    }

    function configDraft(config) {
      const c = config || {};
      return {
        relayUrl: c.relayUrl || '',
        id: c.id || '',
        role: c.role || '',
        scope: c.scope || '',
        roomName: c.roomName || '',
        roomPassword: '',
        token: '',
        adminToken: '',
        waitSeconds: String(c.waitSeconds || 60),
        autoConnect: c.autoConnect === true,
        // 外发目录在表单里按「一行一个」编辑，保存时再拆成数组
        sendFileRoots: Array.isArray(c.sendFileRoots) ? c.sendFileRoots.join('\n') : '',
        allowSendAnyFile: c.allowSendAnyFile === true,
      };
    }

    function isDraftDirty(draft, config) {
      if (!draft) return false;
      const base = configDraft(config);
      return ['relayUrl', 'id', 'role', 'scope', 'roomName', 'waitSeconds', 'autoConnect',
        'sendFileRoots', 'allowSendAnyFile']
        .some((key) => String(draft[key]) !== String(base[key]))
        || Boolean(draft.token)
        || Boolean(draft.adminToken)
        || Boolean(draft.roomPassword);
    }

    function ConnectPage({ state, draft, setDraft, saving, saveError, dirty, onSave, onReload, onRetry, onDisconnect, retrying }) {
      const config = state.config || {};
      const status = state.status || 'offline';
      const mine = state.pluginVersion || '';
      const relay = state.relayVersion || '';
      const protocol = state.relayProtocol || 0;
      const norm = (value) => String(value || '').replace(/-test[\d.]+$/i, '');
      const mismatch = Boolean(relay && mine && norm(relay) !== norm(mine));
      const savedId = config.id || '';
      const missing = [];
      if (!draft.id.trim()) missing.push('id');
      if (!draft.role.trim()) missing.push('角色');
      if (!draft.scope.trim()) missing.push('负责内容');
      const usingPlainWs = /^ws:\/\//i.test(String(draft.relayUrl || '').trim());
      const field = (label, key, options) => h('label', { class: 'c2c-field' }, [
        h('span', { key: 'l' }, label),
        h('input', {
          key: 'i',
          class: 'c2c-input',
          type: (options && options.type) || 'text',
          value: draft[key] === undefined ? '' : draft[key],
          placeholder: (options && options.placeholder) || '',
          onInput: (event) => setDraft({ ...draft, [key]: event.currentTarget.value }),
        }),
      ]);
      const area = (label, key, options) => h('label', { class: 'c2c-field' }, [
        h('span', { key: 'l' }, label),
        h('textarea', {
          key: 't',
          class: 'c2c-textarea',
          rows: (options && options.rows) || 3,
          value: draft[key] === undefined ? '' : draft[key],
          placeholder: (options && options.placeholder) || '',
          onInput: (event) => setDraft({ ...draft, [key]: event.currentTarget.value }),
        }),
      ]);

      return h('div', { class: 'c2c-page' }, [
        saveError ? h('div', { key: 'serr', class: 'c2c-banner danger' }, saveError) : null,
        h(Card, { key: 'status', title: '连接状态' }, h('div', null, [
          h('div', { key: 'line', class: 'c2c-status-line' }, [
            h(Dot, { key: 'd', status }),
            h('b', { key: 'b' }, STATUS_LABEL[status] || status),
            h('span', { key: 'h', class: 'c2c-hint' }, state.detail || ''),
            status === 'offline' || status === 'stopped'
              ? h('button', {
                key: 'retry',
                class: 'c2c-btn primary',
                type: 'button',
                disabled: retrying,
                onClick: onRetry,
              }, retrying ? '连接中…' : '重试连接')
              : h('button', {
                key: 'disconnect',
                class: 'c2c-btn',
                type: 'button',
                onClick: onDisconnect,
              }, '断开连接'),
          ]),
          h(Kv, {
            key: 'kv',
            items: [
              ['本机 id', h('span', { key: 'v', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } }, [
                savedId || '（未填写）',
                savedId ? h(CopyButton, { key: 'c', text: savedId, label: '复制' }) : null,
              ])],
              ['中继地址', config.relayUrl || '（未填写）'],
              ['在线 Copilot', `${(state.peers || []).length} 位`],
              ['中继版本', relay ? `${relay}（协议 ${protocol || '—'}）` : '连接成功后显示'],
              ['插件版本', mine || '未知'],
            ],
          }),
          mismatch
            ? h('div', { key: 'mismatch', class: 'c2c-banner' }, `插件版本（${mine}）与中继版本（${relay}）不一致，中继会拒绝接入。请把插件与中继升到同一版本。`)
            : h('p', { key: 'hint', class: 'c2c-hint' }, '插件与中继版本必须一致，否则中继拒绝接入（同一版本号、测试包除外）。'),
          h('p', { key: 'hint2', class: 'c2c-hint' }, '连接在三种时机发起：DSH 启动时自动一次（可在下面关掉）、点「重试连接」时，以及断开后的自动重连（1s→30s）。'),
        ])),
        h(Card, { key: 'relay', title: '中继服务器' }, h('div', { class: 'c2c-form' }, [
          field('中继地址', 'relayUrl', { placeholder: 'wss://relay.example.com 或 ws://192.168.5.20:8787' }),
          h('p', { key: 'hint', class: 'c2c-hint' }, '跨网络填 wss://；局域网直连填内网地址即可（只写 IP:端口 会自动补 ws://）。'),
          usingPlainWs
            ? h('div', { key: 'ws', class: 'c2c-banner' }, '当前用 ws:// 明文连接：令牌与消息在链路上不加密，只建议在可信内网使用。')
            : null,
          field('中继令牌（可选）', 'token', {
            type: 'password',
            placeholder: config.hasToken ? '留空表示保持不变' : '留空表示不使用令牌',
          }),
          field('中继管理令牌（可选）', 'adminToken', {
            type: 'password',
            placeholder: config.hasAdminToken ? '留空表示保持不变' : '留空表示不启用管理权限',
          }),
          h('label', { key: 'auto', class: 'c2c-check' }, [
            h('input', {
              key: 'cb',
              type: 'checkbox',
              checked: draft.autoConnect === true,
              onChange: (event) => setDraft({ ...draft, autoConnect: event.currentTarget.checked }),
            }),
            '启动 DSH 时自动连接一次',
          ]),
          h('p', { key: 'hint2', class: 'c2c-hint' }, '令牌保存在 DSH 私有配置（0600）且不会回显；修改后点下方「保存并连接」。'),
        ])),
        h(Card, { key: 'profile', title: '我的档案' }, h('div', { class: 'c2c-form' }, [
          missing.length > 0
            ? h('div', { key: 'missing', class: 'c2c-banner' }, `请先补全档案：缺少 ${missing.join('、')}，未完成前无法与同事通信。`)
            : null,
          h('p', { key: 'hint', class: 'c2c-hint' }, '档案经中继自动同步；id 需与同事约定一致。'),
          h('div', { key: 'row', class: 'c2c-form-row' }, [
            field('id', 'id', { placeholder: '唯一标识，需与同事约定一致' }),
            field('角色', 'role', { placeholder: '如：后端工程师' }),
            field('负责内容', 'scope', { placeholder: '如：订单服务、支付网关' }),
          ]),
          h('p', { key: 'hint2', class: 'c2c-hint' }, '把 id 告诉同事即可——双方的档案会经中继自动同步，不需要手工登记。'),
        ])),
        h(Card, { key: 'room', title: '房间与等待（DSH 专用）' }, h('div', { class: 'c2c-form' }, [
          h('p', { key: 'hint', class: 'c2c-hint' }, 'DSH 没有独立的房间页：这里填写的房间会在连接建立后自动加入；房间需先由中继管理员创建。'),
          h('div', { key: 'row', class: 'c2c-form-row' }, [
            field('房间名（启动时自动加入）', 'roomName', { placeholder: '例如 c2c-公共房-20261023' }),
            field('房间密码（留空保持不变）', 'roomPassword', {
              type: 'password',
              placeholder: config.hasRoomPassword ? '已设置，留空保持不变' : '无密码可留空',
            }),
            field('等待回复秒数', 'waitSeconds', { type: 'number', placeholder: '60' }),
          ]),
        ])),
        h(Card, { key: 'files', title: '文件外发（DSH 专用）' }, h('div', { class: 'c2c-form' }, [
          area('允许外发的目录（一行一个）', 'sendFileRoots', {
            rows: 3,
            placeholder: '留空表示只允许 ~/.dsh/copilot2copilot/outbox',
          }),
          h('p', { key: 'hint', class: 'c2c-hint' }, '只允许发送这些目录内的文件，子目录同样允许；留空时仅 outbox 可发。可填绝对路径，或相对插件目录的路径。'),
          h('label', { key: 'any', class: 'c2c-check' }, [
            h('input', {
              key: 'cb',
              type: 'checkbox',
              checked: draft.allowSendAnyFile === true,
              onChange: (event) => setDraft({ ...draft, allowSendAnyFile: event.currentTarget.checked }),
            }),
            '允许发送任意本地文件（高风险）',
          ]),
          draft.allowSendAnyFile === true
            ? h('div', { key: 'warn', class: 'c2c-banner danger' }, '已放开任意文件外发：一旦被同事消息诱导，工作区外的私密文件也可能被发出。只在临时排障时打开，用完请关掉。')
            : null,
        ])),
        h('div', { key: 'actions', class: 'c2c-actions' }, [
          h('button', {
            key: 'save',
            class: 'c2c-btn primary',
            type: 'button',
            disabled: saving || !dirty,
            onClick: onSave,
          }, saving ? '保存中…' : '保存并连接'),
          h('button', {
            key: 'reload',
            class: 'c2c-btn',
            type: 'button',
            disabled: saving,
            onClick: onReload,
          }, '重新载入'),
          dirty ? h('span', { key: 'dirty', class: 'c2c-hint' }, '有未保存的修改') : null,
        ]),
      ]);
    }

    function OverviewPage({ state, peers, rooms, inbox, files, unread, joinedRooms, onGoto }) {
      const self = state.self || {};
      const profileReady = Boolean(self.role && self.scope);
      return h('div', { class: 'c2c-page' }, [
        h('div', { key: 'stats', class: 'c2c-stats' }, [
          statCard('在线同事', peers.length),
          statCard('已加入房间', joinedRooms),
          statCard('未读消息', unread),
          statCard('已收文件', files.length),
        ]),
        h(Card, { key: 'conn', title: '连接状态' },
          h('div', null, [
            h('p', { key: 'line', class: 'c2c-hint' }, [
              h(Dot, { key: 'd', status: state.status || 'offline' }),
              ' ',
              STATUS_LABEL[state.status || 'offline'] || state.status || '—',
              state.detail ? ` · ${state.detail}` : '',
            ]),
            h(Kv, {
              key: 'kv',
              items: [
                ['中继地址', state.relayUrl || '未配置'],
                ['中继版本', state.relayVersion ? `${state.relayVersion} · 协议 ${state.relayProtocol || '—'}` : '未知'],
                ['连接时间', state.connectedAt ? fmtTime(state.connectedAt) : '—'],
              ],
            }),
          ])),
        h(Card, {
          key: 'self',
          title: '我的档案',
          extra: h('span', { style: { display: 'inline-flex', gap: 8, alignItems: 'center' } }, [
            profileReady
              ? h(Badge, { key: 'b', kind: 'ok' }, '档案完整')
              : h(Badge, { key: 'b', kind: 'warn' }, '档案未填全'),
            h('button', {
              key: 'edit',
              class: 'c2c-btn',
              type: 'button',
              onClick: () => onGoto('connect'),
            }, '编辑'),
          ]),
        }, h(Kv, {
          items: [
            ['id', self.id || '未设置'],
            ['角色', self.role || '未填写'],
            ['负责内容', self.scope || '未填写'],
          ],
        })),
        joinedRooms === 0
          ? h('div', { key: 'tip', class: 'c2c-banner' }, '你还没有加入任何房间。让 Copilot 调用 c2c_rooms 加入房间后，才能看到并联系同房间成员。')
          : null,
        h(Card, {
          key: 'recent',
          title: '最近消息',
          extra: inbox.length > 0
            ? h('button', { class: 'c2c-btn', type: 'button', onClick: () => onGoto('inbox') }, '查看全部')
            : null,
        }, inbox.length === 0
          ? h('p', { class: 'c2c-hint' }, '还没有收到消息。')
          : h('div', { class: 'c2c-convs' }, inbox.slice(0, 3).map((item, index) => h('div', {
            key: index,
            class: 'c2c-conv',
            style: { cursor: 'default' },
          }, [
            h('div', { key: 'h', class: 'c2c-conv-head' }, [
              h('b', { key: 'f' }, item.from || '(未知)'),
              h('span', { key: 'k' }, item.kind === 'reply' ? '回复' : '消息'),
              h('span', { key: 't', style: { marginLeft: 'auto' } }, fmtTime(item.at)),
            ]),
            h('div', { key: 's', class: 'c2c-conv-sum' }, h(Clip, { value: item.text, len: 120 })),
          ])))),
      ]);
    }

    function PeersPage({ state, peers }) {
      const joined = (state.rooms || []).some((room) => room.joined);
      return h('div', { class: 'c2c-page' }, [
        h('p', { key: 'hint', class: 'c2c-hint' }, '列表由中继下发，只显示同一房间内在线的 Copilot；对方下线后会自动消失。'),
        peers.length === 0
          ? h(Empty, { key: 'empty' }, h('p', null,
            state.status === 'online'
              ? (joined ? '同房间里暂时没有其他在线成员。' : '你还没有加入房间，因此看不到其他人。')
              : '尚未连接中继。'))
          : peers.map((peer) => h('div', { key: peer.id, class: 'c2c-peer' }, [
            h('div', { key: 'head', class: 'c2c-peer-head' }, [
              h('b', { key: 'id' }, peer.id),
              peer.role && peer.scope
                ? h(Badge, { key: 'ok', kind: 'ok' }, '档案已同步')
                : h(Badge, { key: 'warn', kind: 'warn' }, '档案未同步'),
            ]),
            h('p', { key: 'role', class: 'c2c-person' }, ['角色：', h('b', { key: 'v' }, peer.role || '（等待中继同步）')]),
            h('p', { key: 'scope', class: 'c2c-person' }, ['负责内容：', h('b', { key: 'v' }, peer.scope || '（等待中继同步）')]),
          ])),
      ]);
    }

    function RoomsPage({ state, rooms, onRoomOp, onError }) {
      const [passwords, setPasswords] = React.useState({});
      const [busy, setBusy] = React.useState('');
      const [confirmLeave, setConfirmLeave] = React.useState('');
      const myId = (state.self && state.self.id) || '';
      const act = async (op, payload, key) => {
        setBusy(key || op);
        try {
          await onRoomOp(op, payload);
          setConfirmLeave('');
        } catch (err) {
          onError(err && err.message ? err.message : String(err));
        } finally {
          setBusy('');
        }
      };
      return h('div', { class: 'c2c-page' }, [
        h('p', { key: 'hint', class: 'c2c-hint' }, '房间列表由中继下发。未加入的房间凭密码加入；已加入的房间可直接退出。建房 / 改名 / 移人等管理操作在「管理」页。'),
        rooms.length === 0
          ? h(Empty, { key: 'empty' }, '没有可见房间。房间由中继管理员创建。')
          : rooms.map((room) => h('section', { key: room.id, class: 'c2c-card' }, [
            h('div', { key: 'head', class: 'c2c-card-head' }, [
              h('h2', { key: 'n' }, room.name),
              h(Badge, { key: 'm' }, `成员 ${room.memberCount || 0}`),
              (room.memoryCount || 0) > 0 ? h(Badge, { key: 'mem' }, `记忆 ${room.memoryCount} 条`) : null,
              room.hasPassword ? h(Badge, { key: 'p' }, '有密码') : null,
              room.joined ? h(Badge, { key: 'j', kind: 'ok' }, '已加入') : h(Badge, { key: 'j' }, '未加入'),
              h('span', { key: 'grow', style: { flex: 1 } }),
              room.joined
                ? h('button', {
                  key: 'leave',
                  class: 'c2c-btn',
                  type: 'button',
                  disabled: busy === room.id,
                  onClick: () => {
                    if (confirmLeave === room.id) {
                      void act('leave', { roomId: room.id }, room.id);
                    } else {
                      setConfirmLeave(room.id);
                    }
                  },
                }, confirmLeave === room.id ? '确认退出' : '退出')
                : h('span', { key: 'join', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } }, [
                  h('input', {
                    key: 'pw',
                    class: 'c2c-input',
                    style: { width: '150px' },
                    type: 'password',
                    value: passwords[room.id] || '',
                    placeholder: room.hasPassword ? '输入房间密码' : '无需密码',
                    onInput: (event) => setPasswords({ ...passwords, [room.id]: event.currentTarget.value }),
                  }),
                  h('button', {
                    key: 'btn',
                    class: 'c2c-btn primary',
                    type: 'button',
                    disabled: busy === room.id,
                    onClick: () => act('join', { roomId: room.id, password: passwords[room.id] || '' }, room.id),
                  }, busy === room.id ? '加入中…' : '加入'),
                ]),
            ]),
            Array.isArray(room.members) && room.members.length > 0
              ? h('div', { key: 'members', class: 'c2c-chips' }, [
                h('span', { key: 'l', class: 'c2c-hint' }, '成员：'),
                ...room.members.map((member) => h('span', {
                  key: member,
                  class: 'c2c-chip' + (member === myId ? ' me' : ''),
                }, member)),
              ])
              : h('p', { key: 'members', class: 'c2c-hint' }, room.joined ? '成员明细暂不可见。' : '加入后可查看成员明细。'),
          ])),
      ]);
    }

    const parseTags = (raw) => String(raw || '')
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);

    function MemoryPage({ rooms, onError }) {
      const joined = rooms.filter((room) => room.joined);
      const [roomId, setRoomId] = React.useState(joined[0] ? joined[0].id : '');
      const [entries, setEntries] = React.useState([]);
      const [total, setTotal] = React.useState(0);
      const [nextCursor, setNextCursor] = React.useState('');
      const [includeDeleted, setIncludeDeleted] = React.useState(false);
      const [mode, setMode] = React.useState('list');
      const [query, setQuery] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [draftText, setDraftText] = React.useState('');
      const [draftTags, setDraftTags] = React.useState('');
      const [editing, setEditing] = React.useState(null);
      const [editText, setEditText] = React.useState('');
      const [editTags, setEditTags] = React.useState('');
      const [confirmDelete, setConfirmDelete] = React.useState('');

      const memory = async (op, payload) => {
        const res = await fetch('/copilot2copilot/memory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        return data.payload || {};
      };

      const load = async (cursor) => {
        if (!roomId) return;
        setLoading(true);
        setError('');
        try {
          const payload = await memory('list', {
            roomId,
            limit: 50,
            includeDeleted,
            ...(cursor ? { cursor } : {}),
          });
          setEntries(cursor ? [...entries, ...(payload.entries || [])] : (payload.entries || []));
          setTotal(payload.total || 0);
          setNextCursor(payload.nextCursor || '');
          setMode('list');
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          setEntries([]);
          setTotal(0);
          setNextCursor('');
        } finally {
          setLoading(false);
        }
      };

      React.useEffect(() => {
        if (!roomId && joined.length > 0) setRoomId(joined[0].id);
      }, [joined, roomId]);

      React.useEffect(() => {
        void load();
      }, [roomId, includeDeleted]);

      const search = async () => {
        const value = query.trim();
        if (!value) { void load(); return; }
        setLoading(true);
        setError('');
        try {
          const payload = await memory('query', { query: value, roomId, topK: 50 });
          setEntries(payload.results || []);
          setTotal((payload.results || []).length);
          setNextCursor('');
          setMode('search');
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      const create = async () => {
        const text = draftText.trim();
        if (!text) { setError('请填写要记住的内容'); return; }
        setLoading(true);
        setError('');
        try {
          await memory('remember', { roomId, text, tags: parseTags(draftTags) });
          setDraftText('');
          setDraftTags('');
          await load();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      const update = async () => {
        if (!editing) return;
        const text = editText.trim();
        if (!text) { setError('内容不能为空'); return; }
        setLoading(true);
        setError('');
        try {
          await memory('update', {
            entryId: editing.id,
            revision: editing.revision,
            text,
            tags: parseTags(editTags),
          });
          setEditing(null);
          await load();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      const remove = async (entry) => {
        if (confirmDelete !== entry.id) { setConfirmDelete(entry.id); return; }
        setConfirmDelete('');
        setLoading(true);
        setError('');
        try {
          await memory('delete', { entryId: entry.id, revision: entry.revision });
          await load();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      const restore = async (entry) => {
        setLoading(true);
        setError('');
        try {
          await memory('restore', { entryId: entry.id });
          await load();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      if (joined.length === 0) {
        return h('div', { class: 'c2c-page' }, h(Empty, null, '你还没有加入任何房间。共享记忆按房间隔离，请先到「房间」页加入房间。'));
      }

      return h('div', { class: 'c2c-page' }, [
        h(Card, {
          key: 'list',
          title: '房间共享记忆',
          extra: h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
            h('select', {
              key: 'room',
              class: 'c2c-input',
              value: roomId,
              onChange: (event) => setRoomId(event.currentTarget.value),
            }, joined.map((room) => h('option', { key: room.id, value: room.id }, room.name))),
            h('label', { key: 'del', class: 'c2c-check' }, [
              h('input', {
                key: 'cb',
                type: 'checkbox',
                checked: includeDeleted,
                onChange: (event) => setIncludeDeleted(event.currentTarget.checked),
              }),
              '含回收站',
            ]),
            h('button', { key: 'refresh', class: 'c2c-btn', type: 'button', onClick: () => load() }, '刷新'),
          ]),
        }, h('div', { class: 'c2c-form' }, [
          h('div', { key: 'search', class: 'c2c-form-row' }, [
            h('input', {
              key: 'q',
              class: 'c2c-input',
              value: query,
              placeholder: '关键词 / 标识符；回车或点「检索」',
              onInput: (event) => setQuery(event.currentTarget.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void search(); },
            }),
            h('button', { key: 'btn', class: 'c2c-btn', type: 'button', onClick: () => search() }, '检索'),
          ]),
          h('p', { key: 'hint', class: 'c2c-hint' }, '记忆按房间隔离；条目由房间成员共同维护，修改保留历史，删除是软删除。'),
          error ? h('div', { key: 'err', class: 'c2c-banner danger' }, error) : null,
          h('div', { key: 'create', class: 'c2c-form' }, [
            h('textarea', {
              key: 'text',
              class: 'c2c-textarea',
              value: draftText,
              placeholder: '写一条可复用的事实（一条一个事实，简短明确）',
              onInput: (event) => setDraftText(event.currentTarget.value),
            }),
            h('div', { key: 'row', class: 'c2c-form-row' }, [
              h('input', {
                key: 'tags',
                class: 'c2c-input',
                value: draftTags,
                placeholder: '标签（逗号分隔，可选）',
                onInput: (event) => setDraftTags(event.currentTarget.value),
              }),
              h('button', { key: 'save', class: 'c2c-btn primary', type: 'button', disabled: loading, onClick: () => create() }, '写入记忆'),
            ]),
          ]),
        ])),
        entries.length === 0
          ? h(Empty, { key: 'empty' }, mode === 'search' ? '没有匹配的记忆。' : '这个房间还没有共享记忆。')
          : h('div', { key: 'entries', class: 'c2c-convs' }, entries.map((entry) => h('section', {
            key: entry.id,
            class: 'c2c-card',
          }, [
            h('div', { key: 'meta', class: 'c2c-conv-head' }, [
              h('b', { key: 'author' }, entry.author || '(未知)'),
              h('span', { key: 'rev' }, `revision ${entry.revision}`),
              entry.updatedBy ? h('span', { key: 'by' }, `最后修改 ${entry.updatedBy}`) : null,
              h('span', { key: 'time', style: { marginLeft: 'auto' } }, fmtTime(entry.updatedAt || entry.createdAt)),
              entry.deleted ? h(Badge, { key: 'del', kind: 'danger' }, '已删除') : null,
            ]),
            editing && editing.id === entry.id
              ? h('div', { key: 'edit', class: 'c2c-form' }, [
                h('textarea', {
                  key: 'text',
                  class: 'c2c-textarea',
                  value: editText,
                  onInput: (event) => setEditText(event.currentTarget.value),
                }),
                h('div', { key: 'row', class: 'c2c-form-row' }, [
                  h('input', {
                    key: 'tags',
                    class: 'c2c-input',
                    value: editTags,
                    placeholder: '标签（逗号分隔）',
                    onInput: (event) => setEditTags(event.currentTarget.value),
                  }),
                  h('div', { key: 'actions', class: 'c2c-actions' }, [
                    h('button', { key: 'save', class: 'c2c-btn primary', type: 'button', disabled: loading, onClick: () => update() }, '保存'),
                    h('button', { key: 'cancel', class: 'c2c-btn', type: 'button', onClick: () => setEditing(null) }, '取消'),
                  ]),
                ]),
              ])
              : h('div', { key: 'body', class: 'c2c-bubble-text', style: { marginTop: 6 } }, entry.text || ''),
            h('div', { key: 'tags', class: 'c2c-chips' }, (entry.tags || []).map((tag) => h('span', { key: tag, class: 'c2c-chip' }, tag))),
            h('div', { key: 'actions', class: 'c2c-actions', style: { marginTop: 8 } }, [
              entry.deleted
                ? h('button', { key: 'restore', class: 'c2c-btn', type: 'button', disabled: loading, onClick: () => restore(entry) }, '恢复')
                : h('button', {
                  key: 'edit',
                  class: 'c2c-btn',
                  type: 'button',
                  onClick: () => {
                    setEditing(entry);
                    setEditText(entry.text || '');
                    setEditTags((entry.tags || []).join(', '));
                  },
                }, '编辑'),
              entry.deleted
                ? null
                : h('button', {
                  key: 'del',
                  class: 'c2c-btn danger',
                  type: 'button',
                  disabled: loading,
                  onClick: () => remove(entry),
                }, confirmDelete === entry.id ? '确认删除' : '删除'),
            ]),
          ]))),
        nextCursor
          ? h('div', { key: 'more', class: 'c2c-actions' }, h('button', {
            class: 'c2c-btn',
            type: 'button',
            disabled: loading,
            onClick: () => load(nextCursor),
          }, loading ? '加载中…' : '加载更多'))
          : null,
        h('p', { key: 'count', class: 'c2c-hint' }, `共 ${total} 条${mode === 'search' ? '（检索结果）' : ''}`),
      ]);
    }

    function AdminPage({ state, rooms, onChanged, onError }) {
      const [admin, setAdmin] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [newRoom, setNewRoom] = React.useState({ name: '', password: '' });
      const [confirmDissolve, setConfirmDissolve] = React.useState('');
      const [confirmKick, setConfirmKick] = React.useState('');

      const request = async (op, payload, method) => {
        const res = await fetch('/copilot2copilot/admin', {
          method: method || 'POST',
          ...(method === 'GET' ? {} : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op, payload }),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        return data.payload || {};
      };

      const load = async () => {
        setLoading(true);
        try {
          const payload = await request(null, null, 'GET');
          setAdmin(payload);
          setError('');
        } catch (err) {
          setAdmin(null);
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      React.useEffect(() => { void load(); }, [state.config.hasAdminToken]);

      const act = async (op, payload, key) => {
        setBusy(key || op);
        try {
          await request(op, payload);
          await load();
          onChanged();
          setConfirmDissolve('');
          setConfirmKick('');
        } catch (err) {
          onError(err && err.message ? err.message : String(err));
        } finally {
          setBusy('');
        }
      };

      if (!state.config.hasAdminToken) {
        return h('div', { class: 'c2c-page' }, h(Empty, null, '尚未配置中继管理令牌。请到「连接」页填写「中继管理令牌」后保存。'));
      }

      const devices = admin && Array.isArray(admin.devices) ? admin.devices : [];
      const bans = admin && Array.isArray(admin.bans) ? admin.bans : [];

      return h('div', { class: 'c2c-page' }, [
        error ? h('div', { key: 'err', class: 'c2c-banner danger' }, error) : null,
        h(Card, {
          key: 'status',
          title: '管理状态',
          extra: admin ? h(Badge, { kind: 'ok' }, '令牌有效') : h(Badge, { kind: 'warn' }, loading ? '验证中…' : '未验证'),
        }, h('div', { class: 'c2c-form' }, [
          h('p', { key: 'hint', class: 'c2c-hint' }, admin && admin.relayVersion ? `中继版本 ${admin.relayVersion}` : '管理令牌通过后可查看在线设备、封禁名单并管理房间。'),
          h('div', { key: 'actions', class: 'c2c-actions' }, h('button', {
            class: 'c2c-btn',
            type: 'button',
            disabled: loading,
            onClick: () => load(),
          }, loading ? '刷新中…' : '刷新管理数据')),
        ])),
        h(Card, { key: 'devices', title: '在线设备', extra: h(Badge, null, `${devices.length} 台`) }, devices.length === 0
          ? h('p', { class: 'c2c-hint' }, '暂无在线设备。')
          : h('div', { class: 'c2c-convs' }, devices.map((device) => h('div', { key: device.id, class: 'c2c-peer' }, [
            h('div', { key: 'head', class: 'c2c-peer-head' }, [
              h('b', { key: 'id' }, device.id),
              device.admin ? h(Badge, { key: 'a', kind: 'warn' }, '管理员') : null,
              h('span', { key: 'v', class: 'c2c-hint' }, `版本 ${device.version || '未知'} · 房间 ${(device.roomIds || []).length}`),
              h('span', { key: 'g', style: { flex: 1 } }),
              h('button', { key: 'kick', class: 'c2c-btn', type: 'button', disabled: busy === device.id, onClick: () => act('kick', { target: device.id }, device.id) }, '踢出'),
              h('button', { key: 'ban', class: 'c2c-btn danger', type: 'button', disabled: busy === device.id, onClick: () => act('ban', { target: device.id }, device.id) }, '封禁'),
            ]),
          ])))),
        h(Card, { key: 'bans', title: '封禁名单', extra: h(Badge, null, `${bans.length} 个`) }, bans.length === 0
          ? h('p', { class: 'c2c-hint' }, '没有封禁设备。')
          : h('div', { class: 'c2c-convs' }, bans.map((target) => h('div', { key: target, class: 'c2c-peer' }, [
            h('div', { key: 'head', class: 'c2c-peer-head' }, [
              h('b', { key: 'id' }, target),
              h('span', { key: 'g', style: { flex: 1 } }),
              h('button', { key: 'unban', class: 'c2c-btn', type: 'button', disabled: busy === target, onClick: () => act('unban', { target }, target) }, '解除封禁'),
            ]),
          ])))),
        h(Card, { key: 'rooms', title: '房间管理' }, h('div', { class: 'c2c-form' }, [
          h('div', { key: 'create', class: 'c2c-form-row' }, [
            h('input', {
              key: 'name',
              class: 'c2c-input',
              value: newRoom.name,
              placeholder: '新房间名（最多 32 字符）',
              onInput: (event) => setNewRoom({ ...newRoom, name: event.currentTarget.value }),
            }),
            h('input', {
              key: 'pw',
              class: 'c2c-input',
              type: 'password',
              value: newRoom.password,
              placeholder: '加入密码（可空）',
              onInput: (event) => setNewRoom({ ...newRoom, password: event.currentTarget.value }),
            }),
            h('button', {
              key: 'btn',
              class: 'c2c-btn primary',
              type: 'button',
              disabled: busy === 'create',
              onClick: () => {
                const name = newRoom.name.trim();
                if (!name) { onError('请先填写房间名'); return; }
                void act('room-create', { name, password: newRoom.password }, 'create');
                setNewRoom({ name: '', password: '' });
              },
            }, '创建房间'),
          ]),
          rooms.length === 0
            ? h('p', { key: 'empty', class: 'c2c-hint' }, '暂无房间。')
            : rooms.map((room) => h('section', { key: room.id, class: 'c2c-card', style: { marginTop: 8 } }, [
              h('div', { key: 'head', class: 'c2c-card-head' }, [
                h('h2', { key: 'n' }, room.name),
                h(Badge, { key: 'm' }, `成员 ${room.memberCount || 0}`),
                room.hasPassword ? h(Badge, { key: 'p' }, '有密码') : null,
                h('span', { key: 'g', style: { flex: 1 } }),
                h('button', {
                  key: 'dissolve',
                  class: 'c2c-btn danger',
                  type: 'button',
                  disabled: busy === room.id,
                  onClick: () => {
                    if (confirmDissolve === room.id) {
                      void act('room-dissolve', { roomId: room.id }, room.id);
                    } else {
                      setConfirmDissolve(room.id);
                    }
                  },
                }, confirmDissolve === room.id ? '确认解散' : '解散'),
              ]),
              Array.isArray(room.members) && room.members.length > 0
                ? h('div', { key: 'members', class: 'c2c-chips' }, [
                  h('span', { key: 'l', class: 'c2c-hint' }, '成员：'),
                  ...room.members.map((member) => h('span', { key: member, class: 'c2c-chip' }, [
                    member,
                    member !== (state.self && state.self.id)
                      ? h('button', {
                        key: 'kick',
                        class: 'c2c-btn',
                        type: 'button',
                        style: { marginLeft: 4, padding: '0 6px', fontSize: 10.5 },
                        disabled: busy === `${room.id}:${member}`,
                        onClick: () => {
                          const key = `${room.id}:${member}`;
                          if (confirmKick === key) void act('room-kick', { roomId: room.id, memberId: member }, key);
                          else setConfirmKick(key);
                        },
                      }, confirmKick === `${room.id}:${member}` ? '确认移出' : '移出')
                      : null,
                  ])),
                ])
                : h('p', { key: 'members', class: 'c2c-hint' }, '成员明细暂不可见。'),
              Array.isArray(room.blocked) && room.blocked.length > 0
                ? h('div', { key: 'blocked', class: 'c2c-chips' }, [
                  h('span', { key: 'l', class: 'c2c-hint' }, '禁止再加入：'),
                  ...room.blocked.map((member) => h('span', { key: member, class: 'c2c-chip' }, [
                    member,
                    h('button', {
                      key: 'unblock',
                      class: 'c2c-btn',
                      type: 'button',
                      style: { marginLeft: 4, padding: '0 6px', fontSize: 10.5 },
                      disabled: busy === `${room.id}:unblock:${member}`,
                      onClick: () => act('room-unblock', { roomId: room.id, memberId: member }, `${room.id}:unblock:${member}`),
                    }, '解除'),
                  ])),
                ])
                : null,
            ])),
        ])),
      ]);
    }

    function InboxPage({ inbox, selectedPeer, onSelect, onBack }) {
      if (selectedPeer) {
        const items = inbox
          .filter((item) => (item.from || '(未知)') === selectedPeer)
          .sort((a, b) => (a.at || 0) - (b.at || 0));
        const unread = items.filter((item) => item.kind !== 'reply' && !item.read).length;
        return h('div', { class: 'c2c-page' }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            h('button', { key: 'back', class: 'c2c-btn', type: 'button', onClick: onBack }, '← 返回'),
            h('b', { key: 'peer' }, selectedPeer),
            unread > 0 ? h(Badge, { key: 'u', kind: 'danger' }, `${unread} 条未读`) : null,
          ]),
          h('p', { key: 'hint', class: 'c2c-hint' }, '界面只读；回复请让 Copilot 调用 c2c_reply，request_id 保持原值。'),
          items.length === 0
            ? h(Empty, { key: 'empty' }, '这个会话还没有消息。')
            : h('div', { key: 'chat', class: 'c2c-chat' }, items.map((item, index) => h('div', {
              key: index,
              class: 'c2c-bubble' + (item.kind === 'reply' ? ' reply' : ''),
            }, [
              h('div', { key: 'm', class: 'c2c-bubble-meta' }, [
                h('b', { key: 'f' }, item.from || '(未知)'),
                h('span', { key: 'k' }, item.kind === 'reply' ? '回复' : '消息'),
                item.kind !== 'reply' && !item.read ? h(Badge, { key: 'u', kind: 'danger' }, '未读') : null,
                h('span', { key: 't', style: { marginLeft: 'auto' } }, fmtTime(item.at)),
              ]),
              h('div', { key: 'x', class: 'c2c-bubble-text' }, item.text || '（空）'),
              item.requestId
                ? h('div', { key: 'id', class: 'c2c-bubble-id' }, `request_id: ${item.requestId}`)
                : null,
            ]))),
        ]);
      }

      const conversations = groupInbox(inbox);
      return h('div', { class: 'c2c-page' }, [
        h('p', { key: 'hint', class: 'c2c-hint' }, '按同事分组的收件箱。点进会话查看消息；未读条目会计入顶部角标。'),
        conversations.length === 0
          ? h(Empty, { key: 'empty' }, '还没有收到消息。')
          : h('div', { key: 'list', class: 'c2c-convs' }, conversations.map((conv) => h('button', {
            key: conv.peer,
            class: 'c2c-conv',
            type: 'button',
            onClick: () => onSelect(conv.peer),
          }, [
            h('div', { key: 'h', class: 'c2c-conv-head' }, [
              h('b', { key: 'p' }, conv.peer),
              conv.unread > 0 ? h(Badge, { key: 'u', kind: 'danger' }, `${conv.unread} 条未读`) : null,
              h('span', { key: 't', style: { marginLeft: 'auto' } }, fmtTime(conv.last.at)),
            ]),
            h('div', { key: 's', class: 'c2c-conv-sum' }, [
              conv.last.kind === 'reply' ? '回复：' : '',
              h(Clip, { key: 'c', value: conv.last.text, len: 120 }),
            ]),
          ]))),
      ]);
    }

    function FilesPage({ files }) {
      return h('div', { class: 'c2c-page' }, [
        h('p', { key: 'hint', class: 'c2c-hint' }, '收到的文件保存在 DSH 私有目录（$DSH_HOME/copilot2copilot/files），不会写入工作区；重名自动加序号。'),
        files.length === 0
          ? h(Empty, { key: 'empty' }, '还没有收到文件。')
          : files.map((file, index) => h('section', { key: file.id || index, class: 'c2c-file' }, [
            h('div', { key: 'head', class: 'c2c-file-head' }, [
              h('b', { key: 'n' }, file.name || '(未命名)'),
              h('span', { key: 's', class: 'c2c-hint' }, fmtSize(file.size)),
              file.recovered ? h(Badge, { key: 'r', kind: 'warn' }, '目录重建') : null,
              h('span', { key: 't', class: 'c2c-hint', style: { marginLeft: 'auto' } }, fmtTime(file.at)),
            ]),
            h('div', { key: 'm', class: 'c2c-hint' }, `来自 ${file.from || '(未知)'}${file.note ? ' · ' + file.note : ''}`),
            file.sha256 ? h('div', { key: 'sha', class: 'c2c-file-path' }, `sha256: ${file.sha256}`) : null,
            h('div', { key: 'path', class: 'c2c-file-path' }, file.path || ''),
            h('div', { key: 'action' }, h(CopyButton, { text: file.path, label: '复制路径' })),
          ])),
      ]);
    }

    function Panel() {
      const [state, setState] = React.useState(null);
      const [failed, setFailed] = React.useState('');
      const [tab, setTab] = React.useState('overview');
      const [selectedPeer, setSelectedPeer] = React.useState('');
      const [lastUpdated, setLastUpdated] = React.useState(0);
      const [nonce, setNonce] = React.useState(0);
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [saveError, setSaveError] = React.useState('');
      const [retrying, setRetrying] = React.useState(false);
      const booted = React.useRef(false);

      React.useEffect(() => {
        let alive = true;
        const run = async () => {
          try {
            const res = await fetch('/copilot2copilot/state', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (alive) {
              setState(body);
              setFailed('');
              setLastUpdated(Date.now());
            }
          } catch (err) {
            if (alive) setFailed(err && err.message ? err.message : String(err));
          }
        };
        run();
        const timer = setInterval(run, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, [nonce]);

      React.useEffect(() => {
        if (state && !draft) setDraft(configDraft(state.config));
      }, [state, draft]);

      React.useEffect(() => {
        if (state && !booted.current) {
          booted.current = true;
          if (!state.configured) setTab('connect');
        }
      }, [state]);

      if (!state) {
        return h('div', { class: 'c2c-root' }, [
          h('style', { key: 'css' }, C2C_CSS),
          h('div', { class: 'c2c-main' }, h('div', { class: 'c2c-card' },
            failed ? `读取状态失败：${failed}` : '读取中…')),
        ]);
      }

      const status = state.status || 'offline';
      const peers = Array.isArray(state.peers) ? state.peers : [];
      const inbox = Array.isArray(state.inbox) ? state.inbox : [];
      const rooms = Array.isArray(state.rooms) ? state.rooms : [];
      const files = Array.isArray(state.files) ? state.files : [];
      // /state 的 inbox 只给最近 50 条，未读总数以 Host 按完整收件箱统计的 state.unread 为准
      const pageUnread = inbox.filter((item) => item.kind !== 'reply' && !item.read).length;
      const unread = Math.max(Number(state.unread) || 0, pageUnread);
      const joinedRooms = rooms.filter((room) => room.joined).length;
      const dirty = isDraftDirty(draft, state.config);

      const reloadConfig = () => {
        setDraft(configDraft(state.config));
        setSaveError('');
      };

      const saveConfig = async () => {
        if (!draft) return;
        setSaving(true);
        setSaveError('');
        try {
          const payload = {
            ...draft,
            waitSeconds: Number(draft.waitSeconds) || 60,
            // 表单里按行/逗号分隔编辑，Host 侧要的是数组
            sendFileRoots: String(draft.sendFileRoots || '')
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter(Boolean),
          };
          const res = await fetch('/copilot2copilot/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setDraft(configDraft(body.config || {}));
          setNonce((value) => value + 1);
        } catch (err) {
          setSaveError(err && err.message ? err.message : String(err));
        } finally {
          setSaving(false);
        }
      };

      const retryConnect = async () => {
        setRetrying(true);
        setSaveError('');
        try {
          const res = await fetch('/copilot2copilot/connect', { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setNonce((value) => value + 1);
        } catch (err) {
          setSaveError(err && err.message ? err.message : String(err));
        } finally {
          setRetrying(false);
        }
      };

      const disconnectNow = async () => {
        setSaveError('');
        try {
          const res = await fetch('/copilot2copilot/disconnect', { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setNonce((value) => value + 1);
        } catch (err) {
          setSaveError(err && err.message ? err.message : String(err));
        }
      };

      const roomOp = async (op, payload) => {
        const res = await fetch('/copilot2copilot/room', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        setNonce((value) => value + 1);
        return data.payload || {};
      };

      const tabs = [
        { id: 'overview', label: '概览' },
        { id: 'connect', label: '连接' },
        { id: 'peers', label: 'Copilot 列表', count: peers.length },
        { id: 'rooms', label: '房间', count: joinedRooms },
        { id: 'memory', label: '记忆' },
        ...(state.config.hasAdminToken ? [{ id: 'admin', label: '管理' }] : []),
        { id: 'inbox', label: '收件箱', count: unread, alert: true },
        { id: 'files', label: '已收文件', count: files.length },
      ];

      const go = (next) => {
        setTab(next);
        if (next !== 'inbox') setSelectedPeer('');
      };

      return h('div', { class: 'c2c-root' }, [
        h('style', { key: 'css' }, C2C_CSS),
        h('header', { key: 'header', class: 'c2c-header' }, [
          h('span', { key: 'title', class: 'c2c-title' }, 'Copilot2Copilot'),
          h('span', { key: 'status', class: 'c2c-status', title: state.detail || '' }, [
            h(Dot, { key: 'd', status }),
            STATUS_LABEL[status] || status,
          ]),
          unread > 0 ? h(Badge, { key: 'unread', kind: 'danger' }, `${unread} 条未读`) : null,
          state.relayVersion
            ? h('span', { key: 'ver', class: 'c2c-hint' }, `中继 ${state.relayVersion} · 协议 ${state.relayProtocol || '—'}`)
            : null,
          h('span', {
            key: 'updated',
            class: 'c2c-hint',
            style: { marginLeft: 'auto' },
          }, lastUpdated ? `更新 ${new Date(lastUpdated).toLocaleTimeString()}` : ''),
          h('button', {
            key: 'refresh',
            class: 'c2c-btn',
            type: 'button',
            title: '立即刷新状态',
            onClick: () => setNonce((value) => value + 1),
          }, '刷新'),
        ]),
        h('div', { key: 'layout', class: 'c2c-layout' }, [
          h('nav', { key: 'nav', class: 'c2c-nav' }, [
            ...tabs.map((item) => h('button', {
              key: item.id,
              type: 'button',
              class: item.id === tab ? 'active' : '',
              onClick: () => go(item.id),
            }, [
              h('span', { key: 'label', class: 'label' }, item.label),
              item.count > 0
                ? h('span', { key: 'count', class: 'count' + (item.alert ? ' alert' : '') }, String(item.count))
                : null,
            ])),
            h('div', { key: 'foot', class: 'foot' }, [
              h('span', { key: 'self', style: { wordBreak: 'break-all' } }, `DSH ${(state.self && state.self.id) || '未配置 id'}`),
              h('span', { key: 'relay' }, state.relayVersion ? `中继 ${state.relayVersion}` : '未连接'),
            ]),
          ]),
          h('main', { key: 'main', class: 'c2c-main' }, [
            !state.configured && tab !== 'connect'
              ? h('div', { key: 'cfg', class: 'c2c-banner' }, '还没有配置中继。到「连接」页填写中继地址与自己的 id 后再连接。')
              : null,
            state.error
              ? h('div', { key: 'error', class: 'c2c-banner danger' }, state.error)
              : null,
            failed
              ? h('div', { key: 'failed', class: 'c2c-banner danger' }, `状态读取失败：${failed}`)
              : null,
            saveError && tab !== 'connect'
              ? h('div', { key: 'actionError', class: 'c2c-banner danger' }, saveError)
              : null,
            tab === 'overview'
              ? h(OverviewPage, { key: 'page', state, peers, rooms, inbox, files, unread, joinedRooms, onGoto: go })
              : null,
            tab === 'connect'
              ? h(ConnectPage, {
                key: 'page',
                state,
                draft: draft || configDraft(state.config),
                setDraft,
                saving,
                saveError,
                dirty,
                onSave: saveConfig,
                onReload: reloadConfig,
                onRetry: retryConnect,
                onDisconnect: disconnectNow,
                retrying,
              })
              : null,
            tab === 'peers'
              ? h(PeersPage, { key: 'page', state, peers })
              : null,
            tab === 'rooms'
              ? h(RoomsPage, {
                key: 'page',
                state,
                rooms,
                onRoomOp: roomOp,
                onError: setSaveError,
              })
              : null,
            tab === 'memory'
              ? h(MemoryPage, { key: 'page', rooms, onError: setSaveError })
              : null,
            tab === 'admin'
              ? h(AdminPage, {
                key: 'page',
                state,
                rooms,
                onChanged: () => setNonce((value) => value + 1),
                onError: setSaveError,
              })
              : null,
            tab === 'inbox'
              ? h(InboxPage, {
                key: 'page',
                inbox,
                selectedPeer,
                onSelect: setSelectedPeer,
                onBack: () => setSelectedPeer(''),
              })
              : null,
            tab === 'files'
              ? h(FilesPage, { key: 'page', files })
              : null,
          ]),
        ]),
      ]);
    }

    function PanelIcon(props) {
      const size = props && props.size ? props.size : 18;
      const active = Boolean(props && props.active);
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.75 },
      }, [
        h('path', {
          key: 'a',
          d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h6A2.5 2.5 0 0 1 15 6.5v4A2.5 2.5 0 0 1 12.5 13H9l-3 3v-3.2A2.5 2.5 0 0 1 4 10.5z',
          fill: 'currentColor', opacity: 0.9,
        }),
        h('path', {
          key: 'b',
          d: 'M17 10.5h.5A2.5 2.5 0 0 1 20 13v3.5A2.5 2.5 0 0 1 17.5 19H17v3l-3-3h-2',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'c2c', order: 60, label: 'Copilot2Copilot',
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'c2c',
        }, Panel));
      },
    };
  },
});