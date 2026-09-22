#!/usr/bin/env node
/**
 * talk2copilot 中继服务
 *
 * 用法：node server.js [端口]
 *
 * 配置（环境变量；systemd 部署建议用 EnvironmentFile 提供，见 deploy/relay.env.example）：
 *   PORT                        监听端口，默认 8787（位置参数优先级低于 PORT）
 *   HOST                        监听地址，默认 0.0.0.0；置于反向代理 / 隧道之后建议 127.0.0.1
 *   TALK2COPILOT_TOKEN          预共享密码；设置后客户端必须带 Authorization: Bearer <token>
 *   TALK2COPILOT_ADMIN_TOKEN    管理令牌；客户端在握手头 x-admin-token 中携带，通过即获得管理权限
 *   TALK2COPILOT_BAN_FILE       封禁名单落盘路径；默认 systemd STATE_DIRECTORY 或脚本目录下的 bans.json
 *   TALK2COPILOT_RELAY_VERSION  覆盖中继版本号（仅供测试）；默认取内置 RELAY_VERSION
 *   LOG_LEVEL                   error | warn | info | debug，默认 info
 *
 * 端点：/  存活文本；/healthz  JSON 状态（含中继版本与协议号，不含任何 id）
 *       /peers  在线 id 列表（需令牌），供客户端连接前自查 id 是否被占用
 * 版本门禁：客户端须在握手头 x-client-version 上报扩展版本（-testN 后缀忽略），
 *       与中继 RELAY_VERSION 不一致即拒绝（4008）——中继与扩展必须同步升级。
 * 房间（可见域）：房间由所有者（owner）管理——密码 / 踢出（进禁止名单）/ 解除禁止 / 改名 / 解散；
 *       设备只能"看到"（presence）并只能与同房间成员通信（转发前强制校验，管理令牌不豁免）；
 *       未加入任何房间的设备与所有人互相不可见。房间存内存（重启即失），封禁名单落盘。
 * 管理令牌：持有者可踢出 / 封禁 / 解封任意设备，并对所有房间拥有所有者级权限。
 * 职责：按 to 字段路由消息；目标不在线时暂存（每目标最多 200 条）；
 *       按接收者定制 presence——客户端连上后向 to='server' 上报自己的档案，
 *       由中继统一维护并向可见成员下发，是档案的唯一权威来源。
 * 同 id：已有在线连接时拒绝新连接（4005），不做顶替，避免多实例互相抢连接；
 *       但已失去心跳的残留连接（断电/断网遗留，TCP 半开）会被新连接接管。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();

/** 中继版本：必须与仓库 package.json 的 version 同步（发版时一起改；install.sh 会比对 /healthz 告警） */
const RELAY_VERSION = process.env.TALK2COPILOT_RELAY_VERSION || '0.4.2';
/** 协议号：与扩展 src/protocol.ts 的 PROTOCOL_VERSION 对应，仅供探针展示 */
const PROTOCOL = 2;
/** 管理令牌：为空时管理功能整体不可用（不给任何人管理权限） */
const ADMIN_TOKEN = process.env.TALK2COPILOT_ADMIN_TOKEN || '';
/** 封禁名单落盘路径：systemd 单元通过 StateDirectory 提供可写目录 */
const BAN_FILE = process.env.TALK2COPILOT_BAN_FILE
  || path.join(process.env.STATE_DIRECTORY || __dirname, 'bans.json');
/** 房间上限与单房间成员上限（防滥用；房间纯内存） */
const ROOM_LIMIT = 50;
const ROOM_MEMBER_LIMIT = 32;
const ROOM_NAME_MAX = 32;
/** 允许在设备之间转发的 kind（控制面 room/admin/room-event 与 error 只能由中继产生） */
const FORWARDABLE = new Set(['hello', 'message', 'reply', 'offline',
  'file-offer', 'file-chunk', 'file-ack', 'file-end', 'file-done']);

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
/** 在线档案目录：id → {id, role, scope}，客户端连上后经 to='server' 上报，中继是档案的权威来源 */
/** @type {Map<string, {id: string, role: string, scope: string}>} */
const profiles = new Map();
/** @type {Map<string, object[]>} */
const offline = new Map();
/**
 * 房间表（可见域）：房间纯内存，中继重启即失。
 * @type {Map<string, {id: string, name: string, ownerId: string, passHash: string, passSalt: string,
 *   members: Set<string>, blocked: Set<string>, createdAt: number}>}
 */
const rooms = new Map();
/** 封禁名单（设备 id）：连接时拒绝（4007），落盘保留 */
const banned = new Set();
let roomSeq = 0;
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

/** 恒定时间比较（字符串），避免管理令牌被逐字节试探 */
function timingSafeEqualStr(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 版本号归一化：忽略 -testN 后缀，测试包与正式包视为同一版本 */
function normalizeVersion(value) {
  return String(value || '').trim().replace(/-test\d+$/i, '');
}

function loadBans() {
  try {
    const raw = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      for (const id of raw) {
        if (typeof id === 'string' && id) {
          banned.add(id);
        }
      }
    }
    log('info', `已载入封禁名单`, { count: banned.size, file: BAN_FILE });
  } catch {
    // 文件不存在或不可读：从空名单开始（首启/首部署的正常路径）
  }
}

function saveBans() {
  try {
    fs.writeFileSync(BAN_FILE, `${JSON.stringify([...banned], null, 2)}\n`);
  } catch (err) {
    log('warn', '封禁名单写入失败（本次仅内存生效，重启会丢失）', { file: BAN_FILE, error: err.message });
  }
}

function newRoomId() {
  return `r${Date.now().toString(36)}${(++roomSeq).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

/** 房间密码：scrypt 加盐哈希，中继不落明文 */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function setRoomPassword(room, password) {
  if (password) {
    room.passSalt = crypto.randomBytes(8).toString('hex');
    room.passHash = hashPassword(password, room.passSalt);
  } else {
    room.passSalt = '';
    room.passHash = '';
  }
}

function passwordMatches(room, password) {
  if (!room.passHash) {
    return true;
  }
  const given = Buffer.from(hashPassword(password || '', room.passSalt), 'hex');
  const expected = Buffer.from(room.passHash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** 设备可见集合：只看得到自己所在房间的成员（含自己）；无房间 → 仅自己。管理令牌不豁免 */
function visibleIds(id) {
  const set = new Set([id]);
  for (const room of rooms.values()) {
    if (room.members.has(id)) {
      for (const member of room.members) {
        set.add(member);
      }
    }
  }
  return set;
}

/** 两台设备是否同处至少一个房间（消息与文件转发的准入条件） */
function shareRoom(a, b) {
  if (a === b) {
    return true;
  }
  for (const room of rooms.values()) {
    if (room.members.has(a) && room.members.has(b)) {
      return true;
    }
  }
  return false;
}

/** 房间摘要：成员明细仅同房间成员与管理员可见；禁止名单与被中继封禁的成员仅所有者与管理员可见 */
function roomSummary(room, viewerId, isAdmin) {
  const mine = room.members.has(viewerId);
  const privileged = isAdmin || room.ownerId === viewerId;
  return {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    hasPassword: Boolean(room.passHash),
    memberCount: room.members.size,
    joined: mine,
    // 成员集合在设备离线后仍保留（房间是可见域），在线情况另给一份，供界面标注「离线」
    ...(mine || isAdmin ? {
      members: [...room.members],
      onlineMembers: [...room.members].filter(member => peers.has(member)),
    } : {}),
    ...(privileged ? { blocked: [...room.blocked] } : {}),
    // 设备级封禁（中继层）的成员：让房主知道"人不见了/连不上"是中继封禁，需管理员解封
    ...(privileged ? { bannedMembers: [...room.members].filter(member => banned.has(member)) } : {}),
  };
}

function findRoom(req) {
  const byId = typeof req.roomId === 'string' ? rooms.get(req.roomId) : undefined;
  if (byId) {
    return byId;
  }
  const name = String(req.roomName || '').trim();
  if (name) {
    for (const room of rooms.values()) {
      if (room.name === name) {
        return room;
      }
    }
  }
  return undefined;
}

/** room-event：按接收者定制的房间列表（访客只看到公开摘要） */
function roomEventPayload(id, isAdmin) {
  return {
    v: 1,
    kind: 'room-event',
    id: `rooms-${++seq}`,
    from: 'server',
    to: '*',
    ts: Date.now(),
    rooms: [...rooms.values()].map(room => roomSummary(room, id, isAdmin)),
  };
}

function broadcastRoomEvents() {
  for (const [id, ws] of peers) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(roomEventPayload(id, ws.isAdmin === true)));
    }
  }
}

/** 房间变更后的统一收敛：可见性（presence）与房间列表（room-event）都按新状态重算下发 */
function touchRooms() {
  broadcastPresence();
  broadcastRoomEvents();
}

/** 按接收者定制的 presence：peers / profiles 只含该设备可见的在线成员（无房间 → 只剩自己） */
function broadcastPresence() {
  for (const [id, ws] of peers) {
    if (ws.readyState !== ws.OPEN) {
      continue;
    }
    const visible = visibleIds(id);
    ws.send(JSON.stringify({
      v: 1,
      kind: 'presence',
      id: `presence-${++seq}`,
      from: 'server',
      to: '*',
      ts: Date.now(),
      peers: [...peers.keys()].filter(peerId => visible.has(peerId)),
      profiles: [...profiles.values()].filter(profile => visible.has(profile.id)),
    }));
  }
}

/** 控制面应答：id 与请求相同，便于客户端关联 */
function controlResult(ws, req, kind, ok, payload, error) {
  send(ws, {
    v: 1,
    kind,
    id: typeof req.id === 'string' ? req.id : `ctl-${++seq}`,
    from: 'server',
    to: typeof req.from === 'string' ? req.from : '',
    ts: Date.now(),
    op: typeof req.op === 'string' ? req.op : '',
    ok,
    ...(payload ? { payload } : {}),
    ...(error ? { error } : {}),
  });
}

/** 房间操作：list / create / join / leave / kick / unblock / rename / passwd / dissolve */
function handleRoomOp(ws, id, env) {
  const isAdmin = ws.isAdmin === true;
  const op = typeof env.op === 'string' ? env.op : '';
  const req = env.payload && typeof env.payload === 'object' ? env.payload : {};
  const fail = error => controlResult(ws, env, 'room', false, undefined, error);
  const summarizeAll = () => [...rooms.values()].map(room => roomSummary(room, id, isAdmin));
  switch (op) {
    case 'list':
      controlResult(ws, env, 'room', true, { rooms: summarizeAll() });
      return;
    case 'create': {
      const name = String(req.name || '').trim().slice(0, ROOM_NAME_MAX);
      if (!name) {
        fail('房间名不能为空');
        return;
      }
      if ([...rooms.values()].some(room => room.name === name)) {
        fail(`房间名「${name}」已存在`);
        return;
      }
      if (rooms.size >= ROOM_LIMIT) {
        fail(`房间数已达上限（${ROOM_LIMIT}）`);
        return;
      }
      const room = {
        id: newRoomId(),
        name,
        ownerId: id,
        passHash: '',
        passSalt: '',
        members: new Set([id]),
        blocked: new Set(),
        createdAt: Date.now(),
      };
      if (typeof req.password === 'string' && req.password) {
        setRoomPassword(room, req.password);
      }
      rooms.set(room.id, room);
      log('info', `${id} 创建房间「${name}」`, { roomId: room.id, password: Boolean(room.passHash), total: rooms.size });
      controlResult(ws, env, 'room', true, { room: roomSummary(room, id, isAdmin) });
      touchRooms();
      return;
    }
    case 'join': {
      const room = findRoom(req);
      if (!room) {
        fail('房间不存在');
        return;
      }
      if (room.members.has(id)) {
        controlResult(ws, env, 'room', true, { room: roomSummary(room, id, isAdmin) });
        return;
      }
      if (room.blocked.has(id)) {
        fail('你已被该房间移出，需由房间所有者或管理员解除后才能加入');
        return;
      }
      if (!passwordMatches(room, req.password)) {
        fail('房间密码不正确');
        return;
      }
      if (room.members.size >= ROOM_MEMBER_LIMIT) {
        fail(`房间成员已达上限（${ROOM_MEMBER_LIMIT}）`);
        return;
      }
      room.members.add(id);
      log('info', `${id} 加入房间「${room.name}」`, { roomId: room.id, members: room.members.size });
      controlResult(ws, env, 'room', true, { room: roomSummary(room, id, isAdmin) });
      touchRooms();
      return;
    }
    case 'leave': {
      const room = findRoom(req);
      if (!room) {
        fail('房间不存在');
        return;
      }
      if (!room.members.has(id)) {
        fail('你不在该房间中');
        return;
      }
      if (room.ownerId === id) {
        fail('你是该房间的所有者：请先解散房间（或由管理员代为解散）');
        return;
      }
      room.members.delete(id);
      log('info', `${id} 退出房间「${room.name}」`, { roomId: room.id, members: room.members.size });
      controlResult(ws, env, 'room', true, { roomId: room.id });
      touchRooms();
      return;
    }
    case 'rename':
    case 'passwd':
    case 'kick':
    case 'unblock':
    case 'dissolve': {
      const room = findRoom(req);
      if (!room) {
        fail('房间不存在');
        return;
      }
      if (!(room.ownerId === id || isAdmin)) {
        fail('只有房间所有者或管理员可以执行该操作');
        return;
      }
      if (op === 'rename') {
        const name = String(req.name || '').trim().slice(0, ROOM_NAME_MAX);
        if (!name) {
          fail('房间名不能为空');
          return;
        }
        if ([...rooms.values()].some(other => other !== room && other.name === name)) {
          fail(`房间名「${name}」已存在`);
          return;
        }
        room.name = name;
      } else if (op === 'passwd') {
        setRoomPassword(room, typeof req.password === 'string' ? req.password : '');
      } else if (op === 'kick') {
        const memberId = String(req.memberId || '');
        if (!memberId || !room.members.has(memberId)) {
          fail('该设备不在房间中');
          return;
        }
        if (memberId === room.ownerId) {
          fail('不能移出房间所有者');
          return;
        }
        room.members.delete(memberId);
        room.blocked.add(memberId);
      } else if (op === 'unblock') {
        const memberId = String(req.memberId || '');
        if (!room.blocked.has(memberId)) {
          fail('该设备不在禁止名单里');
          return;
        }
        room.blocked.delete(memberId);
      } else {
        rooms.delete(room.id);
      }
      log('warn', `房间操作 ${op}`, { roomId: room.id, name: room.name, by: id, admin: isAdmin });
      controlResult(ws, env, 'room', true, {
        roomId: room.id,
        ...(rooms.has(room.id) ? { room: roomSummary(room, id, isAdmin) } : {}),
      });
      touchRooms();
      return;
    }
    default:
      fail(`不支持的操作「${op || '(空)'}」`);
  }
}

/** 管理操作：list / kick / ban / unban（需要管理令牌通过） */
function handleAdminOp(ws, id, env) {
  const op = typeof env.op === 'string' ? env.op : '';
  const req = env.payload && typeof env.payload === 'object' ? env.payload : {};
  const fail = error => controlResult(ws, env, 'admin', false, undefined, error);
  if (!ADMIN_TOKEN) {
    fail('中继未配置管理令牌（TALK2COPILOT_ADMIN_TOKEN），管理功能不可用');
    return;
  }
  if (ws.isAdmin !== true) {
    fail('管理令牌不正确：请在配置界面「连接」里填写正确的管理令牌后重试');
    return;
  }
  const kickOut = (target, code, reason) => {
    const targetWs = peers.get(target);
    peers.delete(target);
    profiles.delete(target);
    if (targetWs) {
      targetWs.close(code, reason);
    }
  };
  switch (op) {
    case 'list': {
      const devices = [...peers.entries()].map(([peerId, peerWs]) => ({
        id: peerId,
        version: peerWs.clientVersion || '(未上报)',
        admin: peerWs.isAdmin === true,
        roomIds: [...rooms.values()].filter(room => room.members.has(peerId)).map(room => room.id),
      }));
      controlResult(ws, env, 'admin', true, { devices, bans: [...banned], relayVersion: RELAY_VERSION });
      return;
    }
    case 'kick': {
      const target = String(req.target || '');
      if (!target) {
        fail('未指定目标设备');
        return;
      }
      if (target === id) {
        fail('不能踢出自己');
        return;
      }
      if (!peers.has(target)) {
        fail(`设备 ${target} 不在线`);
        return;
      }
      kickOut(target, 4006, 'kicked by admin');
      log('warn', `管理员 ${id} 踢出设备 ${target}`, { online: peers.size });
      controlResult(ws, env, 'admin', true, { target });
      broadcastPresence();
      return;
    }
    case 'ban': {
      const target = String(req.target || '');
      if (!target) {
        fail('未指定目标设备');
        return;
      }
      if (target === id) {
        fail('不能封禁自己');
        return;
      }
      if (target === 'server') {
        fail('不能封禁保留地址 server');
        return;
      }
      banned.add(target);
      saveBans();
      // 封禁后其离线暂存消息一并清除，避免解封后收到陈年旧消息
      offline.delete(target);
      kickOut(target, 4007, 'banned');
      log('warn', `管理员 ${id} 封禁设备 ${target}`, { bans: banned.size });
      controlResult(ws, env, 'admin', true, { target, bans: [...banned] });
      // 房间摘要里的 bannedMembers 也会变化，用 touchRooms 一并下发
      touchRooms();
      return;
    }
    case 'unban': {
      const target = String(req.target || '');
      if (!banned.has(target)) {
        fail(`设备 ${target || '(空)'} 不在封禁名单里`);
        return;
      }
      banned.delete(target);
      saveBans();
      log('warn', `管理员 ${id} 解除封禁 ${target}`, { bans: banned.size });
      controlResult(ws, env, 'admin', true, { target, bans: [...banned] });
      touchRooms();
      return;
    }
    default:
      fail(`不支持的操作「${op || '(空)'}」`);
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  // 探针端点：只回计数与状态，不回任何 id
  if (pathname === '/healthz') {
    const body = JSON.stringify({
      status: 'ok',
      version: RELAY_VERSION,
      protocol: PROTOCOL,
      uptimeSec: Math.round(process.uptime()),
      peers: peers.size,
      rooms: rooms.size,
      bans: banned.size,
      queued: queuedCount(),
      tokenRequired: TOKEN !== '',
      adminEnabled: ADMIN_TOKEN !== '',
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
  const clientVersion = String(req.headers['x-client-version'] || '');
  const adminHeader = String(req.headers['x-admin-token'] || '');

  if (!tokenMatches(auth)) {
    log('warn', '拒绝连接：令牌不正确', { ip: remoteOf(req) });
    ws.close(4001, 'unauthorized');
    return;
  }
  // 版本门禁：扩展必须与中继同步升级（-testN 后缀忽略），否则拒绝接入
  if (normalizeVersion(clientVersion) !== normalizeVersion(RELAY_VERSION)) {
    log('warn', '拒绝连接：扩展版本与中继不一致', {
      id, relayVersion: RELAY_VERSION, clientVersion: clientVersion || '(未上报)', ip: remoteOf(req),
    });
    ws.close(4008, `version mismatch: relay ${RELAY_VERSION}`);
    return;
  }
  if (!id) {
    log('warn', '拒绝连接：缺少 id', { ip: remoteOf(req) });
    ws.close(4002, 'missing id');
    return;
  }
  if (id === 'server') {
    // 'server' 是档案上报的保留地址，不能同时作为设备 id，否则该设备的消息会被静默吞掉
    log('warn', '拒绝连接：id 为保留地址', { id, ip: remoteOf(req) });
    ws.close(4002, 'reserved id');
    return;
  }
  if (banned.has(id)) {
    log('warn', '拒绝连接：设备已被封禁', { id, ip: remoteOf(req) });
    ws.close(4007, 'banned');
    return;
  }
  // 管理令牌：错误不影响普通连接，只是该连接不具备管理权限
  ws.clientVersion = clientVersion;
  ws.isAdmin = ADMIN_TOKEN !== '' && adminHeader !== '' && timingSafeEqualStr(adminHeader, ADMIN_TOKEN);

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
  log('info', `${id} 已上线`, {
    online: peers.size, ip: remoteOf(req), version: clientVersion || '(未上报)', admin: ws.isAdmin === true,
  });

  const pending = offline.get(id);
  if (pending && pending.length > 0) {
    offline.delete(id);
    for (const env of pending) {
      send(ws, env);
    }
    log('info', `补发离线消息 ${pending.length} 条给 ${id}`);
  }
  touchRooms();
  // 房间摘要含在线成员：上下线会改变它，因此这里用 touchRooms（presence + room-event）而不是只广播 presence

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
    if (!env || typeof env.to !== 'string' || env.kind === 'presence' || env.kind === 'room-event' || env.kind === 'error') {
      return;
    }
    // 控制面与档案上报：客户端以 to='server' 发送，均由中继处理，不进离线暂存队列
    if (env.to === 'server') {
      if (env.kind === 'room') {
        handleRoomOp(ws, id, env);
        return;
      }
      if (env.kind === 'admin') {
        handleAdminOp(ws, id, env);
        return;
      }
      if (env.profile && typeof env.profile === 'object') {
        const role = (typeof env.profile.role === 'string' ? env.profile.role : '').slice(0, 200);
        const scope = (typeof env.profile.scope === 'string' ? env.profile.scope : '').slice(0, 200);
        const previous = profiles.get(id);
        // 值未变化就不广播，避免客户端重复上报把全量目录刷爆
        if (!previous || previous.role !== role || previous.scope !== scope) {
          profiles.set(id, { id, role, scope });
          log('info', `${id} 已上报档案`, { roleChars: role.length, scopeChars: scope.length, total: profiles.size });
          broadcastPresence();
        }
      }
      return;
    }
    // 转发白名单：控制面与 error 只能由中继产生，客户端不得借转发互相投递
    if (!FORWARDABLE.has(env.kind)) {
      log('debug', '拒绝转发：kind 不在白名单内', { from: id, to: env.to, kind: String(env.kind) });
      return;
    }
    // 房间准入：只放行同房间成员之间的转发（管理令牌不豁免）；拒绝时向发送方回执
    if (!shareRoom(id, env.to)) {
      log('warn', '拒绝转发：与目标没有共同房间', { from: id, to: env.to, kind: env.kind });
      // 下线通告是尽力而为的提示，静默丢弃即可，不必回执打扰发送方
      if (env.kind !== 'offline') {
        send(ws, {
          v: 1,
          kind: 'error',
          id: `err-${++seq}`,
          from: 'server',
          to: id,
          ts: Date.now(),
          refId: typeof env.id === 'string' ? env.id : '',
          error: `与 ${env.to} 没有共同房间，消息未送达`,
        });
      }
      return;
    }
    // 身份绑定：from 一律改写为连接的真实 id，并丢弃客户端自带的档案——
    // 否则同房间成员可冒充他人（用对方 id 发消息、伪造角色）投递；档案以本连接经 to='server' 上报的为准
    env.from = id;
    delete env.profile;
    const target = peers.get(env.to);
    if (target && target.readyState === target.OPEN) {
      send(target, env);
    } else if (banned.has(env.to)) {
      // 封禁目标不再暂存（否则解封后会一次性补发陈年消息），并向发送方回执
      log('debug', '目标已被中继封禁，消息不暂存', { from: id, to: env.to, kind: env.kind });
      if (env.kind !== 'offline') {
        send(ws, {
          v: 1,
          kind: 'error',
          id: `err-${++seq}`,
          from: 'server',
          to: id,
          ts: Date.now(),
          refId: typeof env.id === 'string' ? env.id : '',
          error: `${env.to} 已被中继管理员封禁，消息未送达`,
        });
      }
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
      // 按连接归属删除档案：被接管连接的迟到 close 不会清掉新连接的档案
      profiles.delete(id);
      log('info', `${id} 已离线`, { online: peers.size });
      if (!shuttingDown) {
        // 在场成员离线同样会改变房间摘要里的在线成员，需一并下发 room-event
        touchRooms();
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

loadBans();

server.listen(PORT, HOST, () => {
  log('info', '中继服务已启动', {
    address: `http://${HOST}:${PORT}`,
    version: RELAY_VERSION,
    protocol: PROTOCOL,
    tokenRequired: TOKEN !== '',
    adminEnabled: ADMIN_TOKEN !== '',
    banFile: BAN_FILE,
    logLevel: LOG_LEVEL,
    offlineLimit: OFFLINE_LIMIT,
    pid: process.pid,
  });
});
