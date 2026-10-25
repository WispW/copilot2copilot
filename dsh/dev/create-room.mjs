import { WebSocket } from 'ws';

// 本地联调脚本：令牌与版本从环境变量读取，脚本里不留明文。
//   $env:C2C_TOKEN = '<中继令牌>'; node dsh\dev\create-room.mjs
const VERSION = process.env.C2C_VERSION || '2026.10.23';
const TOKEN = process.env.C2C_TOKEN || '';
const ADMIN_TOKEN = process.env.C2C_ADMIN_TOKEN || '';

const headers = { 'x-client-version': VERSION };
if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
if (ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN;

const ws = new WebSocket('ws://127.0.0.1:8787/ws?id=setup-admin', { headers });
const done = (code) => { try { ws.close(); } catch { /* ignore */ } setTimeout(() => process.exit(code), 100); };

ws.on('open', () => {
  ws.send(JSON.stringify({
    v: 6, kind: 'hello', id: 'h1', from: 'setup-admin', to: 'server', ts: Date.now(),
    profile: { id: 'setup-admin', role: 'relay admin', scope: 'dev setup' },
  }));
  ws.send(JSON.stringify({
    v: 6, kind: 'admin', id: 'a1', from: 'setup-admin', to: 'server', ts: Date.now(),
    op: 'room-create', payload: { name: 'dsh-test', password: 'pw123' },
  }));
});

ws.on('message', (raw) => {
  const env = JSON.parse(String(raw));
  if (env.kind === 'admin') {
    console.log(env.ok ? 'room created: ' + JSON.stringify(env.payload.room) : 'failed: ' + env.error);
    done(env.ok ? 0 : 1);
  }
});

ws.on('error', (err) => { console.log('ERR ' + err.message); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(1); }, 8000);