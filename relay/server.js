#!/usr/bin/env node
/**
 * talk2copilot 中继服务
 *
 * 用法：node relay/server.js [端口]        （端口默认 8787，也可用环境变量 PORT）
 * 鉴权：设置环境变量 TALK2COPILOT_TOKEN 后，客户端必须带 Authorization: Bearer <token>
 *
 * 职责：按 to 字段路由消息；目标不在线时暂存（最多 200 条）；广播在线名单 presence。
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const TOKEN = process.env.TALK2COPILOT_TOKEN || '';
const OFFLINE_LIMIT = 200;
const HEARTBEAT_MS = 30000;

/** @type {Map<string, import('ws').WebSocket>} */
const peers = new Map();
/** @type {Map<string, object[]>} */
const offline = new Map();
let seq = 0;

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastPresence() {
  const payload = JSON.stringify({
    v: 1,
    kind: 'presence',
    id: `presence-${++seq}`,
    from: 'server',
    to: '*',
    ts: Date.now(),
    peers: [...peers.keys()],
  });
  for (const ws of peers.values()) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('talk2copilot relay ok\n');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/ws', 'http://localhost');
  const id = url.searchParams.get('id') || '';
  const auth = req.headers.authorization || '';

  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    ws.close(4001, 'unauthorized');
    return;
  }
  if (!id) {
    ws.close(4002, 'missing id');
    return;
  }

  const previous = peers.get(id);
  if (previous && previous !== ws) {
    previous.close(4004, 'replaced by new connection');
  }
  peers.set(id, ws);
  console.log(`[relay] ${id} online (${peers.size} online)`);

  const pending = offline.get(id);
  if (pending && pending.length > 0) {
    offline.delete(id);
    for (const env of pending) {
      send(ws, env);
    }
    console.log(`[relay] delivered ${pending.length} offline message(s) to ${id}`);
  }
  broadcastPresence();

  ws.on('message', data => {
    let env;
    try {
      env = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!env || typeof env.to !== 'string' || env.kind === 'presence') {
      return;
    }
    const target = peers.get(env.to);
    if (target && target.readyState === target.OPEN) {
      send(target, env);
    } else {
      const list = offline.get(env.to) || [];
      list.push(env);
      while (list.length > OFFLINE_LIMIT) {
        list.shift();
      }
      offline.set(env.to, list);
      console.log(`[relay] ${env.to} offline, queued message ${env.id}`);
    }
  });

  ws.on('close', () => {
    if (peers.get(id) === ws) {
      peers.delete(id);
      console.log(`[relay] ${id} offline (${peers.size} online)`);
      broadcastPresence();
    }
  });
  ws.on('error', () => { /* close 会跟上 */ });

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`[relay] talk2copilot relay listening on :${PORT}${TOKEN ? ' (token required)' : ''}`);
});
