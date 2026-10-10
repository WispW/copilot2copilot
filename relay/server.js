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
 *   TALK2COPILOT_ROOMS_FILE     房间 / 分类状态落盘路径；默认同目录下的 rooms.json
 *   TALK2COPILOT_MEMORY_FILE    房间共享记忆落盘路径；默认同目录下的 memory.json
 *   TALK2COPILOT_RELAY_VERSION  覆盖中继版本号（仅供测试）；默认取内置 RELAY_VERSION
 *   LOG_LEVEL                   error | warn | info | debug，默认 info
 *
 * 端点：/  存活文本；/healthz  JSON 状态（含中继版本与协议号，不含任何 id）
 *       /peers  在线 id 列表（需令牌），供客户端连接前自查 id 是否被占用
 * 版本门禁：客户端须在握手头 x-client-version 上报扩展版本（-testN / -testN.M 后缀忽略），
 *       与中继 RELAY_VERSION 不一致即拒绝（4008）——中继与扩展必须同步升级。
 * 房间（可见域）：房间列表（名称 / 分类 / 人数 / 是否有密码）对所有设备可见，凭密码加入；
 *       成员明细仅成员与管理员可见。设备只能"看到"（presence）并只能与同房间成员通信
 *       （转发前强制校验，管理令牌不豁免）；未加入任何房间的设备与所有人互相不可见。
 *       房间、分类、成员名单与禁止名单由中继管理员（管理令牌）统一维护：创建 / 改名 / 改密码 / 归类 /
 *       移出成员（进禁止名单）/ 解除禁止 / 解散；分类仅用于分组与排序，不承载任何权限。
 *       房间状态落盘到 rooms.json（systemd StateDirectory），重启保留；封禁名单落盘在 bans.json。
 * 共享记忆（memory）：房间内成员共用的可编辑事实库，中继是唯一权威存储——权限、乐观锁、词法检索
 *       与生命周期都在服务端完成；条目全员可编辑（带 revision 校验），管理员可跨房间浏览与管理。
 *       状态落盘到 memory.json，房间解散时级联删除。
 * 管理令牌：持有者可踢出 / 封禁 / 解封任意设备，并管理所有房间与分类。
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
const RELAY_VERSION = process.env.TALK2COPILOT_RELAY_VERSION || '2026.10.10';
/** 协议号：与扩展 src/protocol.ts 的 PROTOCOL_VERSION 对应，仅供探针展示 */
// 协议 5：新增信任授权通道（成员上报"我授权谁对我执行写操作"，中继下发"我被谁授权"）
const PROTOCOL = 5;
/** 管理令牌：为空时管理功能整体不可用（不给任何人管理权限） */
const ADMIN_TOKEN = process.env.TALK2COPILOT_ADMIN_TOKEN || '';
/** 封禁名单落盘路径：systemd 单元通过 StateDirectory 提供可写目录 */
const BAN_FILE = process.env.TALK2COPILOT_BAN_FILE
  || path.join(process.env.STATE_DIRECTORY || __dirname, 'bans.json');
/** 房间 / 分类状态落盘路径：与封禁名单同目录，重启后房间与成员保留 */
const ROOMS_FILE = process.env.TALK2COPILOT_ROOMS_FILE
  || path.join(process.env.STATE_DIRECTORY || __dirname, 'rooms.json');
/** 状态文件格式版本：便于以后迁移（当前只写不读，读到旧版本按缺字段容错） */
const STATE_VERSION = 1;
/** 房间上限与单房间成员上限（防滥用） */
const ROOM_LIMIT = 50;
const ROOM_MEMBER_LIMIT = 32;
const ROOM_NAME_MAX = 32;
/** 分类上限与分类名长度上限（分类仅用于分组与排序） */
const CATEGORY_LIMIT = 20;
const CATEGORY_NAME_MAX = 32;
/** 共享记忆：落盘路径、容量与限流（满了拒绝新写、不自动淘汰） */
const MEMORY_FILE = process.env.TALK2COPILOT_MEMORY_FILE
  || path.join(process.env.STATE_DIRECTORY || __dirname, 'memory.json');
const MEMORY_STATE_VERSION = 1;
const MEMORY_ROOM_LIMIT = 500;    // 单房间「未删除」条目上限
const MEMORY_TOTAL_LIMIT = 5000;  // 全局条目上限（含软删除）
const MEMORY_TEXT_MAX = 2000;
const MEMORY_TAG_MAX = 8;
const MEMORY_TAG_LEN = 32;
const MEMORY_HISTORY_MAX = 10;
const MEMORY_HISTORY_BYTES = 8 * 1024;
const MEMORY_WRITE_LIMIT = 30;    // 每设备每窗口写操作上限
const MEMORY_WRITE_WINDOW_MS = 60 * 1000;
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
/** 写授权：grantor → 被授权的同事集合（内存态；设备离线即收回，中继重启清空） */
const trustGrants = new Map();
/** @type {Map<string, object[]>} */
const offline = new Map();
/**
 * 房间表（可见域）：房间 id 稳定，随房间状态落盘。
 * @type {Map<string, {id: string, name: string, categoryId: string, createdBy: string,
 *   passHash: string, passSalt: string,
 *   members: Set<string>, blocked: Set<string>, createdAt: number}>}
 */
const rooms = new Map();
/**
 * 房间分类：仅用于分组与排序（不承载任何权限），由管理员维护，随房间状态落盘。
 * @type {{id: string, name: string, createdAt: number}[]}
 */
const categories = [];
/** 封禁名单（设备 id）：连接时拒绝（4007），落盘保留 */
const banned = new Set();
let roomSeq = 0;
let categorySeq = 0;
/**
 * 房间共享记忆（中继唯一权威存储）：memories 为条目 id → 条目，
 * memoryByRoom 维护房间 → 条目 id 集合，加速房间内遍历与级联删除。
 * @type {Map<string, object>}
 */
const memories = new Map();
/** @type {Map<string, Set<string>>} */
const memoryByRoom = new Map();
let memorySeq = 0;
/** 记忆写入限流：设备 id → 最近写入时间戳列表 */
const memoryWrites = new Map();
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

/** 版本号归一化：忽略 -testN / -testN.M 后缀，测试包与正式包视为同一版本 */
function normalizeVersion(value) {
  return String(value || '').trim().replace(/-test[\d.]+$/i, '');
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

function newCategoryId() {
  return `c${Date.now().toString(36)}${(++categorySeq).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

/** 房间状态（分类 + 房间 + 成员 / 禁止名单）：任何变更后立即原子落盘（人工操作，频率低） */
function saveState() {
  const data = {
    version: STATE_VERSION,
    categories,
    rooms: [...rooms.values()].map(room => ({
      id: room.id,
      name: room.name,
      categoryId: room.categoryId,
      createdBy: room.createdBy,
      passSalt: room.passSalt,
      passHash: room.passHash,
      members: [...room.members],
      blocked: [...room.blocked],
      createdAt: room.createdAt,
    })),
  };
  try {
    // 先写临时文件再改名：进程中途退出也不会留下半个 JSON
    const tmp = `${ROOMS_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, ROOMS_FILE);
  } catch (err) {
    log('warn', '房间状态写入失败（本次仅内存生效，重启会丢失）', { file: ROOMS_FILE, error: err.message });
  }
}

/** 载入房间状态；文件损坏时改名备份后从空状态开始，绝不静默丢数据 */
function loadState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('info', '房间状态文件不存在，从空状态开始', { file: ROOMS_FILE });
      return;
    }
    const backup = `${ROOMS_FILE}.bad-${Date.now()}`;
    try {
      fs.renameSync(ROOMS_FILE, backup);
      log('error', '房间状态文件无法解析，已改名备份后从空状态开始', { file: ROOMS_FILE, backup, error: err.message });
    } catch (renameErr) {
      log('error', '房间状态文件无法解析且备份失败，从空状态开始', { file: ROOMS_FILE, error: renameErr.message });
    }
    return;
  }
  if (Array.isArray(raw?.categories)) {
    for (const category of raw.categories) {
      if (typeof category?.id === 'string' && category.id && typeof category?.name === 'string' && category.name) {
        categories.push({ id: category.id, name: category.name, createdAt: Number(category.createdAt) || Date.now() });
      }
    }
  }
  if (Array.isArray(raw?.rooms)) {
    for (const room of raw.rooms) {
      if (typeof room?.id !== 'string' || !room.id || typeof room?.name !== 'string' || !room.name) {
        continue;
      }
      rooms.set(room.id, {
        id: room.id,
        name: room.name,
        categoryId: typeof room.categoryId === 'string' ? room.categoryId : '',
        createdBy: typeof room.createdBy === 'string' ? room.createdBy : '',
        passSalt: typeof room.passSalt === 'string' ? room.passSalt : '',
        passHash: typeof room.passHash === 'string' ? room.passHash : '',
        members: new Set(Array.isArray(room.members) ? room.members.filter(member => typeof member === 'string' && member) : []),
        blocked: new Set(Array.isArray(room.blocked) ? room.blocked.filter(member => typeof member === 'string' && member) : []),
        createdAt: Number(room.createdAt) || Date.now(),
      });
    }
  }
  // 归类信息指向不存在的分类时归为「未分类」，避免界面出现悬空分组
  const known = new Set(categories.map(category => category.id));
  for (const room of rooms.values()) {
    if (room.categoryId && !known.has(room.categoryId)) {
      room.categoryId = '';
    }
  }
  log('info', '已载入房间状态', { rooms: rooms.size, categories: categories.length, file: ROOMS_FILE });
}

// ---------------------------------------------------------------------------
// 共享记忆：中继是唯一权威存储（权限 / 乐观锁 / 词法检索 / 生命周期都在服务端）
// ---------------------------------------------------------------------------

function newMemoryId() {
  return `mem${Date.now().toString(36)}${(++memorySeq).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

function memoryRoomSet(roomId) {
  let set = memoryByRoom.get(roomId);
  if (!set) {
    set = new Set();
    memoryByRoom.set(roomId, set);
  }
  return set;
}

function memoryIndexAdd(entry) {
  memories.set(entry.id, entry);
  memoryRoomSet(entry.roomId).add(entry.id);
}

function memoryIndexRemove(entryId) {
  const entry = memories.get(entryId);
  if (!entry) {
    return;
  }
  memories.delete(entryId);
  const set = memoryByRoom.get(entry.roomId);
  if (set) {
    set.delete(entryId);
    if (set.size === 0) {
      memoryByRoom.delete(entry.roomId);
    }
  }
}

/** 删除某房间的全部记忆（房间解散时级联），返回删除条数 */
function purgeRoomMemories(roomId) {
  const set = memoryByRoom.get(roomId);
  if (!set) {
    return 0;
  }
  const count = set.size;
  for (const entryId of [...set]) {
    memories.delete(entryId);
  }
  memoryByRoom.delete(roomId);
  return count;
}

/** 房间内未删除的记忆条数（房间摘要用） */
function activeMemoryCount(roomId) {
  const set = memoryByRoom.get(roomId);
  if (!set) {
    return 0;
  }
  let count = 0;
  for (const entryId of set) {
    const entry = memories.get(entryId);
    if (entry && !entry.deleted) {
      count += 1;
    }
  }
  return count;
}

/** 房间记忆统计（管理员界面用） */
function memoryRoomStats(roomId) {
  const set = memoryByRoom.get(roomId);
  let total = 0;
  let deleted = 0;
  let bytes = 0;
  for (const entryId of set || []) {
    const entry = memories.get(entryId);
    if (!entry) {
      continue;
    }
    total += 1;
    if (entry.deleted) {
      deleted += 1;
    }
    bytes += Buffer.byteLength(entry.text, 'utf8');
  }
  return { total, active: total - deleted, deleted, bytes };
}

/** 记忆状态：任何变更后原子落盘（与 rooms.json 同一模式） */
function saveMemory() {
  const data = {
    version: MEMORY_STATE_VERSION,
    entries: [...memories.values()].map(entry => ({
      id: entry.id,
      roomId: entry.roomId,
      text: entry.text,
      tags: entry.tags,
      author: entry.author,
      createdAt: entry.createdAt,
      revision: entry.revision,
      updatedBy: entry.updatedBy,
      updatedAt: entry.updatedAt,
      ...(entry.sourceRequestId ? { sourceRequestId: entry.sourceRequestId } : {}),
      ...(entry.deleted ? { deleted: entry.deleted } : {}),
      history: entry.history,
    })),
  };
  try {
    const tmp = `${MEMORY_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, MEMORY_FILE);
  } catch (err) {
    log('warn', '记忆状态写入失败（本次仅内存生效，重启会丢失）', { file: MEMORY_FILE, error: err.message });
  }
}

/** 载入记忆状态；文件损坏时改名备份后从空状态开始，不静默丢数据 */
function loadMemory() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('info', '记忆状态文件不存在，从空状态开始', { file: MEMORY_FILE });
      return;
    }
    const backup = `${MEMORY_FILE}.bad-${Date.now()}`;
    try {
      fs.renameSync(MEMORY_FILE, backup);
      log('error', '记忆状态文件无法解析，已改名备份后从空状态开始', { file: MEMORY_FILE, backup, error: err.message });
    } catch (renameErr) {
      log('error', '记忆状态文件无法解析且备份失败，从空状态开始', { file: MEMORY_FILE, error: renameErr.message });
    }
    return;
  }
  if (Array.isArray(raw?.entries)) {
    for (const item of raw.entries) {
      if (typeof item?.id !== 'string' || !item.id || typeof item?.roomId !== 'string' || !item.roomId) {
        continue;
      }
      if (typeof item?.text !== 'string' || !item.text) {
        continue;
      }
      const history = Array.isArray(item.history)
        ? item.history
          .filter(version => version && typeof version.text === 'string')
          .slice(-MEMORY_HISTORY_MAX)
          .map(version => ({
            revision: Number(version.revision) || 1,
            by: typeof version.by === 'string' ? version.by : '',
            at: Number(version.at) || Date.now(),
            text: version.text.slice(0, MEMORY_TEXT_MAX),
            tags: Array.isArray(version.tags)
              ? version.tags.filter(tag => typeof tag === 'string').slice(0, MEMORY_TAG_MAX)
              : [],
          }))
        : [];
      memoryIndexAdd({
        id: item.id,
        roomId: item.roomId,
        text: item.text.slice(0, MEMORY_TEXT_MAX),
        tags: Array.isArray(item.tags)
          ? item.tags.filter(tag => typeof tag === 'string').slice(0, MEMORY_TAG_MAX)
          : [],
        author: typeof item.author === 'string' ? item.author : '',
        createdAt: Number(item.createdAt) || Date.now(),
        revision: Number(item.revision) || 1,
        updatedBy: typeof item.updatedBy === 'string'
          ? item.updatedBy
          : (typeof item.author === 'string' ? item.author : ''),
        updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
        ...(typeof item.sourceRequestId === 'string' && item.sourceRequestId
          ? { sourceRequestId: item.sourceRequestId }
          : {}),
        ...(item.deleted && typeof item.deleted === 'object'
          ? { deleted: { by: String(item.deleted.by ?? ''), at: Number(item.deleted.at) || Date.now() } }
          : {}),
        history,
      });
    }
  }
  // 所属房间已不存在（rooms.json 损坏 / 被手工改动等）的条目不可达：
  // 先把原 memory.json 另存一份再丢弃，避免后续写入用（几乎为空的）内存集合覆盖原文件造成不可逆丢失；
  // 备份失败时保留孤儿条目在内存中——宁可在文件里多留，也不静默丢数据。
  const orphanRoomIds = [...memoryByRoom.keys()].filter(roomId => !rooms.has(roomId));
  let orphaned = 0;
  if (orphanRoomIds.length > 0) {
    const backup = `${MEMORY_FILE}.orphaned-${Date.now()}`;
    try {
      fs.copyFileSync(MEMORY_FILE, backup);
      for (const roomId of orphanRoomIds) {
        orphaned += purgeRoomMemories(roomId);
      }
      log('warn', '记忆条目所属房间缺失：原文件已另存备份，孤儿条目已丢弃', { orphaned, backup });
    } catch (err) {
      log('error', '记忆条目所属房间缺失且备份失败：保留孤儿条目，避免覆盖丢失', {
        rooms: orphanRoomIds.length, file: MEMORY_FILE, error: err.message,
      });
    }
  }
  log('info', '已载入记忆状态', { entries: memories.size, rooms: memoryByRoom.size, orphaned, file: MEMORY_FILE });
}

/** 记忆条目对外视图：附房间名，可选附历史 */
function memoryView(entry, options = {}) {
  const room = rooms.get(entry.roomId);
  return {
    id: entry.id,
    roomId: entry.roomId,
    roomName: room ? room.name : '',
    text: entry.text,
    tags: entry.tags,
    author: entry.author,
    createdAt: entry.createdAt,
    revision: entry.revision,
    updatedBy: entry.updatedBy,
    updatedAt: entry.updatedAt,
    ...(entry.sourceRequestId ? { sourceRequestId: entry.sourceRequestId } : {}),
    ...(entry.deleted ? { deleted: entry.deleted } : {}),
    ...(options.withHistory ? { history: entry.history } : {}),
  };
}

/** 标签清洗：返回 undefined 表示格式不合法 */
function sanitizeMemoryTags(raw) {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tags = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      return undefined;
    }
    const tag = value.trim().slice(0, MEMORY_TAG_LEN);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
    if (tags.length > MEMORY_TAG_MAX) {
      return undefined;
    }
  }
  return tags;
}

/** 历史版本裁剪：最多 10 版、总量不超过 8 KB（超出丢最旧） */
function trimMemoryHistory(entry) {
  while (entry.history.length > MEMORY_HISTORY_MAX) {
    entry.history.shift();
  }
  let bytes = entry.history.reduce((total, version) => total + Buffer.byteLength(version.text || '', 'utf8'), 0);
  while (entry.history.length > 1 && bytes > MEMORY_HISTORY_BYTES) {
    bytes -= Buffer.byteLength(entry.history[0].text || '', 'utf8');
    entry.history.shift();
  }
}

/**
 * 记忆检索分词：ASCII 词 / 标识符保留原样，中文按 bigram。
 * 规范化：剥掉首尾标点（. + - $ # @），并把由 . / - / + 连接的段拆分索引（同时保留全串）——
 * 这样 `BIN512.` 能命中 `BIN512`、`qq341` 能命中 `qq341-b2d8`，且 `OrderService.pageSize` 仍可按整串精确命中。
 */
function memoryTokens(input) {
  const text = String(input || '').toLowerCase();
  const tokens = [];
  for (const match of text.match(/[a-z0-9_$#@.+-]+/g) || []) {
    const whole = match.replace(/^[.+\-$#@]+/, '').replace(/[.+\-$#@]+$/, '');
    if (!whole) {
      continue;
    }
    tokens.push(whole);
    if (/[.+-]/.test(whole)) {
      for (const part of whole.split(/[.+-]+/)) {
        if (part) {
          tokens.push(part);
        }
      }
    }
  }
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 词法打分：正文命中 + 标签加权 + 短语 / 标识符加成 + 轻度时间衰减 */
function scoreMemory(entry, queryTokens, rawQuery) {
  const textLower = entry.text.toLowerCase();
  const counts = new Map();
  for (const token of memoryTokens(entry.text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const tagTokens = new Set(memoryTokens(entry.tags.join(' ')));
  let score = 0;
  for (const token of new Set(queryTokens)) {
    if (counts.has(token)) {
      score += 1 + Math.min(counts.get(token), 3) * 0.2;
    }
    if (tagTokens.has(token)) {
      score += 2;
    }
  }
  if (score <= 0) {
    return 0;
  }
  const phrase = rawQuery.trim().toLowerCase();
  if (phrase.length >= 2 && textLower.includes(phrase)) {
    score += 3;
  }
  for (const token of new Set(queryTokens)) {
    if (token.length >= 4 && /[a-z]/.test(token) && counts.has(token)) {
      score += 1;
    }
  }
  // 轻度时间衰减：半衰期 90 天、最旧保留 75% 权重，避免旧知识被完全埋没
  const ageDays = Math.max(0, (Date.now() - entry.updatedAt) / 86400000);
  score *= 0.75 + 0.25 * Math.pow(0.5, ageDays / 90);
  return score;
}

/** 写入限流：每设备滑动窗口内最多 MEMORY_WRITE_LIMIT 次写操作 */
function memoryWriteAllowed(deviceId) {
  const now = Date.now();
  const recent = (memoryWrites.get(deviceId) || []).filter(ts => now - ts < MEMORY_WRITE_WINDOW_MS);
  if (recent.length >= MEMORY_WRITE_LIMIT) {
    memoryWrites.set(deviceId, recent);
    return false;
  }
  recent.push(now);
  memoryWrites.set(deviceId, recent);
  return true;
}

/** 定位条目并校验请求者在条目所属房间中；管理员不受房间限制 */
function memoryEntryFor(deviceId, entryId, isAdmin) {
  const entry = typeof entryId === 'string' ? memories.get(entryId) : undefined;
  if (!entry) {
    return { error: '记忆不存在' };
  }
  const room = rooms.get(entry.roomId);
  if (!room) {
    return { error: '记忆所属房间不存在' };
  }
  if (!isAdmin && !room.members.has(deviceId)) {
    return { error: '你不在该记忆所属的房间中' };
  }
  return { entry, room };
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

/**
 * 房间摘要：列表（名称 / 分类 / 人数 / 是否有密码）对所有设备可见，凭密码加入；
 * 成员明细仅同房间成员与管理员可见；禁止名单与被中继封禁的成员仅管理员可见。
 */
function roomSummary(room, viewerId, isAdmin) {
  const mine = room.members.has(viewerId);
  return {
    id: room.id,
    name: room.name,
    categoryId: room.categoryId,
    createdBy: room.createdBy,
    hasPassword: Boolean(room.passHash),
    memberCount: room.members.size,
    /** 房间内未删除的共享记忆条数（供界面提示，不暴露内容） */
    memoryCount: activeMemoryCount(room.id),
    joined: mine,
    // 成员集合在设备离线后仍保留（房间是可见域），在线情况另给一份，供界面标注「离线」
    ...(mine || isAdmin ? {
      members: [...room.members],
      onlineMembers: [...room.members].filter(member => peers.has(member)),
    } : {}),
    ...(isAdmin ? { blocked: [...room.blocked] } : {}),
    // 设备级封禁（中继层）的成员：让管理员知道"人不见了/连不上"是中继封禁，需管理员解封
    ...(isAdmin ? { bannedMembers: [...room.members].filter(member => banned.has(member)) } : {}),
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

/** room-event：按接收者定制的房间列表与分类（访客只看到公开摘要；分类对所有设备可见） */
function roomEventPayload(id, isAdmin) {
  return {
    v: 1,
    kind: 'room-event',
    id: `rooms-${++seq}`,
    from: 'server',
    to: '*',
    ts: Date.now(),
    categories: categories.map(category => ({ ...category })),
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

/** 信任授权状态下发：告诉每个在线设备"你被哪些同事授权了写操作" */
function broadcastTrustState() {
  for (const [id, ws] of peers) {
    const grantedBy = [];
    for (const [grantor, grantees] of trustGrants) {
      if (grantor !== id && grantees.has(id)) {
        grantedBy.push(grantor);
      }
    }
    send(ws, {
      v: 1,
      kind: 'trust',
      id: `trust-${++seq}`,
      from: 'server',
      to: id,
      ts: Date.now(),
      op: 'grantedBy',
      payload: { grantedBy },
    });
  }
}

/**
 * 成员侧信任操作：report —— 上报"我授权了哪些同事可以对我执行写操作"（全量覆盖、内存态）。
 * 授权只在授予者在线期间有效；断线/被踢出即收回，重连后客户端会重新上报。
 */
function handleTrustOp(ws, id, env) {
  const op = typeof env.op === 'string' ? env.op : '';
  const fail = error => controlResult(ws, env, 'trust', false, undefined, error);
  switch (op) {
    case 'report': {
      const req = env.payload && typeof env.payload === 'object' ? env.payload : {};
      const list = Array.isArray(req.grantees)
        ? req.grantees.filter(x => typeof x === 'string' && x && x !== id)
        : [];
      trustGrants.set(id, new Set(list));
      log('info', `${id} 上报写授权名单`, { count: list.length });
      controlResult(ws, env, 'trust', true, { ok: true });
      broadcastTrustState();
      return;
    }
    default:
      fail(`不支持的信任操作「${op || '(空)'}」`);
  }
}

/**
 * 成员侧房间操作：list / join / leave。
 * 建房与房间管理（改名 / 改密码 / 归类 / 移出成员 / 解除 / 解散）全部由管理员在 handleAdminOp 中执行。
 */
function handleRoomOp(ws, id, env) {
  const isAdmin = ws.isAdmin === true;
  const op = typeof env.op === 'string' ? env.op : '';
  const req = env.payload && typeof env.payload === 'object' ? env.payload : {};
  const fail = error => controlResult(ws, env, 'room', false, undefined, error);
  switch (op) {
    case 'list':
      controlResult(ws, env, 'room', true, {
        rooms: [...rooms.values()].map(room => roomSummary(room, id, isAdmin)),
        categories: categories.map(category => ({ ...category })),
      });
      return;
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
        fail('你已被该房间移出，需由中继管理员解除后才能加入');
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
      saveState();
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
      room.members.delete(id);
      saveState();
      log('info', `${id} 退出房间「${room.name}」`, { roomId: room.id, members: room.members.size });
      controlResult(ws, env, 'room', true, { roomId: room.id });
      touchRooms();
      return;
    }
    default:
      fail(`不支持的操作「${op || '(空)'}」`);
  }
}

/**
 * 成员侧记忆操作：list / get / query / remember / update / delete / restore。
 * 记忆由中继托管：房间成员身份、乐观锁、容量与限流都在这里校验；
 * 管理员的管理操作（memory-*）在 handleAdminOp 中。
 */
function handleMemoryOp(ws, id, env) {
  const isAdmin = ws.isAdmin === true;
  const op = typeof env.op === 'string' ? env.op : '';
  const req = env.payload && typeof env.payload === 'object' ? env.payload : {};
  const fail = (error, payload) => controlResult(ws, env, 'memory', false, payload, error);
  const ok = payload => controlResult(ws, env, 'memory', true, payload);
  /** 我能看到的房间：成员身份为准；管理员不限 */
  const myRooms = () => [...rooms.values()].filter(room => isAdmin || room.members.has(id));
  /** 写入限流（只在实际发生写入前调用） */
  const rateLimited = () => {
    if (memoryWriteAllowed(id)) {
      return false;
    }
    fail(`写入过于频繁：每 ${MEMORY_WRITE_WINDOW_MS / 1000} 秒最多 ${MEMORY_WRITE_LIMIT} 次，请稍后再试`);
    return true;
  };
  switch (op) {
    case 'list': {
      const room = typeof req.roomId === 'string' ? rooms.get(req.roomId) : undefined;
      if (!room) {
        fail('房间不存在');
        return;
      }
      if (!isAdmin && !room.members.has(id)) {
        fail('你不在该房间中');
        return;
      }
      const includeDeleted = req.includeDeleted === true;
      const limit = Math.min(Math.max(Number(req.limit) || 50, 1), 100);
      const offset = Math.max(Number(req.cursor) || 0, 0);
      const all = [...(memoryByRoom.get(room.id) || [])]
        .map(entryId => memories.get(entryId))
        .filter(entry => entry && (includeDeleted || !entry.deleted))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const page = all.slice(offset, offset + limit);
      ok({
        roomId: room.id,
        total: all.length,
        nextCursor: offset + limit < all.length ? String(offset + limit) : '',
        entries: page.map(entry => memoryView(entry)),
      });
      return;
    }
    case 'get': {
      const found = memoryEntryFor(id, req.entryId, isAdmin);
      if (found.error) {
        fail(found.error);
        return;
      }
      ok({ entry: memoryView(found.entry, { withHistory: true }) });
      return;
    }
    case 'query': {
      const rawQuery = String(req.query || '').trim();
      if (!rawQuery) {
        fail('query 不能为空');
        return;
      }
      let scope;
      if (typeof req.roomId === 'string' && req.roomId) {
        const room = rooms.get(req.roomId);
        if (!room) {
          fail('房间不存在');
          return;
        }
        if (!isAdmin && !room.members.has(id)) {
          fail('你不在该房间中');
          return;
        }
        scope = [room];
      } else {
        scope = myRooms();
        if (scope.length === 0) {
          fail('你还没有加入任何房间，无法查询共享记忆');
          return;
        }
      }
      const topK = Math.min(Math.max(Number(req.topK) || 5, 1), 20);
      const tokens = memoryTokens(rawQuery);
      const hits = [];
      if (tokens.length > 0) {
        for (const room of scope) {
          for (const entryId of memoryByRoom.get(room.id) || []) {
            const entry = memories.get(entryId);
            if (!entry || entry.deleted) {
              continue;
            }
            const score = scoreMemory(entry, tokens, rawQuery);
            if (score > 0) {
              hits.push({ entry, score });
            }
          }
        }
      }
      hits.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
      const top = hits.slice(0, topK);
      ok({
        query: rawQuery,
        searchedRooms: scope.length,
        results: top.map(item => ({ ...memoryView(item.entry), score: Number(item.score.toFixed(3)) })),
        ...(top.length === 0
          ? { hint: '没有相关记忆，可正常向同事提问；拿到答复后再用 remember 记下来。' }
          : {}),
      });
      return;
    }
    case 'remember': {
      const explicitRoomId = typeof req.roomId === 'string' ? req.roomId : '';
      let room;
      if (explicitRoomId) {
        room = rooms.get(explicitRoomId);
        if (!room) {
          fail('房间不存在');
          return;
        }
      } else {
        const mine = myRooms();
        if (mine.length !== 1) {
          fail(mine.length === 0 ? '你还没有加入任何房间' : '你加入了多个房间，remember 必须指定 roomId');
          return;
        }
        [room] = mine;
      }
      if (!isAdmin && !room.members.has(id)) {
        fail('你不在该房间中');
        return;
      }
      const text = String(req.text || '').trim();
      if (!text) {
        fail('text 不能为空');
        return;
      }
      if (text.length > MEMORY_TEXT_MAX) {
        fail(`正文超出上限（${MEMORY_TEXT_MAX} 字符）`);
        return;
      }
      const tags = sanitizeMemoryTags(req.tags);
      if (tags === undefined) {
        fail(`标签格式不正确（最多 ${MEMORY_TAG_MAX} 个、每个 ${MEMORY_TAG_LEN} 字符以内的字符串）`);
        return;
      }
      // 去重：同房间、未删除、正文归一化后相同 → 返回已有条目，不新增
      const normalized = text.replace(/\s+/g, ' ').toLowerCase();
      for (const entryId of memoryByRoom.get(room.id) || []) {
        const entry = memories.get(entryId);
        if (entry && !entry.deleted && entry.text.replace(/\s+/g, ' ').toLowerCase() === normalized) {
          ok({ entry: memoryView(entry), duplicated: true });
          return;
        }
      }
      if (activeMemoryCount(room.id) >= MEMORY_ROOM_LIMIT) {
        fail(`房间「${room.name}」的记忆已达上限（${MEMORY_ROOM_LIMIT} 条），请先在界面清理`);
        return;
      }
      if (memories.size >= MEMORY_TOTAL_LIMIT) {
        fail(`中继记忆总量已达上限（${MEMORY_TOTAL_LIMIT} 条），请管理员清理`);
        return;
      }
      if (rateLimited()) {
        return;
      }
      const now = Date.now();
      const entry = {
        id: newMemoryId(),
        roomId: room.id,
        text,
        tags,
        author: id,
        createdAt: now,
        revision: 1,
        updatedBy: id,
        updatedAt: now,
        ...(typeof req.sourceRequestId === 'string' && req.sourceRequestId
          ? { sourceRequestId: req.sourceRequestId.slice(0, 128) }
          : {}),
        history: [],
      };
      memoryIndexAdd(entry);
      saveMemory();
      log('info', `${id} 写入记忆`, { entryId: entry.id, roomId: room.id, chars: text.length, tags: tags.length });
      ok({ entry: memoryView(entry), duplicated: false });
      return;
    }
    case 'update': {
      const found = memoryEntryFor(id, req.entryId, isAdmin);
      if (found.error) {
        fail(found.error);
        return;
      }
      const { entry, room } = found;
      if (entry.deleted) {
        fail('该记忆已被删除', { entry: memoryView(entry) });
        return;
      }
      if (Number(req.revision) !== entry.revision) {
        fail('版本冲突：该记忆已被修改，请重新读取后再试', { entry: memoryView(entry) });
        return;
      }
      const nextText = req.text === undefined ? entry.text : String(req.text).trim();
      if (!nextText || nextText.length > MEMORY_TEXT_MAX) {
        fail(`正文需为 1~${MEMORY_TEXT_MAX} 字符`);
        return;
      }
      const nextTags = req.tags === undefined ? entry.tags : sanitizeMemoryTags(req.tags);
      if (nextTags === undefined) {
        fail('标签格式不正确');
        return;
      }
      if (nextText === entry.text && JSON.stringify(nextTags) === JSON.stringify(entry.tags)) {
        ok({ entry: memoryView(entry), unchanged: true });
        return;
      }
      if (rateLimited()) {
        return;
      }
      entry.history.push({
        revision: entry.revision,
        by: entry.updatedBy,
        at: entry.updatedAt,
        text: entry.text,
        tags: entry.tags,
      });
      trimMemoryHistory(entry);
      entry.text = nextText;
      entry.tags = nextTags;
      entry.revision += 1;
      entry.updatedBy = id;
      entry.updatedAt = Date.now();
      saveMemory();
      log('info', `${id} 更新记忆`, { entryId: entry.id, roomId: room.id, revision: entry.revision });
      ok({ entry: memoryView(entry) });
      return;
    }
    case 'delete': {
      const found = memoryEntryFor(id, req.entryId, isAdmin);
      if (found.error) {
        fail(found.error);
        return;
      }
      const { entry, room } = found;
      if (entry.deleted) {
        ok({ entry: memoryView(entry), unchanged: true });
        return;
      }
      if (Number(req.revision) !== entry.revision) {
        fail('版本冲突：该记忆已被修改，请重新读取后再试', { entry: memoryView(entry) });
        return;
      }
      if (rateLimited()) {
        return;
      }
      entry.deleted = { by: id, at: Date.now() };
      saveMemory();
      log('info', `${id} 删除记忆（软删）`, { entryId: entry.id, roomId: room.id });
      ok({ entry: memoryView(entry) });
      return;
    }
    case 'restore': {
      const found = memoryEntryFor(id, req.entryId, isAdmin);
      if (found.error) {
        fail(found.error);
        return;
      }
      const { entry, room } = found;
      if (!entry.deleted) {
        ok({ entry: memoryView(entry), unchanged: true });
        return;
      }
      if (rateLimited()) {
        return;
      }
      delete entry.deleted;
      saveMemory();
      log('info', `${id} 恢复记忆`, { entryId: entry.id, roomId: room.id });
      ok({ entry: memoryView(entry) });
      return;
    }
    default:
      fail(`不支持的操作「${op || '(空)'}」`);
  }
}

/** 管理操作：设备 list / kick / ban / unban；房间与分类 room-create / room-update / room-kick /
 *  room-unblock / room-dissolve / category-create / category-rename / category-delete；
 *  记忆 memory-list / memory-update / memory-restore / memory-purge / memory-stats（需要管理令牌通过） */
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
    trustGrants.delete(target);
    broadcastTrustState();
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
    case 'room-create': {
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
      let categoryId = '';
      if (typeof req.categoryId === 'string' && req.categoryId) {
        if (!categories.some(category => category.id === req.categoryId)) {
          fail('分类不存在');
          return;
        }
        categoryId = req.categoryId;
      }
      const room = {
        id: newRoomId(),
        name,
        categoryId,
        createdBy: id,
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
      saveState();
      log('info', `管理员 ${id} 创建房间「${name}」`, {
        roomId: room.id, categoryId, password: Boolean(room.passHash), total: rooms.size,
      });
      controlResult(ws, env, 'admin', true, { room: roomSummary(room, id, true) });
      touchRooms();
      return;
    }
    case 'room-update': {
      const room = typeof req.roomId === 'string' ? rooms.get(req.roomId) : undefined;
      if (!room) {
        fail('房间不存在');
        return;
      }
      const changes = [];
      if (typeof req.name === 'string') {
        const name = req.name.trim().slice(0, ROOM_NAME_MAX);
        if (!name) {
          fail('房间名不能为空');
          return;
        }
        if ([...rooms.values()].some(other => other !== room && other.name === name)) {
          fail(`房间名「${name}」已存在`);
          return;
        }
        room.name = name;
        changes.push('name');
      }
      if (Object.prototype.hasOwnProperty.call(req, 'password')) {
        setRoomPassword(room, typeof req.password === 'string' ? req.password : '');
        changes.push('password');
      }
      if (Object.prototype.hasOwnProperty.call(req, 'categoryId')) {
        const categoryId = typeof req.categoryId === 'string' ? req.categoryId : '';
        if (categoryId && !categories.some(category => category.id === categoryId)) {
          fail('分类不存在');
          return;
        }
        room.categoryId = categoryId;
        changes.push('category');
      }
      saveState();
      log('info', `管理员 ${id} 更新房间「${room.name}」`, { roomId: room.id, changes });
      controlResult(ws, env, 'admin', true, { room: roomSummary(room, id, true) });
      touchRooms();
      return;
    }
    case 'room-kick': {
      const room = typeof req.roomId === 'string' ? rooms.get(req.roomId) : undefined;
      if (!room) {
        fail('房间不存在');
        return;
      }
      const memberId = String(req.memberId || '');
      if (!memberId || !room.members.has(memberId)) {
        fail('该设备不在房间中');
        return;
      }
      room.members.delete(memberId);
      room.blocked.add(memberId);
      saveState();
      log('warn', `管理员 ${id} 把 ${memberId} 移出房间「${room.name}」`, { roomId: room.id, members: room.members.size });
      controlResult(ws, env, 'admin', true, { roomId: room.id, memberId });
      touchRooms();
      return;
    }
    case 'room-unblock': {
      const room = typeof req.roomId === 'string' ? rooms.get(req.roomId) : undefined;
      if (!room) {
        fail('房间不存在');
        return;
      }
      const memberId = String(req.memberId || '');
      if (!room.blocked.has(memberId)) {
        fail('该设备不在禁止名单里');
        return;
      }
      room.blocked.delete(memberId);
      saveState();
      log('info', `管理员 ${id} 解除 ${memberId} 的房间移出限制`, { roomId: room.id });
      controlResult(ws, env, 'admin', true, { roomId: room.id, memberId });
      touchRooms();
      return;
    }
    case 'room-dissolve': {
      const room = typeof req.roomId === 'string' ? rooms.get(req.roomId) : undefined;
      if (!room) {
        fail('房间不存在');
        return;
      }
      rooms.delete(room.id);
      const removedMemories = purgeRoomMemories(room.id);
      saveState();
      if (removedMemories > 0) {
        saveMemory();
      }
      log('warn', `管理员 ${id} 解散房间「${room.name}」`, {
        roomId: room.id, total: rooms.size, removedMemories,
      });
      controlResult(ws, env, 'admin', true, { roomId: room.id });
      touchRooms();
      return;
    }
    case 'category-create': {
      const name = String(req.name || '').trim().slice(0, CATEGORY_NAME_MAX);
      if (!name) {
        fail('分类名不能为空');
        return;
      }
      if (categories.some(category => category.name === name)) {
        fail(`分类名「${name}」已存在`);
        return;
      }
      if (categories.length >= CATEGORY_LIMIT) {
        fail(`分类数已达上限（${CATEGORY_LIMIT}）`);
        return;
      }
      const category = { id: newCategoryId(), name, createdAt: Date.now() };
      categories.push(category);
      saveState();
      log('info', `管理员 ${id} 创建分类「${name}」`, { categoryId: category.id, total: categories.length });
      controlResult(ws, env, 'admin', true, { category });
      touchRooms();
      return;
    }
    case 'category-rename': {
      const category = categories.find(item => item.id === req.categoryId);
      if (!category) {
        fail('分类不存在');
        return;
      }
      const name = String(req.name || '').trim().slice(0, CATEGORY_NAME_MAX);
      if (!name) {
        fail('分类名不能为空');
        return;
      }
      if (categories.some(item => item !== category && item.name === name)) {
        fail(`分类名「${name}」已存在`);
        return;
      }
      category.name = name;
      saveState();
      log('info', `管理员 ${id} 把分类改名为「${name}」`, { categoryId: category.id });
      controlResult(ws, env, 'admin', true, { category });
      touchRooms();
      return;
    }
    case 'category-delete': {
      const index = categories.findIndex(item => item.id === req.categoryId);
      if (index < 0) {
        fail('分类不存在');
        return;
      }
      const [removed] = categories.splice(index, 1);
      let movedRooms = 0;
      for (const room of rooms.values()) {
        if (room.categoryId === removed.id) {
          room.categoryId = '';
          movedRooms += 1;
        }
      }
      saveState();
      log('warn', `管理员 ${id} 删除分类「${removed.name}」`, { categoryId: removed.id, movedRooms });
      controlResult(ws, env, 'admin', true, { categoryId: removed.id, movedRooms });
      touchRooms();
      return;
    }
    case 'memory-list': {
      const roomId = typeof req.roomId === 'string' ? req.roomId : '';
      const keyword = String(req.q || '').trim().toLowerCase();
      const author = String(req.author || '').trim();
      const tag = String(req.tag || '').trim();
      const includeDeleted = req.includeDeleted !== false; // 管理员默认连已删除一起看
      const deletedOnly = req.deletedOnly === true;        // 只看回收站
      const limit = Math.min(Math.max(Number(req.limit) || 50, 1), 100);
      const offset = Math.max(Number(req.cursor) || 0, 0);
      let list = [...memories.values()];
      if (roomId) {
        list = list.filter(entry => entry.roomId === roomId);
      }
      if (deletedOnly) {
        list = list.filter(entry => entry.deleted);
      } else if (!includeDeleted) {
        list = list.filter(entry => !entry.deleted);
      }
      if (author) {
        list = list.filter(entry => entry.author === author || entry.updatedBy === author);
      }
      if (tag) {
        list = list.filter(entry => entry.tags.includes(tag));
      }
      if (keyword) {
        list = list.filter(entry => entry.text.toLowerCase().includes(keyword)
          || entry.tags.some(item => item.toLowerCase().includes(keyword)));
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      const page = list.slice(offset, offset + limit);
      controlResult(ws, env, 'admin', true, {
        total: list.length,
        nextCursor: offset + limit < list.length ? String(offset + limit) : '',
        entries: page.map(entry => memoryView(entry)),
        rooms: [...rooms.values()].map(room => ({ id: room.id, name: room.name, ...memoryRoomStats(room.id) })),
      });
      return;
    }
    case 'memory-update': {
      const found = memoryEntryFor(id, req.entryId, true);
      if (found.error) {
        fail(found.error);
        return;
      }
      const { entry } = found;
      const nextText = req.text === undefined ? entry.text : String(req.text).trim();
      if (!nextText || nextText.length > MEMORY_TEXT_MAX) {
        fail(`正文需为 1~${MEMORY_TEXT_MAX} 字符`);
        return;
      }
      const nextTags = req.tags === undefined ? entry.tags : sanitizeMemoryTags(req.tags);
      if (nextTags === undefined) {
        fail('标签格式不正确');
        return;
      }
      entry.history.push({
        revision: entry.revision,
        by: entry.updatedBy,
        at: entry.updatedAt,
        text: entry.text,
        tags: entry.tags,
      });
      trimMemoryHistory(entry);
      entry.text = nextText;
      entry.tags = nextTags;
      entry.revision += 1;
      entry.updatedBy = id;
      entry.updatedAt = Date.now();
      delete entry.deleted; // 管理员编辑即视为恢复
      saveMemory();
      log('warn', `管理员 ${id} 强制更新记忆`, { entryId: entry.id, revision: entry.revision });
      controlResult(ws, env, 'admin', true, { entry: memoryView(entry) });
      return;
    }
    case 'memory-restore': {
      const found = memoryEntryFor(id, req.entryId, true);
      if (found.error) {
        fail(found.error);
        return;
      }
      const { entry } = found;
      const targetRevision = req.revision === undefined ? undefined : Number(req.revision);
      if (targetRevision !== undefined) {
        const version = entry.history.find(item => item.revision === targetRevision);
        if (!version) {
          fail(`找不到版本 ${req.revision}`);
          return;
        }
        entry.history.push({
          revision: entry.revision,
          by: entry.updatedBy,
          at: entry.updatedAt,
          text: entry.text,
          tags: entry.tags,
        });
        trimMemoryHistory(entry);
        entry.text = version.text;
        entry.tags = version.tags;
        entry.revision += 1;
      }
      delete entry.deleted;
      entry.updatedBy = id;
      entry.updatedAt = Date.now();
      saveMemory();
      log('warn', `管理员 ${id} 恢复记忆`, { entryId: entry.id, revision: entry.revision, rollback: targetRevision });
      controlResult(ws, env, 'admin', true, { entry: memoryView(entry) });
      return;
    }
    case 'memory-purge': {
      if (typeof req.entryId === 'string' && req.entryId) {
        const entry = memories.get(req.entryId);
        if (!entry) {
          fail('记忆不存在');
          return;
        }
        memoryIndexRemove(entry.id);
        saveMemory();
        log('warn', `管理员 ${id} 彻底删除记忆`, { entryId: entry.id, roomId: entry.roomId });
        controlResult(ws, env, 'admin', true, { entryId: entry.id });
        return;
      }
      const roomId = typeof req.roomId === 'string' ? req.roomId : '';
      if (!roomId) {
        fail('需要 entryId 或 roomId');
        return;
      }
      if (req.confirm !== true) {
        fail('清空房间记忆需要 confirm=true');
        return;
      }
      const room = rooms.get(roomId);
      const removed = purgeRoomMemories(roomId);
      saveMemory();
      log('warn', `管理员 ${id} 清空房间记忆`, { roomId, room: room ? room.name : '', removed });
      controlResult(ws, env, 'admin', true, { roomId, removed });
      return;
    }
    case 'memory-stats': {
      const deleted = [...memories.values()].filter(entry => entry.deleted).length;
      controlResult(ws, env, 'admin', true, {
        total: memories.size,
        active: memories.size - deleted,
        deleted,
        bytes: [...memories.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0),
        rooms: [...rooms.values()].map(room => ({ id: room.id, name: room.name, ...memoryRoomStats(room.id) })),
      });
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
      memories: memories.size,
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
  // 版本门禁：扩展必须与中继同步升级（-testN / -testN.M 后缀忽略），否则拒绝接入
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
  broadcastTrustState();

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
      if (env.kind === 'memory') {
        handleMemoryOp(ws, id, env);
        return;
      }
      if (env.kind === 'trust') {
        handleTrustOp(ws, id, env);
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
      trustGrants.delete(id);
      log('info', `${id} 已离线`, { online: peers.size });
      if (!shuttingDown) {
        // 在场成员离线同样会改变房间摘要里的在线成员，需一并下发 room-event
        touchRooms();
        broadcastTrustState();
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
loadState();
loadMemory();

server.listen(PORT, HOST, () => {
  log('info', '中继服务已启动', {
    address: `http://${HOST}:${PORT}`,
    version: RELAY_VERSION,
    protocol: PROTOCOL,
    tokenRequired: TOKEN !== '',
    adminEnabled: ADMIN_TOKEN !== '',
    banFile: BAN_FILE,
    roomsFile: ROOMS_FILE,
    memoryFile: MEMORY_FILE,
    logLevel: LOG_LEVEL,
    offlineLimit: OFFLINE_LIMIT,
    pid: process.pid,
  });
});
