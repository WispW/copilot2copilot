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
      .c2c-btn:disabled { opacity: .5; cursor: default; }
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
          extra: profileReady
            ? h(Badge, { kind: 'ok' }, '档案完整')
            : h(Badge, { kind: 'warn' }, '档案未填全'),
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

    function RoomsPage({ state, rooms }) {
      const myId = (state.self && state.self.id) || '';
      return h('div', { class: 'c2c-page' }, [
        h('p', { key: 'hint', class: 'c2c-hint' }, '房间由中继管理员创建。加入 / 退出请让 Copilot 调用 c2c_rooms；未加入的房间看不到成员明细。'),
        rooms.length === 0
          ? h(Empty, { key: 'empty' }, '没有可见房间。房间由中继管理员创建。')
          : rooms.map((room) => h('section', { key: room.id, class: 'c2c-card' }, [
            h('div', { key: 'head', class: 'c2c-card-head' }, [
              h('h2', { key: 'n' }, room.name),
              h(Badge, { key: 'm' }, `成员 ${room.memberCount || 0}`),
              (room.memoryCount || 0) > 0 ? h(Badge, { key: 'mem' }, `记忆 ${room.memoryCount} 条`) : null,
              room.hasPassword ? h(Badge, { key: 'p' }, '有密码') : null,
              room.joined ? h(Badge, { key: 'j', kind: 'ok' }, '已加入') : h(Badge, { key: 'j' }, '未加入'),
            ]),
            Array.isArray(room.members) && room.members.length > 0
              ? h('div', { key: 'members', class: 'c2c-chips' }, [
                h('span', { key: 'l', class: 'c2c-hint' }, '成员：'),
                ...room.members.map((member) => h('span', {
                  key: member,
                  class: 'c2c-chip' + (member === myId ? ' me' : ''),
                }, member)),
              ])
              : h('p', { key: 'members', class: 'c2c-hint' }, room.joined ? '成员明细暂不可见。' : '加入后可查看成员。'),
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
      const unread = inbox.filter((item) => item.kind !== 'reply' && !item.read).length;
      const joinedRooms = rooms.filter((room) => room.joined).length;

      const tabs = [
        { id: 'overview', label: '概览' },
        { id: 'peers', label: 'Copilot 列表', count: peers.length },
        { id: 'rooms', label: '房间', count: joinedRooms },
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
            !state.configured
              ? h('div', { key: 'cfg', class: 'c2c-banner' }, '还没有配置中继。到「设置 → 插件」里打开本插件，填写中继地址与自己的 id 后再连接。')
              : null,
            state.error
              ? h('div', { key: 'error', class: 'c2c-banner danger' }, state.error)
              : null,
            failed
              ? h('div', { key: 'failed', class: 'c2c-banner danger' }, `状态读取失败：${failed}`)
              : null,
            tab === 'overview'
              ? h(OverviewPage, { key: 'page', state, peers, rooms, inbox, files, unread, joinedRooms, onGoto: go })
              : null,
            tab === 'peers'
              ? h(PeersPage, { key: 'page', state, peers })
              : null,
            tab === 'rooms'
              ? h(RoomsPage, { key: 'page', state, rooms })
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