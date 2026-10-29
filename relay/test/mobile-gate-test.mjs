/**
 * 手机（人工终端）门禁专项测试（无头，可重复运行）：
 *   node relay/test/mobile-gate-test.mjs
 *
 * 会拉起临时中继实例（默认端口 18792，可用 MOBILE_TEST_PORT 覆盖）与一个未配置手机令牌的
 * 实例（端口 +1），使用临时状态目录，结束后清理；不影响正在运行的中继实例。覆盖：
 *   1. healthz 暴露 mobileEnabled 与协议号
 *   2. 手机专用令牌缺失 / 错误 → 4009；未配置该令牌的中继一律拒绝手机
 *   3. 协议号不符 → 4008（手机不参与版本号门禁）
 *   4. 不报 x-client-kind 的旧客户端按 extension 处理
 *   5. 档案 kind 以握手为准（客户端自报无效）
 *   6. 在线 / 离线手机都不接受 intent=task（离线不进队列）
 *   7. 普通消息对离线手机仍暂存补发
 *   8. admin.list 下发设备类型
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const require = createRequire(join(REPO, 'package.json'));
const { WebSocket } = require('ws');

const PORT = Number(process.env.MOBILE_TEST_PORT) || 18792;
const DISABLED_PORT = PORT + 1;
const TOKEN = 't-mobile';
const MOBILE_TOKEN = 'mt-secret';
const ADMIN_TOKEN = 'at-secret';
const PROTOCOL = 7;
// 扩展版本与中继版本必须一致（-testN 后缀被中继忽略）：直接读 package.json
const CLIENT_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const STATE_DIR = mkdtempSync(join(tmpdir(), 't2c-mobile-'));

let passed = 0;
const ok = label => {
  passed += 1;
  console.log(`PASS ${label}`);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 极简客户端：按握手参数连接并收集信封 */
function connect(port, id, opts = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const kind = opts.kind ?? 'extension';
  if (kind) headers['x-client-kind'] = kind;
  if (kind === 'mobile') {
    if (opts.protocol !== undefined) headers['x-protocol'] = String(opts.protocol);
    if (opts.mobileToken !== undefined) headers['x-mobile-token'] = opts.mobileToken;
  } else if (opts.version !== null) {
    headers['x-client-version'] = opts.version ?? CLIENT_VERSION;
  }
  if (opts.admin) headers['x-admin-token'] = opts.admin;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${encodeURIComponent(id)}`, { headers });
  const frames = [];
  const client = { ws, frames, closed: null, id };
  ws.on('message', data => {
    try {
      frames.push(JSON.parse(data.toString()));
    } catch { /* 忽略非 JSON */ }
  });
  ws.on('close', (code, reason) => {
    client.closed = { code, reason: reason.toString() };
  });
  client.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  client.waitFor = (predicate, label, timeout = 2500) => new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = frames.find(predicate);
      if (hit) {
        resolve(hit);
      } else if (Date.now() - start > timeout) {
        reject(new Error(`${id} 等不到「${label}」；已收 kinds=${frames.map(f => f.kind).join(',')}`));
      } else {
        setTimeout(tick, 20);
      }
    };
    tick();
  });
  client.waitClosed = async (timeout = 2500) => {
    const start = Date.now();
    while (!client.closed && Date.now() - start < timeout) {
      await sleep(20);
    }
    return client.closed;
  };
  let seq = 0;
  client.send = env => ws.send(JSON.stringify({ v: PROTOCOL, id: `${id}-${++seq}-${Date.now()}`, ts: Date.now(), from: id, ...env }));
  client.control = (kindName, op, payload = {}) => {
    const requestId = `${id}-ctl-${++seq}`;
    client.send({ kind: kindName, id: requestId, to: 'server', op, payload });
    return client.waitFor(f => f.id === requestId && f.kind === kindName, `${kindName}/${op}`);
  };
  client.close = () => {
    try {
      ws.close();
    } catch { /* 已关闭 */ }
  };
  return client;
}

const relays = [];
function startRelay(port, env = {}) {
  const child = spawn(process.execPath, ['relay/server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      TALK2COPILOT_TOKEN: TOKEN,
      TALK2COPILOT_ADMIN_TOKEN: ADMIN_TOKEN,
      TALK2COPILOT_MOBILE_TOKEN: MOBILE_TOKEN,
      STATE_DIRECTORY: STATE_DIR,
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relays.push(child);
  return child;
}

async function waitHealthy(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        return await res.json();
      }
    } catch { /* 未就绪 */ }
    await sleep(100);
  }
  throw new Error(`中继 ${port} 未就绪`);
}

async function main() {
  startRelay(PORT);
  startRelay(DISABLED_PORT, { TALK2COPILOT_MOBILE_TOKEN: '' });

  const health = await waitHealthy(PORT);
  assert.equal(health.protocol, PROTOCOL, '协议号应为 7');
  assert.equal(health.mobileEnabled, true, 'healthz 应报告 mobileEnabled');
  ok('healthz 暴露协议号与 mobileEnabled');

  const disabledHealth = await waitHealthy(DISABLED_PORT);
  assert.equal(disabledHealth.mobileEnabled, false, '未配置令牌时应报告 mobileEnabled=false');

  // 未配置手机令牌的中继：手机一律拒绝
  const disabledPhone = connect(DISABLED_PORT, 'phone-disabled', { kind: 'mobile', protocol: PROTOCOL, mobileToken: MOBILE_TOKEN });
  await disabledPhone.opened.catch(() => undefined);
  const disabledClose = await disabledPhone.waitClosed();
  assert.equal(disabledClose?.code, 4009, '未配置手机令牌应以 4009 拒绝');
  ok('未配置手机令牌的中继拒绝手机接入（4009）');

  // 令牌缺失 / 错误
  for (const [label, mobileToken] of [['缺失', undefined], ['错误', 'wrong']]) {
    const c = connect(PORT, `phone-${label}`, { kind: 'mobile', protocol: PROTOCOL, mobileToken });
    await c.opened.catch(() => undefined);
    const closed = await c.waitClosed();
    assert.equal(closed?.code, 4009, `手机令牌${label}应以 4009 拒绝`);
  }
  ok('手机专用令牌缺失 / 错误 → 4009');

  // 协议号不符
  const wrongProto = connect(PORT, 'phone-proto', { kind: 'mobile', protocol: PROTOCOL - 1, mobileToken: MOBILE_TOKEN });
  await wrongProto.opened.catch(() => undefined);
  const wrongProtoClose = await wrongProto.waitClosed();
  assert.equal(wrongProtoClose?.code, 4008, '协议号不符应 4008');
  ok('手机协议号不符 → 4008');

  // 旧客户端（不带 x-client-kind）按 extension 走版本号门禁
  const legacy = connect(PORT, 'legacy-pc', { kind: undefined });
  await legacy.opened;
  ok('不带 x-client-kind 的旧客户端接入成功（按 extension 处理）');
  assert.equal(legacy.closed, null);

  const wrongVersion = connect(PORT, 'old-pc', { version: '1999.1.1' });
  await wrongVersion.opened.catch(() => undefined);
  const wrongVersionClose = await wrongVersion.waitClosed();
  assert.equal(wrongVersionClose?.code, 4008, '扩展版本不符应 4008');
  ok('扩展版本不符 → 4008');

  // 建房并加入
  const admin = connect(PORT, 'mobile-admin', { admin: ADMIN_TOKEN });
  await admin.opened;
  const created = await admin.control('admin', 'room-create', { name: 'mobile-gate-room' });
  assert.equal(created.ok, true, `建房失败：${created.error}`);
  const roomId = created.payload.room.id;

  const phone = connect(PORT, 'my-phone', { kind: 'mobile', protocol: PROTOCOL, mobileToken: MOBILE_TOKEN });
  const desktop = connect(PORT, 'my-desktop');
  await Promise.all([phone.opened, desktop.opened]);
  assert.equal((await phone.control('room', 'join', { roomId })).ok, true);
  assert.equal((await desktop.control('room', 'join', { roomId })).ok, true);

  // 档案 kind 以握手为准（手机在 profile 里自称 extension 无效）
  phone.send({ kind: 'hello', to: 'server', profile: { id: 'my-phone', role: '本人手机', scope: '人工', kind: 'extension' } });
  desktop.send({ kind: 'hello', to: 'server', profile: { id: 'my-desktop', role: '桌面', scope: '代码', kind: 'mobile' } });
  const presence = await phone.waitFor(
    f => f.kind === 'presence' && (f.profiles || []).some(p => p.id === 'my-desktop'),
    'presence profiles',
  );
  const phoneProfile = presence.profiles.find(p => p.id === 'my-phone');
  const desktopProfile = presence.profiles.find(p => p.id === 'my-desktop');
  assert.equal(phoneProfile.kind, 'mobile', '手机的 kind 应以握手为准');
  assert.equal(desktopProfile.kind, 'extension', '桌面自报 mobile 不应生效');
  ok('档案 kind 以握手为准（客户端自报无效）');

  // 在线手机：task 拒转
  const onlineTaskId = `task-online-${Date.now()}`;
  desktop.send({ kind: 'message', id: onlineTaskId, to: 'my-phone', text: '改一下代码', intent: 'task' });
  const onlineError = await desktop.waitFor(f => f.kind === 'error' && f.refId === onlineTaskId, '在线 task 拒转');
  assert.ok(onlineError.error.includes('人工终端'), '回执应说明目标是人工终端');
  await sleep(150);
  assert.ok(!phone.frames.some(f => f.id === onlineTaskId), '被拒的 task 不应投递给手机');
  ok('在线手机的写任务被拒转且不投递');

  // 离线手机：task 仍拒转（不进队列）
  phone.close();
  await sleep(150);
  const offlineTaskId = `task-offline-${Date.now()}`;
  desktop.send({ kind: 'message', id: offlineTaskId, to: 'my-phone', text: '还是改代码', intent: 'task' });
  await desktop.waitFor(f => f.kind === 'error' && f.refId === offlineTaskId, '离线 task 拒转');
  ok('离线手机的写任务仍被拒转（不进入离线队列）');

  // 离线手机：普通消息暂存并补发
  const offlineAskId = `ask-offline-${Date.now()}`;
  desktop.send({ kind: 'message', id: offlineAskId, to: 'my-phone', text: '这条普通消息应该补发', intent: 'ask' });
  await sleep(150);
  const phone2 = connect(PORT, 'my-phone', { kind: 'mobile', protocol: PROTOCOL, mobileToken: MOBILE_TOKEN });
  await phone2.opened;
  await phone2.waitFor(f => f.kind === 'message' && f.id === offlineAskId, '离线 ask 补发');
  ok('离线手机的普通消息重连后补发');

  // 管理端设备类型
  const devices = await admin.control('admin', 'list');
  const phoneDevice = devices.payload.devices.find(d => d.id === 'my-phone');
  assert.equal(phoneDevice.kind, 'mobile', 'admin.list 应标注 mobile');
  const desktopDevice = devices.payload.devices.find(d => d.id === 'my-desktop');
  assert.equal(desktopDevice.kind, 'extension', 'admin.list 应标注 extension');
  ok('admin.list 下发设备类型');

  [admin, desktop, legacy, phone2].forEach(c => c.close());
}

/**
 * 重启与类型覆盖场景（独立状态目录与端口）：
 *  1. 手机断开后重启中继：离线手机的写任务仍被拒转（mobileIds 已落盘）
 *  2. 同一 id 改为 extension 接入：不再按人工终端处理，写任务正常投递
 */
async function restartScenario() {
  const port = PORT + 2;
  const dir = mkdtempSync(join(tmpdir(), 't2c-mobile-restart-'));

  const start = () => {
    const child = spawn(process.execPath, ['relay/server.js'], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        TALK2COPILOT_TOKEN: TOKEN,
        TALK2COPILOT_ADMIN_TOKEN: ADMIN_TOKEN,
        TALK2COPILOT_MOBILE_TOKEN: MOBILE_TOKEN,
        STATE_DIRECTORY: dir,
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relays.push(child);
    return child;
  };
  const stop = child => new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });

  let child = start();
  await waitHealthy(port);

  const admin = connect(port, 'r-admin', { admin: ADMIN_TOKEN });
  await admin.opened;
  const created = await admin.control('admin', 'room-create', { name: 'restart-room' });
  const roomId = created.payload.room.id;

  const phone = connect(port, 'r-phone', { kind: 'mobile', protocol: PROTOCOL, mobileToken: MOBILE_TOKEN });
  await phone.opened;
  await phone.control('room', 'join', { roomId });
  phone.close();
  await sleep(150);

  // 重启中继（状态目录保留）
  await stop(child);
  child = start();
  await waitHealthy(port);

  const desktop = connect(port, 'r-desktop');
  await desktop.opened;
  await desktop.control('room', 'join', { roomId });

  const offlineTaskId = `restart-task-${Date.now()}`;
  desktop.send({ kind: 'message', id: offlineTaskId, to: 'r-phone', text: '重启后也不应补投', intent: 'task' });
  await desktop.waitFor(f => f.kind === 'error' && f.refId === offlineTaskId, '重启后 task 拒转');
  ok('中继重启后：离线手机的写任务仍被拒转（mobileIds 已落盘）');

  // 同一 id 改为 extension 接入：类型按当前连接覆盖
  const exPhone = connect(port, 'r-phone', { kind: 'extension' });
  await exPhone.opened;
  await exPhone.control('room', 'join', { roomId });
  const extTaskId = `ext-task-${Date.now()}`;
  desktop.send({ kind: 'message', id: extTaskId, to: 'r-phone', text: '现在应正常投递', intent: 'task' });
  await exPhone.waitFor(f => f.kind === 'message' && f.id === extTaskId, '改类型后 task 投递');
  ok('同一 id 改为 extension 接入后：写任务正常投递（类型按当前连接覆盖）');

  [admin, desktop, exPhone].forEach(c => c.close());
  await stop(child);
  rmSync(dir, { recursive: true, force: true });
}

try {
  await main();
  await restartScenario();
  console.log(`\n手机门禁专项测试：全部 ${passed} 项通过`);
} catch (err) {
  console.error(`\n测试失败：${err.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all(relays.map(child => new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill('SIGTERM');
  })));
  rmSync(STATE_DIR, { recursive: true, force: true });
}
