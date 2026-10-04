/**
 * 房间持久化专项测试（无头，可重复运行）：
 *   node relay/test/rooms-persist-test.mjs
 *
 * 会在本机拉起一个临时中继实例（默认端口 18789，可用 ROOMS_TEST_PORT 覆盖），
 * 使用临时状态目录，结束后清理；不影响正在运行的中继实例。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const require = createRequire(join(REPO, 'package.json'));
const { WebSocket } = require('ws');

const PORT = Number(process.env.ROOMS_TEST_PORT) || 18789;
const TOKEN = 't-persist';
const ADMIN = 'a-persist';
const CLIENT_VERSION = '2026.10.4-test1.1';
const STATE_DIR = mkdtempSync(join(tmpdir(), 't2c-persist-'));
const ROOMS_FILE = join(STATE_DIR, 'rooms.json');

let passed = 0;
const ok = label => {
  passed += 1;
  console.log(`PASS ${label}`);
};

let relayLog = '';
let relay;

function startRelay() {
  relayLog = '';
  relay = spawn(process.execPath, ['relay/server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      TALK2COPILOT_TOKEN: TOKEN,
      TALK2COPILOT_ADMIN_TOKEN: ADMIN,
      STATE_DIRECTORY: STATE_DIR,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', data => (relayLog += data));
  relay.stderr.on('data', data => (relayLog += data));
}

function stopRelay(signal = 'SIGTERM') {
  return new Promise(resolve => {
    relay.once('exit', resolve);
    relay.kill(signal);
  });
}

async function waitHealthy() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // 尚未监听
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('中继未就绪');
}

function track(ws) {
  ws.events = [];
  ws.on('message', data => ws.events.push(JSON.parse(data.toString())));
  return ws;
}

function waitFor(ws, pred, label, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const finish = env => {
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(env);
    };
    const onMsg = data => {
      const env = JSON.parse(data.toString());
      if (pred(env)) {
        finish(env);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`超时等待：${label}`));
    }, timeout);
    ws.on('message', onMsg);
    const hit = ws.events.find(pred);
    if (hit) {
      finish(hit);
    }
  });
}

async function connect(id, { admin = false } = {}) {
  const headers = { 'x-client-version': CLIENT_VERSION, authorization: `Bearer ${TOKEN}` };
  if (admin) {
    headers['x-admin-token'] = ADMIN;
  }
  const ws = track(new WebSocket(`ws://127.0.0.1:${PORT}/ws?id=${id}`, { headers }));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(ws, env => env.kind === 'room-event', `${id} 的首个 room-event`);
  return ws;
}

function control(ws, kind, op, payload = {}) {
  const id = `ctl-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`控制面超时：${kind}/${op}`));
    }, 5000);
    const onMsg = data => {
      const env = JSON.parse(data.toString());
      if (env.id === id && env.kind === kind) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(env);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ v: 1, kind, id, from: '', to: 'server', ts: Date.now(), op, payload }));
  });
}

const roomView = (ws, roomId) =>
  waitFor(ws, env => env.kind === 'room-event', 'room-event')
    .then(env => env.rooms.find(room => room.id === roomId));

try {
  // ---------- 阶段 A：建分类 / 建房 / 加入 / 移出 ----------
  startRelay();
  await waitHealthy();
  const alice = await connect('alice', { admin: true });
  const bob = await connect('bob');
  const carol = await connect('carol');

  const cat = await control(alice, 'admin', 'category-create', { name: '订单组' });
  assert.equal(cat.ok, true);
  const categoryId = cat.payload.category.id;

  const created = await control(alice, 'admin', 'room-create', { name: '后端', password: 'pw1', categoryId });
  assert.equal(created.ok, true);
  const roomId = created.payload.room.id;
  assert.equal(created.payload.room.createdBy, 'alice');

  const second = await control(alice, 'admin', 'room-create', { name: '前端' });
  assert.equal(second.ok, true);
  const secondRoomId = second.payload.room.id;
  assert.equal(second.payload.room.hasPassword, false);

  assert.equal((await control(bob, 'room', 'join', { roomId, password: 'wrong' })).ok, false);
  assert.equal((await control(bob, 'room', 'join', { roomId, password: 'pw1' })).ok, true);
  assert.equal((await control(carol, 'room', 'join', { roomId, password: 'pw1' })).ok, true);
  assert.equal((await control(alice, 'admin', 'room-kick', { roomId, memberId: 'bob' })).ok, true);
  ok('初始状态就绪：1 分类 / 2 房间 / 密码 / 成员 / 移出名单');

  // ---------- 状态文件结构、权限、无残留 ----------
  const raw = JSON.parse(readFileSync(ROOMS_FILE, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(raw.categories.some(c => c.id === categoryId && c.name === '订单组'));
  const persisted = raw.rooms.find(r => r.id === roomId);
  assert.ok(persisted, 'rooms.json 中应包含刚创建的房间');
  assert.equal(persisted.name, '后端');
  assert.equal(persisted.categoryId, categoryId);
  assert.equal(persisted.createdBy, 'alice');
  assert.equal(typeof persisted.passHash === 'string' && persisted.passHash.length > 0, true);
  assert.deepEqual(new Set(persisted.members), new Set(['alice', 'carol']));
  assert.deepEqual(persisted.blocked, ['bob']);
  assert.equal(statSync(ROOMS_FILE).mode & 0o777, 0o600, 'rooms.json 权限应为 0600');
  assert.ok(!readdirSync(STATE_DIR).some(name => name.endsWith('.tmp')), '不应残留 .tmp 文件');
  ok('rooms.json 结构完整、权限 0600、无 .tmp 残留');

  // ---------- 阶段 B：SIGKILL 重启后全部保留 ----------
  await stopRelay('SIGKILL');
  startRelay();
  await waitHealthy();
  const alice2 = await connect('alice', { admin: true });
  const evt = await waitFor(alice2, env => env.kind === 'room-event' && env.rooms.length === 2, '重启后的房间列表');
  const restored = evt.rooms.find(r => r.id === roomId);
  assert.ok(restored, '重启后房间 id 应保持不变');
  assert.equal(restored.name, '后端');
  assert.equal(restored.categoryId, categoryId);
  assert.equal(restored.hasPassword, true);
  assert.equal(restored.memberCount, 2);
  assert.deepEqual(new Set(restored.members), new Set(['alice', 'carol']), '离线成员关系保留');
  assert.deepEqual(restored.blocked, ['bob'], '移出名单保留');
  assert.ok(evt.categories.some(c => c.id === categoryId && c.name === '订单组'), '分类保留');
  assert.ok(evt.rooms.some(r => r.id === secondRoomId && r.name === '前端' && r.hasPassword === false));
  ok('SIGKILL 重启后：房间 id / 名称 / 分类 / 密码 / 成员 / 移出名单 全部保留');

  // 唯一性校验必须基于载入的状态（否则重启后会出现同名房间/分类）
  const dupRoom = await control(alice2, 'admin', 'room-create', { name: '后端' });
  assert.equal(dupRoom.ok, false, '重启后同名房间应被拒绝');
  assert.match(dupRoom.error, /已存在/);
  const dupCategory = await control(alice2, 'admin', 'category-create', { name: '订单组' });
  assert.equal(dupCategory.ok, false, '重启后同名分类应被拒绝');
  assert.match(dupCategory.error, /已存在/);
  ok('重启后同名房间 / 分类仍被拒绝（唯一性基于载入的状态）');

  const bob2 = await connect('bob');
  const bobView = await roomView(bob2, roomId);
  assert.equal(bobView.joined, false);
  assert.equal(bobView.blocked, undefined, '非管理员不应看到移出名单');
  assert.equal((await control(bob2, 'room', 'join', { roomId, password: 'pw1' })).ok, false, '被移出者重启后仍无法加入');
  ok('重启后权限判定依然生效（被移出者不能凭密码再加入）');

  const carol2 = await connect('carol');
  const carolView = await roomView(carol2, roomId);
  assert.equal(carolView.joined, true, '离线成员的成员关系应保留');
  carol2.send(JSON.stringify({ v: 1, kind: 'message', id: 'm-persist-1', from: 'carol', to: 'alice', ts: Date.now(), text: 'hello-after-restart' }));
  await waitFor(alice2, env => env.kind === 'message' && env.text === 'hello-after-restart', '同房间消息');
  ok('重启后成员关系生效：同房间仍可通信');

  // ---------- 阶段 B2：改名 / 改密码 / 退出 / 解散 的持久化 ----------
  const renamed = await control(alice2, 'admin', 'room-update', { roomId, name: '后端服务', password: 'pw2' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.payload.room.name, '后端服务');
  const dave = await connect('dave');
  assert.equal((await control(dave, 'room', 'join', { roomId: secondRoomId })).ok, true);
  assert.equal((await control(dave, 'room', 'leave', { roomId: secondRoomId })).ok, true);
  assert.equal((await control(alice2, 'admin', 'room-dissolve', { roomId: secondRoomId })).ok, true);

  // 快速连续变更：确认每次变更同步落盘、文件始终是完整 JSON
  const frank = await connect('frank');
  for (let i = 0; i < 10; i += 1) {
    await control(frank, 'room', 'join', { roomId, password: 'pw2' });
    await control(frank, 'room', 'leave', { roomId });
  }
  const rawRapid = JSON.parse(readFileSync(ROOMS_FILE, 'utf8'));
  assert.ok(!rawRapid.rooms.find(r => r.id === roomId).members.includes('frank'), '连续变更后的最终状态应落盘');
  const rawText = readFileSync(ROOMS_FILE, 'utf8');
  assert.ok(!rawText.includes('pw1') && !rawText.includes('pw2'), '状态文件不应出现明文密码');
  ok('连续变更后文件仍完整；密码只存 salt+hash（无明文）');

  await stopRelay('SIGTERM');
  startRelay();
  await waitHealthy();
  const alice2b = await connect('alice', { admin: true });
  const evt2b = await waitFor(alice2b, env => env.kind === 'room-event' && env.rooms.length === 1, '变更后的房间列表');
  assert.equal(evt2b.rooms[0].id, roomId, '房间 id 不变');
  assert.equal(evt2b.rooms[0].name, '后端服务');
  assert.equal(evt2b.rooms[0].hasPassword, true);
  assert.ok(!evt2b.rooms.some(r => r.id === secondRoomId), '解散的房间不应恢复');
  assert.deepEqual(new Set(evt2b.rooms[0].members), new Set(['alice', 'carol']), 'dave 退出后不应恢复为成员');
  const erin = await connect('erin');
  assert.equal((await control(erin, 'room', 'join', { roomId, password: 'pw1' })).ok, false, '旧密码应失效');
  assert.equal((await control(erin, 'room', 'join', { roomId, password: 'pw2' })).ok, true, '新密码应生效');
  ok('重启后：改名 / 改密码 / 退出 / 解散 全部保持');

  // ---------- 阶段 C：分类删除的级联也要落盘 ----------
  const del = await control(alice2b, 'admin', 'category-delete', { categoryId });
  assert.equal(del.ok, true);
  assert.equal(del.payload.movedRooms, 1);
  await stopRelay('SIGTERM');
  startRelay();
  await waitHealthy();
  const alice3 = await connect('alice', { admin: true });
  const evt3 = await waitFor(alice3, env => env.kind === 'room-event' && env.rooms.length === 1, '分类删除后的房间列表');
  assert.equal(evt3.categories.length, 0, '分类删除结果应落盘');
  assert.equal(evt3.rooms.find(r => r.id === roomId).categoryId, '', '房间应保持未分类');
  assert.equal(evt3.rooms.find(r => r.id === roomId).hasPassword, true, '密码不受分类删除影响');
  ok('再次重启：分类删除 / 房间未分类 的状态保持');

  // ---------- 阶段 D：损坏文件处理 ----------
  await stopRelay('SIGTERM');
  writeFileSync(ROOMS_FILE, '{ 这不是合法 JSON');
  startRelay();
  await waitHealthy();
  const alice4 = await connect('alice', { admin: true });
  const evt4 = await waitFor(alice4, env => env.kind === 'room-event', '损坏文件重启后的房间列表');
  assert.equal(evt4.rooms.length, 0, '损坏文件应从空状态开始');
  const backups = readdirSync(STATE_DIR).filter(name => name.startsWith('rooms.json.bad-'));
  assert.equal(backups.length, 1, '应生成一个 .bad-* 备份');
  assert.match(readFileSync(join(STATE_DIR, backups[0]), 'utf8'), /这不是合法 JSON/, '备份内容应为损坏前的原始内容');
  assert.match(relayLog, /无法解析/, '日志应记录损坏与备份');
  ok('状态文件损坏：改名备份后从空状态启动，不静默丢数据');

  console.log(`\n房间持久化测试：全部 ${passed} 项通过`);
} catch (err) {
  console.error(`\n测试失败：${err.message}`);
  console.error('---- 中继日志 ----');
  console.error(relayLog);
  process.exitCode = 1;
} finally {
  if (relay && relay.exitCode === null) {
    relay.kill('SIGKILL');
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  rmSync(STATE_DIR, { recursive: true, force: true });
}
