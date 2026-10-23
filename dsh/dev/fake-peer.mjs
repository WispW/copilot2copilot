import { WebSocket } from 'ws';

const VERSION = '2026.10.23';
const me = process.argv[2] || 'alice';
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?id=${encodeURIComponent(me)}`, {
  headers: { 'x-client-version': VERSION, authorization: 'Bearer dshdevtoken' },
});

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
    console.log(`[${me}] <- ${env.from}: ${env.text}`);
    setTimeout(() => {
      ws.send(JSON.stringify({
        v: 6, kind: 'reply', id: 'rp' + Date.now(), from: me, to: env.from, ts: Date.now(),
        requestId: env.id, text: 'OrderService 的 pageSize 上限是 100，超过会被后端截断。',
      }));
      console.log(`[${me}] -> ${env.from}: replied`);
    }, 600);
  } else if (env.kind === 'presence') {
    console.log(`[${me}] presence: ${JSON.stringify(env.peers)}`);
  } else if (env.kind === 'room') {
    console.log(`[${me}] room join: ${env.ok ? 'ok' : env.error}`);
  }
});

ws.on('error', (err) => { console.log(`[${me}] ERR ${err.message}`); process.exit(1); });