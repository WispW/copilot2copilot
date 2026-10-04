/**
 * 房间共享记忆专项测试（无头，可重复运行）：
 *   node relay/test/memory-test.mjs
 *
 * 会在本机拉起一个临时中继实例（默认端口 18790，可用 MEMORY_TEST_PORT 覆盖），
 * 使用临时状态目录，结束后清理；不影响正在运行的中继实例。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const require = createRequire(join(REPO, 'package.json'));
const { WebSocket } = require('ws');

const PORT = Number(process.env.MEMORY_TEST_PORT) || 18790;
const TOKEN = 't-memory';
const ADMIN = 'a-memory';
const CLIENT_VERSION = '2026.10.4-test1.1';
const STATE_DIR = mkdtempSync(join(tmpdir(), 't2c-memory-'));
const MEMORY_FILE = join(STATE_DIR, 'memory.json');

let passed = 0;
const ok = label => {
  passed += 1;
  console.log(`PASS ${label}`);
};

let relayLog = '';
let relay;

function startRelay() {
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

function closeAndWait(ws) {
  return new Promise(resolve => {
    ws.once('close', resolve);
    ws.close();
  });
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

const mem = (ws, op, payload) => control(ws, 'memory', op, payload);
const adm = (ws, op, payload) => control(ws, 'admin', op, payload);

try {
  // ---------------- 准备：中继 + 房间 ----------------
  startRelay();
  let health = await waitHealthy();
  assert.equal(health.memories, 0, '初始记忆数应为 0');

  const alice = await connect('alice', { admin: true });
  let bob = await connect('bob');
  const carol = await connect('carol');

  const created = await adm(alice, 'room-create', { name: '记忆测试房', password: 'pw' });
  assert.equal(created.ok, true);
  const roomId = created.payload.room.id;
  assert.equal((await mem(bob, 'remember', { roomId, text: 'x' })).ok, false, '未加入房间不能写记忆');
  assert.equal((await control(bob, 'room', 'join', { roomId, password: 'pw' })).ok, true);
  ok('准备完成：alice 建房，bob 加入，carol 留在房外');

  // ---------------- 权限：非成员不可查 / 写 ----------------
  const carolQuery = await mem(carol, 'query', { query: 'pageSize' });
  assert.equal(carolQuery.ok, false, '非成员不能查询');
  const carolWrite = await mem(carol, 'remember', { roomId, text: '偷写' });
  assert.equal(carolWrite.ok, false, '非成员不能写入');
  const emptyQuery = await mem(bob, 'query', { query: 'pageSize', roomId });
  assert.equal(emptyQuery.ok, true);
  assert.equal(emptyQuery.payload.results.length, 0);
  ok('权限：非成员查询 / 写入被拒，成员可查询');

  // ---------------- 共享 + 去重 ----------------
  const first = await mem(alice, 'remember', {
    roomId,
    text: 'OrderService 的 pageSize 上限是 100，超过会截断',
    tags: ['订单', '接口约定'],
    sourceRequestId: 'msg-1',
  });
  assert.equal(first.ok, true);
  const entryId = first.payload.entry.id;
  assert.equal(first.payload.entry.revision, 1);
  assert.equal(first.payload.entry.author, 'alice');

  const bobFind = await mem(bob, 'query', { query: 'pageSize 上限', roomId });
  assert.equal(bobFind.ok, true);
  assert.equal(bobFind.payload.results[0].id, entryId, 'A 写入的记忆 B 能查到');
  assert.equal(bobFind.payload.results[0].roomName, '记忆测试房');

  const dup = await mem(alice, 'remember', { roomId, text: 'OrderService 的 pageSize 上限是 100，超过会截断' });
  assert.equal(dup.ok, true);
  assert.equal(dup.payload.duplicated, true);
  assert.equal(dup.payload.entry.id, entryId, '重复写入应返回已有条目');
  const listed = await mem(alice, 'list', { roomId });
  assert.equal(listed.payload.total, 1, '去重后仍只有 1 条');
  ok('共享：A 写入 B 可查；重复写入自动去重');

  // ---------------- 离线写入，上线可查 ----------------
  await closeAndWait(bob);
  await new Promise(resolve => setTimeout(resolve, 150));
  const offlineWrite = await mem(alice, 'remember', { roomId, text: '支付回调接口需要验签，密钥在配置中心', tags: ['支付'] });
  assert.equal(offlineWrite.ok, true);
  const paymentId = offlineWrite.payload.entry.id;
  bob = await connect('bob');
  const rejoinQuery = await mem(bob, 'query', { query: '验签', roomId });
  assert.equal(rejoinQuery.payload.results[0].id, paymentId, '离线期间写入的记忆，上线后可查');
  ok('共享不依赖双方在线：离线写入、重连后可查');

  // ---------------- 全员可编辑 + 乐观锁 + 历史 ----------------
  const bobUpdate = await mem(bob, 'update', { entryId, revision: 1, text: 'OrderService 的 pageSize 上限是 200（修订）' });
  assert.equal(bobUpdate.ok, true);
  assert.equal(bobUpdate.payload.entry.revision, 2);
  assert.equal(bobUpdate.payload.entry.updatedBy, 'bob');

  const stale = await mem(alice, 'update', { entryId, revision: 1, text: '用旧版本号覆盖' });
  assert.equal(stale.ok, false, '旧版本号必须被拒绝');
  assert.match(stale.error, /冲突/);
  assert.equal(stale.payload.entry.revision, 2, '冲突时应回传最新条目');

  const retry = await mem(alice, 'update', { entryId, revision: 2, text: 'OrderService 的 pageSize 上限是 200，超过报错' });
  assert.equal(retry.ok, true);
  assert.equal(retry.payload.entry.revision, 3);

  const detail = await mem(bob, 'get', { entryId });
  assert.equal(detail.payload.entry.history.length, 2, '应保留两次修改历史');
  assert.equal(detail.payload.entry.history[0].revision, 1);
  assert.equal(detail.payload.entry.history[0].text, 'OrderService 的 pageSize 上限是 100，超过会截断');
  assert.equal(detail.payload.entry.history[0].by, 'alice');
  assert.equal(detail.payload.entry.history[1].by, 'bob');
  assert.equal((await mem(carol, 'get', { entryId })).ok, false, '非成员不能读详情');
  ok('全员可编辑：版本冲突被拒并回传最新；历史版本完整');

  // ---------------- 检索质量 ----------------
  const lowercase = await mem(alice, 'query', { query: 'pagesize', roomId });
  assert.equal(lowercase.payload.results[0].id, entryId, '小写查询应命中标识符');
  const chinese = await mem(alice, 'query', { query: '验签', roomId });
  assert.equal(chinese.payload.results[0].id, paymentId, '中文查询应命中');
  const tagHit = await mem(alice, 'query', { query: '接口约定', roomId });
  assert.equal(tagHit.payload.results[0].id, entryId, '标签命中应加权靠前');
  const miss = await mem(alice, 'query', { query: '完全不存在的词汇xyzzy', roomId });
  assert.equal(miss.payload.results.length, 0);
  assert.ok(miss.payload.hint, '无命中时应给出提示');

  // token 规范化：剥掉首尾标点 + 把 . - + 连接的段拆分索引（同时保留全串）
  const normWrite = await mem(alice, 'remember', {
    roomId,
    text: '规范化验证：BIN512 与 END-TAIL-9Z 标识符',
    tags: ['qq341-b2d8'],
  });
  assert.equal(normWrite.ok, true);
  const normId = normWrite.payload.entry.id;
  assert.equal((await mem(alice, 'query', { query: 'BIN512.', roomId })).payload.results[0]?.id, normId, '尾随句点应命中');
  assert.equal((await mem(alice, 'query', { query: 'qq341', roomId })).payload.results[0]?.id, normId, '连字符标签应能按分段命中');
  assert.equal((await mem(alice, 'query', { query: 'b2d8', roomId })).payload.results[0]?.id, normId, '分段同样可检索');
  assert.equal((await mem(alice, 'query', { query: 'END-TAIL-9Z', roomId })).payload.results[0]?.id, normId, '完整标识符仍可精确命中');
  ok('检索：标识符 / 中文 / 标签命中与空结果提示；token 规范化（首尾标点 + . - + 分段）生效');

  // ---------------- 软删 / 恢复 ----------------
  const activeBeforeDelete = (await mem(alice, 'list', { roomId })).payload.total;
  const removed = await mem(bob, 'delete', { entryId, revision: 3 });
  assert.equal(removed.ok, true);
  assert.equal(removed.payload.entry.deleted.by, 'bob');
  assert.equal((await mem(alice, 'query', { query: 'pageSize', roomId })).payload.results.length, 0, '已删除不参与检索');
  const withDeleted = await mem(alice, 'list', { roomId, includeDeleted: true });
  assert.equal(withDeleted.payload.total, activeBeforeDelete, '软删不改变条目总数（回收站里能看到）');
  assert.equal((await mem(alice, 'list', { roomId })).payload.total, activeBeforeDelete - 1, '默认列表不含已删除');
  const recycleBin = await adm(alice, 'memory-list', { deletedOnly: true });
  assert.equal(recycleBin.payload.total, 1, '管理员回收站视图（deletedOnly）只含已删除条目');
  assert.equal(recycleBin.payload.entries[0].id, entryId);
  const restored = await mem(alice, 'restore', { entryId });
  assert.equal(restored.ok, true);
  assert.equal((await mem(alice, 'query', { query: 'pageSize', roomId })).payload.results[0].id, entryId, '恢复后可检索');
  ok('软删除 / 回收站 / 成员恢复');

  // ---------------- 容量与限流 ----------------
  assert.equal((await mem(alice, 'remember', { roomId, text: 'x'.repeat(2001) })).ok, false, '超长正文应被拒');
  assert.equal((await mem(alice, 'remember', { roomId, text: 'y', tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).ok, false, '超量标签应被拒');

  const dave = await connect('dave');
  assert.equal((await control(dave, 'room', 'join', { roomId, password: 'pw' })).ok, true);
  let daveWrites = 0;
  for (let i = 0; i < 30; i += 1) {
    const write = await mem(dave, 'remember', { roomId, text: `限流样例 ${i}` });
    assert.equal(write.ok, true, `第 ${i + 1} 次写入应在限额内`);
    daveWrites += 1;
  }
  const blocked = await mem(dave, 'remember', { roomId, text: '超出限流的写入' });
  assert.equal(blocked.ok, false, '超过写入限流应被拒绝');
  assert.match(blocked.error, /频繁/);
  ok(`容量与限流：超长 / 超量标签被拒，连续 ${daveWrites} 次后被限流`);

  // ---------------- 管理员操作 ----------------
  const stats = await adm(alice, 'memory-stats');
  assert.equal(stats.ok, true);
  assert.ok(stats.payload.total >= 32, '统计应包含全部房间条目');
  const adminList = await adm(alice, 'memory-list', { q: 'pageSize' });
  assert.equal(adminList.payload.total, 1);
  assert.equal(adminList.payload.entries[0].id, entryId);
  const adminEdit = await adm(alice, 'memory-update', { entryId: paymentId, text: '支付回调需要验签（管理员修订）' });
  assert.equal(adminEdit.ok, true);
  assert.equal(adminEdit.payload.entry.revision, 2);
  const rollback = await adm(alice, 'memory-restore', { entryId, revision: 1 });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.payload.entry.text, 'OrderService 的 pageSize 上限是 100，超过会截断', '回滚应取回历史版本内容');
  assert.equal(rollback.payload.entry.revision, 4, '回滚写为新版本');
  assert.equal((await adm(alice, 'memory-purge', { entryId: paymentId })).ok, true);
  assert.equal((await adm(alice, 'memory-list', { q: '验签' })).payload.total, 0, '彻底删除后不可检索');
  assert.equal((await adm(alice, 'memory-purge', { roomId })).ok, false, '房间级清空必须 confirm');
  const purged = await adm(alice, 'memory-purge', { roomId, confirm: true });
  assert.equal(purged.ok, true);
  assert.ok(purged.payload.removed >= 31, '清空应删除房间全部条目');
  assert.equal((await adm(alice, 'memory-stats')).payload.total, 0, '清空后总数为 0');
  ok('管理员：统计 / 筛选 / 强制编辑 / 回滚 / 彻底删除 / 房间级清空');

  // ---------------- 持久化与级联 ----------------
  const survivorRoom = await adm(alice, 'room-create', { name: '持久化房' });
  const survivorRoomId = survivorRoom.payload.room.id;
  const survivor = await mem(alice, 'remember', { roomId: survivorRoomId, text: '持久化验证：pageSize 上限 200' });
  const survivorId = survivor.payload.entry.id;
  await mem(alice, 'update', { entryId: survivorId, revision: 1, text: '持久化验证：pageSize 上限 300' });

  const cascadeRoom = await adm(alice, 'room-create', { name: '级联房' });
  const cascadeRoomId = cascadeRoom.payload.room.id;
  const cascade = await mem(alice, 'remember', { roomId: cascadeRoomId, text: '级联删除验证' });
  assert.equal(cascade.ok, true);
  assert.equal((await adm(alice, 'room-dissolve', { roomId: cascadeRoomId })).ok, true);

  await stopRelay('SIGKILL');
  startRelay();
  health = await waitHealthy();
  assert.equal(health.memories, 1, '重启后应只剩持久化房的那条记忆');
  const alice2 = await connect('alice', { admin: true });
  const survivorQuery = await mem(alice2, 'query', { query: 'pageSize 300' });
  assert.equal(survivorQuery.payload.results[0].id, survivorId, '条目在重启后保持');
  assert.equal(survivorQuery.payload.results[0].revision, 2);
  const survivorDetail = await mem(alice2, 'get', { entryId: survivorId });
  assert.equal(survivorDetail.payload.entry.history.length, 1, '历史版本在重启后保持');
  assert.equal((await adm(alice2, 'memory-stats')).payload.rooms.some(room => room.id === cascadeRoomId), false, '级联房已不存在');
  ok('持久化：SIGKILL 重启后条目 / 历史保持；房间解散级联删除');

  // ---------------- 损坏文件兜底 ----------------
  await stopRelay('SIGTERM');
  writeFileSync(MEMORY_FILE, '{ 这不是合法 JSON');
  startRelay();
  health = await waitHealthy();
  assert.equal(health.memories, 0, '损坏文件应从空状态启动');
  const backups = readdirSync(STATE_DIR).filter(name => name.startsWith('memory.json.bad-'));
  assert.equal(backups.length, 1, '应生成 memory.json.bad-* 备份');
  assert.match(readFileSync(join(STATE_DIR, backups[0]), 'utf8'), /这不是合法 JSON/, '备份内容完整');
  assert.match(relayLog, /记忆状态文件无法解析/, '日志应记录损坏与备份');
  ok('损坏状态文件：改名备份后从空启动，不静默丢数据');

  console.log(`\n共享记忆专项测试：全部 ${passed} 项通过`);
} catch (err) {
  console.error(`\n测试失败：${err.message}`);
  console.error('---- 中继日志（末尾） ----');
  console.error(relayLog.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  if (relay && relay.exitCode === null) {
    relay.kill('SIGKILL');
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  rmSync(STATE_DIR, { recursive: true, force: true });
}
