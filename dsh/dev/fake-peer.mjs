import { WebSocket } from 'ws';

// 本地联调用的假同事：收到消息自动回复，用来在没有真实扩展时验证协议层。
//   $env:C2C_TOKEN = '<中继令牌>'; node dsh\dev\fake-peer.mjs alice
const VERSION = process.env.C2C_VERSION || '2026.10.26';
const TOKEN = process.env.C2C_TOKEN || '';
const me = process.argv[2] || 'alice';

const headers = { 'x-client-version': VERSION };
if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;

const ws = new WebSocket('ws://127.0.0.1:8787/ws?id=' + encodeURIComponent(me), { headers });

ws.on('open', () => {
  ws.send(JSON.stringify({
    v: 6, kind: 'hello', id: 'h1', from: me, to: 'server', ts: Date.now(),
    profile: { id: me, role: '同事', scope: '订单服务的后端' },
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      v: 6, kind: 'room', id: 'r1', from: me, to: 'server', ts: Date.now(),
      op: 'join', payload: { roomName: 'dsh-test', password: 'pw123' },
    }));
  }, 400);
});

ws.on('message', (raw) => {
  const env = JSON.parse(String(raw));
  if (env.kind === 'message') {
    console.log('[' + me + '] <- ' + env.from + ': ' + env.text);
    setTimeout(() => {
      ws.send(JSON.stringify({
        v: 6, kind: 'reply', id: 'rp' + Date.now(), from: me, to: env.from, ts: Date.now(),
        requestId: env.id, text: 'OrderService 的 pageSize 上限是 100，超过会被后端截断。',
      }));
      console.log('[' + me + '] -> ' + env.from + ': replied');
    }, 600);
  } else if (env.kind === 'presence') {
    console.log('[' + me + '] presence: ' + JSON.stringify(env.peers));
  } else if (env.kind === 'room') {
    console.log('[' + me + '] room join: ' + (env.ok ? 'ok' : env.error));
  }
});

ws.on('error', (err) => { console.log('[' + me + '] ERR ' + err.message); process.exit(1); });