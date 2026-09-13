#!/usr/bin/env node
/**
 * talk2copilot 中继服务
 *
 * 用法：node server.js [端口]
 *
 * 配置（环境变量；systemd 部署建议用 EnvironmentFile 提供，见 deploy/relay.env.example）：
 *   PORT                监听端口，默认 8787（位置参数优先级低于 PORT）
 *   HOST                监听地址，默认 0.0.0.0；置于反向代理 / 隧道之后建议 127.0.0.1
 *   TALK2COPILOT_TOKEN  预共享密码；设置后客户端必须带 Authorization: Bearer <token>
 *   LOG_LEVEL           error | warn | info | debug，默认 info
 *
 * 端点：/  存活文本；/healthz  JSON 状态（供探针使用，不含任何 id）
 *       /peers  在线 id 列表（需令牌），供客户端连接前自查 id 是否被占用
 * 职责：按 to 字段路由消息；目标不在线时暂存（每目标最多 200 条）；广播在线名单 presence。
 * 同 id：已有在线连接时拒绝新连接（4005），不做顶替，避免多实例互相抢连接；
 *       但已失去心跳的残留连接（断电/断网遗留，TCP 半开）会被新连接接管。
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();

/** 带时间戳与级别的日志，便于 journald / 日志收集端按级别过滤 */
function log(level, message, extra) {
  if ((LEVELS[level] ?? LEVELS.info) > (LEVELS[LOG_LEVEL] ?? LEVELS.info)) {
    return;
  }
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const text = extra === undefined ? line : `${line} ${JSON.stringify(extra)}`;
  if (level === 'error') {
    console.error(text);
  } else {
    console.log(text);
  }
}

function parsePort(raw) {
  const n = Number.parseInt(String(raw), 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

if (parsePort(process.argv[2]) === undefined && process.argv[2] !== undefined) {
  log('warn', `忽略无法解析的端口参数：${process.argv[2]}`);
}

/** 端口：PORT 环境变量 > 位置参数 > 8787（沿用既有优先级） */
const PORT = parsePort(process.env.PORT) ?? parsePort(process.argv[2]) ?? 8787;
/** 监听地址：置于反向代理 / 隧道之后时应设为 127.0.0.1，避免内网直接暴露 */
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.TALK2COPILOT_TOKEN || '';
const OFFLINE_LIMIT = 200;
const HEARTBEAT_MS = 10000;
const SHUTDOWN_GRACE_MS = 5000;

/** @type {Map<string, import('ws').WebSocket>} */
const peers = new Map();
/** @type {Map<string, object[]>} */
const offline = new Map();
let seq = 0;
let shuttingDown = false;
/** @type {ReturnType<typeof setInterval> | undefined} */
let heartbeatTimer;

/** 恒定时间比较，避免令牌被逐字节试探 */
function tokenMatches(header) {
  if (!TOKEN) {
    return true;
  }
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function remoteOf(req) {
  return req.socket?.remoteAddress || '(unknown)';
}

/** 离线暂存的消息总数（健康检查用；不暴露任何 id） */
function queuedCount() {
  let total = 0;
  for (const list of offline.values()) {
    total += list.length;
  }
  return total;
}

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
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  // 探针端点：只回计数与状态，不回任何 id
  if (pathname === '/healthz') {
    const body = JSON.stringify({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      peers: peers.size,
      queued: queuedCount(),
      tokenRequired: TOKEN !== '',
      protocol: 1,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${body}\n`);
    return;
  }
  // 在线名单：带令牌查询，供客户端连接前检查 id 是否已被占用（不含任何档案信息）
  if (pathname === '/peers') {
    if (!tokenMatches(req.headers.authorization || '')) {
      log('warn', '拒绝查询在线名单：令牌不正确', { ip: remoteOf(req) });
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${JSON.stringify({ peers: [...peers.keys()] })}\n`);
    return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('talk2copilot relay ok\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
});

// 必须在 WebSocketServer 构造之前注册：ws 构造时会把 http server 的 error 转发给自己的
// 'error' 事件，而 wss 上无监听者时会抛出未捕获异常、中断 emit 循环，使本监听器永不执行
server.on('error', err => {
  log('error', `监听失败：${err.message}`, { code: err.code, host: HOST, port: PORT });
  process.exit(1);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/ws', 'http://localhost');
  const id = url.searchParams.get('id') || '';
  const auth = req.headers.authorization || '';

  if (!tokenMatches(auth)) {
    log('warn', '拒绝连接：令牌不正确', { ip: remoteOf(req) });
    ws.close(4001, 'unauthorized');
    return;
  }
  if (!id) {
    log('warn', '拒绝连接：缺少 id', { ip: remoteOf(req) });
    ws.close(4002, 'missing id');
    return;
  }

  const previous = peers.get(id);
  if (previous && previous !== ws && previous.readyState === previous.OPEN) {
    if (previous.isAlive === false) {
      // 旧连接已失去心跳（断电/断网残留，TCP 半开、收不到 FIN/RST）：
      // 直接接管，避免一个死连接挡住设备重新上线。
      log('warn', '接管失去心跳的残留连接（断电/断网遗留）', { id, ip: remoteOf(req) });
      previous.terminate();
    } else {
      // 旧连接仍活着（如同一台机器开了多个窗口）：拒绝新连接而不是顶掉旧的，
      // 由服务端做权威判定，避免双方互相顶下线、每秒抢一次连接
      log('warn', '拒绝连接：该 id 已在线', { id, ip: remoteOf(req) });
      ws.close(4005, 'id in use');
      return;
    }
  }
  if (previous && previous !== ws) {
    log('info', '接管同一 id 的残留连接（旧连接已不是 OPEN 状态）', { id });
  }
  peers.set(id, ws);
  log('info', `${id} 已上线`, { online: peers.size, ip: remoteOf(req) });

  const pending = offline.get(id);
  if (pending && pending.length > 0) {
    offline.delete(id);
    for (const env of pending) {
      send(ws, env);
    }
    log('info', `补发离线消息 ${pending.length} 条给 ${id}`);
  }
  broadcastPresence();

  ws.on('message', data => {
    if (shuttingDown) {
      return;
    }
    let env;
    try {
      env = JSON.parse(data.toString());
    } catch {
      log('debug', '收到无法解析的数据，已忽略', { id });
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
      log('debug', `${env.to} 不在线，暂存消息`, { id: env.id, queued: list.length });
    }
  });

  ws.on('close', () => {
    if (peers.get(id) === ws) {
      peers.delete(id);
      log('info', `${id} 已离线`, { online: peers.size });
      if (!shuttingDown) {
        broadcastPresence();
      }
    }
  });
  ws.on('error', err => {
    log('warn', `连接出错：${err.message}`, { id });
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      log('warn', '心跳超时，断开连接');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

/** 收到 SIGTERM/SIGINT：先给客户端发关闭帧再退出，超时兜底强制退出 */
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log('info', `收到 ${signal}，开始关闭`, { peers: peers.size });
  clearInterval(heartbeatTimer);
  for (const ws of wss.clients) {
    ws.close(1001, 'server shutting down');
  }
  const force = setTimeout(() => {
    log('warn', '等待连接关闭超时，强制退出');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  server.close(() => {
    log('info', '已停止监听，退出');
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  log('info', '中继服务已启动', {
    address: `http://${HOST}:${PORT}`,
    tokenRequired: TOKEN !== '',
    logLevel: LOG_LEVEL,
    offlineLimit: OFFLINE_LIMIT,
    pid: process.pid,
  });
});
