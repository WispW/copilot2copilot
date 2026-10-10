/**
 * 信任授权通道专项测试（无头，可重复运行）：
 *   node relay/test/trust-test.mjs
 *
 * 会拉起一个临时中继实例（默认端口 18791，可用 TRUST_TEST_PORT 覆盖），使用临时状态目录，
 * 结束后清理；不影响正在运行的中继实例。覆盖：
 *   1. 上报授权 → 被授权方收到 grantedBy 下发（自授权被过滤）
 *   2. 全量收回（空名单）→ 被授权方名单清空
 *   3. 授予者断线 → 授权自动收回
 *   4. 多名授予者合并下发
 *   5. 被授权方重连 → 自动恢复下发完整名单
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

const PORT = Number(process.env.TRUST_TEST_PORT) || 18791;
const TOKEN = 't-trust';
// 扩展版本与中继版本必须一致（-testN 后缀被中继忽略）：直接读 package.json，避免手工同步
const CLIENT_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const STATE_DIR = mkdtempSync(join(tmpdir(), 't2c-trust-'));

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
    if (!relay || relay.exitCode !== null) {
      resolve();
      return;
    }
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

/** 等待 startIndex 之后（含数组里已到达的）第一个满足条件的事件；用于"状态变化"断言，避免命中历史事件 */
function waitForFrom(ws, startIndex, pred, label, timeout = 6000) {
  for (let i = startIndex; i < ws.events.length; i += 1) {
    if (pred(ws.events[i])) {
      return Promise.resolve(ws.events[i]);
    }
  }
  return new Promise((resolve, reject) => {
    const onMsg = data => {
      const env = JSON.parse(data.toString());
      if (pred(env)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(env);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`超时等待：${label}`));
    }, timeout);
    ws.on('message', onMsg);
  });
}

async function connect(id) {
  const headers = { 'x-client-version': CLIENT_VERSION, authorization: `Bearer ${TOKEN}` };
  const ws = track(new WebSocket(`ws://127.0.0.1:${PORT}/ws?id=${id}`, { headers }));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitForFrom(ws, 0, env => env.kind === 'room-event', `${id} 的首个 room-event`);
  return ws;
}

/** 发送 trust/report 并等待同 id 应答 */
function report(ws, grantees) {
  const id = `ctl-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('控制面超时：trust/report'));
    }, 5000);
    const onMsg = data => {
      const env = JSON.parse(data.toString());
      if (env.id === id && env.kind === 'trust') {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(env);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ v: 1, kind: 'trust', id, from: '', to: 'server', ts: Date.now(), op: 'report', payload: { grantees } }));
  });
}

const grantedByOf = env => (env && env.payload && Array.isArray(env.payload.grantedBy) ? env.payload.grantedBy : []);
const sameSet = (arr, expected) => {
  const a = [...new Set(arr)].sort().join(',');
  const b = [...expected].sort().join(',');
  return a === b;
};
const grantedEvent = expected => env =>
  env.kind === 'trust' && env.op === 'grantedBy' && sameSet(grantedByOf(env), expected);

try {
  startRelay();
  await waitHealthy();
  const alice = await connect('alice');
  const bob = await connect('bob');
  const carol = await connect('carol');
  ok('初始状态就绪：3 客户端在线');

  // 1) 上报授权（自授权 bob 应被过滤）
  let base = alice.events.length;
  const rep1 = await report(bob, ['alice', 'bob']);
  assert.equal(rep1.ok, true);
  await waitForFrom(alice, base, grantedEvent(['bob']), 'alice 收到被 bob 授权');
  ok('上报生效：bob → alice（自授权被过滤）');

  // 2) 全量收回
  base = alice.events.length;
  await report(bob, []);
  await waitForFrom(alice, base, grantedEvent([]), 'alice 收到授权收回');
  ok('收回生效：空名单清空授权');

  // 3) 授予者断线 → 授权自动收回
  await report(bob, ['alice']);
  await waitForFrom(alice, base, grantedEvent(['bob']), 'alice 收到重新授权');
  base = alice.events.length;
  bob.close();
  await waitForFrom(alice, base, grantedEvent([]), 'bob 断线后授权回收');
  ok('授予者断线：授权自动收回');

  // 4) 多名授予者合并
  const bob2 = await connect('bob');
  base = alice.events.length;
  await report(carol, ['alice']);
  await waitForFrom(alice, base, grantedEvent(['carol']), 'alice 收到 carol 授权');
  base = alice.events.length;
  await report(bob2, ['alice']);
  await waitForFrom(alice, base, grantedEvent(['bob', 'carol']), 'alice 收到两人授权合并');
  ok('多授予者：名单合并下发');

  // 5) 被授权方重连 → 自动恢复下发
  alice.close();
  const alice2 = await connect('alice');
  await waitForFrom(alice2, 0, grantedEvent(['bob', 'carol']), 'alice 重连后自动下发');
  ok('重连：自动恢复下发完整名单');

  console.log(`\n全部通过：${passed} 项`);
} catch (error) {
  console.error('\n测试失败：', error && error.message ? error.message : error);
  console.error('--- 中继日志（尾部）---');
  console.error(relayLog.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  try {
    await stopRelay();
  } catch {
    // 忽略
  }
  rmSync(STATE_DIR, { recursive: true, force: true });
}
