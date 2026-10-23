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

    const BORDER = 'var(--dsh-border-weak, rgba(128,128,128,0.22))';
    const MUTED = 'var(--dsh-text-weak, rgba(128,128,128,0.95))';
    const PANEL = 'var(--dsh-surface, transparent)';

    function StatusDot({ status }) {
      const color = status === 'online' ? '#22a06b' : status === 'connecting' ? '#d08b12' : '#b4473a';
      return h('span', {
        'aria-hidden': true,
        style: {
          width: 8, height: 8, borderRadius: 4, display: 'inline-block',
          background: color, marginRight: 6, flex: '0 0 auto',
        },
      });
    }

    function Section({ title, count, children }) {
      return h('section', { style: { marginTop: 18 } }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 },
        }, [
          h('h3', { key: 't', style: { margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: 0.2 } }, title),
          typeof count === 'number'
            ? h('span', { key: 'c', style: { fontSize: 12, color: MUTED } }, String(count))
            : null,
        ]),
        h('div', { key: 'body' }, children),
      ]);
    }

    function Row({ children, keyValue }) {
      return h('div', {
        key: keyValue,
        style: {
          display: 'flex', gap: 10, alignItems: 'flex-start',
          padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8,
          background: PANEL, marginBottom: 6, fontSize: 13, lineHeight: 1.45,
        },
      }, children);
    }

    function Empty({ children }) {
      return h('div', { style: { fontSize: 13, color: MUTED, padding: '6px 2px' } }, children);
    }

    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function Clip({ value, len }) {
      const text = String(value || '');
      return text.length > len ? text.slice(0, len) + '…' : text;
    }

    function Panel() {
      const [state, setState] = React.useState(null);
      const [failed, setFailed] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch('/copilot2copilot/state', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (alive) { setState(body); setFailed(''); }
          } catch (err) {
            if (alive) setFailed(err && err.message ? err.message : String(err));
          }
        };
        tick();
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (!state) {
        return h('div', { style: { padding: 24, fontSize: 13, color: MUTED } },
          failed ? `读取状态失败：${failed}` : '读取中…');
      }

      const status = state.status || 'offline';
      const peers = Array.isArray(state.peers) ? state.peers : [];
      const inbox = Array.isArray(state.inbox) ? state.inbox : [];
      const rooms = Array.isArray(state.rooms) ? state.rooms : [];

      return h('div', {
        style: {
          padding: '20px 24px 32px', boxSizing: 'border-box', height: '100%',
          overflowY: 'auto', fontSize: 13,
        },
      }, [
        h('header', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          h('div', { key: 't', style: { fontSize: 16, fontWeight: 600 } }, 'Copilot2Copilot'),
          h('div', {
            key: 's',
            style: {
              display: 'flex', alignItems: 'center', fontSize: 12, color: MUTED,
              border: `1px solid ${BORDER}`, borderRadius: 999, padding: '2px 10px',
            },
          }, [h(StatusDot, { key: 'd', status }), status]),
          state.relayVersion
            ? h('span', { key: 'v', style: { fontSize: 12, color: MUTED } }, `中继 ${state.relayVersion}`)
            : null,
        ]),

        !state.configured
          ? h('div', {
            key: 'cfg',
            style: {
              marginTop: 14, padding: '10px 12px', fontSize: 13, lineHeight: 1.5,
              border: `1px solid ${BORDER}`, borderRadius: 8, color: MUTED,
            },
          }, '还没有配置中继。到「设置 → 插件」里打开本插件，填写中继地址与自己的 id 后再连接。')
          : null,

        state.error
          ? h('div', {
            key: 'err',
            style: {
              marginTop: 14, padding: '8px 12px', fontSize: 12.5,
              border: '1px solid #b4473a55', borderRadius: 8, color: '#b4473a',
            },
          }, state.error)
          : null,

        h(Section, { key: 'self', title: '我的档案' },
          h(Row, null, [
            h('code', { key: 'id', style: { fontSize: 12.5 } }, state.self && state.self.id ? state.self.id : '未设置 id'),
            state.self && state.self.role
              ? h('span', { key: 'r', style: { color: MUTED } }, `· ${state.self.role}`)
              : null,
          ])),

        h(Section, { key: 'peers', title: '在线同事', count: peers.length },
          peers.length === 0
            ? h(Empty, null, state.detail || '同房间里暂时没有其他 Copilot。')
            : peers.map((peer) => h(Row, { key: peer.id, keyValue: peer.id }, [
              h('div', { key: 'l', style: { flex: '1 1 auto', minWidth: 0 } }, [
                h('div', { key: 'id', style: { fontWeight: 500 } }, peer.id),
                h('div', { key: 'sc', style: { color: MUTED, fontSize: 12 } },
                  [peer.role, peer.scope].filter(Boolean).join(' · ') || '未填写角色'),
              ]),
            ]))),

        h(Section, { key: 'rooms', title: '房间', count: rooms.length },
          rooms.length === 0
            ? h(Empty, null, '没有可见房间。房间由中继管理员创建。')
            : rooms.map((room) => h(Row, { key: room.id, keyValue: room.id }, [
              h('div', { key: 'l', style: { flex: '1 1 auto' } }, [
                h('div', { key: 'n', style: { fontWeight: 500 } }, room.name),
                h('div', { key: 'm', style: { color: MUTED, fontSize: 12 } },
                  `${room.memberCount || 0} 位成员${room.hasPassword ? ' · 有密码' : ''}`),
              ]),
              h('span', {
                key: 'j',
                style: { fontSize: 11.5, color: room.joined ? '#22a06b' : MUTED, flex: '0 0 auto' },
              }, room.joined ? '已加入' : '未加入'),
            ]))),

        h(Section, { key: 'inbox', title: '收件箱', count: inbox.length },
          inbox.length === 0
            ? h(Empty, null, '还没有收到消息。')
            : inbox.slice(0, 20).map((item, index) => h(Row, { key: `${item.requestId || index}-${index}`, keyValue: index }, [
              h('div', { key: 'l', style: { flex: '1 1 auto', minWidth: 0 } }, [
                h('div', { key: 'h', style: { display: 'flex', gap: 6, alignItems: 'baseline' } }, [
                  h('span', { key: 'f', style: { fontWeight: 500 } }, item.from || '(未知)'),
                  h('span', { key: 'k', style: { fontSize: 11.5, color: MUTED } },
                    item.kind === 'reply' ? '回复' : '消息'),
                  h('span', { key: 't', style: { fontSize: 11.5, color: MUTED, marginLeft: 'auto' } },
                    fmtTime(item.at)),
                ]),
                h('div', { key: 'b', style: { marginTop: 2 } }, h(Clip, { value: item.text, len: 160 })),
              ]),
            ]))),
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