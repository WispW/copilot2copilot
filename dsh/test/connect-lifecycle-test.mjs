/**
 * DSH 连接生命周期测试：
 *   node dsh/test/connect-lifecycle-test.mjs
 *
 * 覆盖三个曾经出过问题的路径：
 *   1) 面板写入畸形中继地址：必须被 /config 拒绝，且不能把 Host 进程带崩；
 *   2) 并发连接：多次点「重试连接」只能建立一条 WebSocket（旧实现会并发建连卡在 4005）；
 *   3) 手动断开：peers/中继版本要清空，等待中的 c2c_send 要立刻结算而不是干等超时。
 *
 * 用最小宿主 ctx + 一个假中继跑真实的 apply()，不依赖 DSH 运行时。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const home = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'));
process.env.DSH_HOME = home;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeout) throw new Error('等待条件超时');
    await sleep(25);
  }
}

// ── 假中继：/healthz + WS 升级计数 ────────────────────────────────────────
let healthzDelay = 0;
let upgradeCount = 0;
const relay = createServer((req, res) => {
  if (req.url.startsWith('/healthz')) {
    const answer = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '2026.10.30', protocol: 7 }));
    };
    if (healthzDelay > 0) setTimeout(answer, healthzDelay);
    else answer();
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true });
relay.on('upgrade', (req, socket, head) => {
  upgradeCount += 1;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
    // 上报一个在线同事，用来验证断开后 peers 会被清空
    ws.send(JSON.stringify({
      v: 6, kind: 'presence', id: 'p-1', from: 'server', to: '*', ts: Date.now(),
      peers: ['peer-x'], profiles: [{ id: 'peer-x', role: 'r', scope: 's' }],
    }));
  });
});
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;

// ── 最小宿主 ctx ─────────────────────────────────────────────────────────
const routes = new Map();
const tools = new Map();
const disposers = [];
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => {}; } },
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  },
};

const { apply } = await import('../index.js');
apply(ctx, { relayUrl: '', id: 'lifecycle-test', role: '测试', scope: '连接生命周期', autoConnect: false });

// 把已注册的路由挂到真实 HTTP 服务器上（readJsonBody 需要真实的请求流）
const app = createServer((req, res) => {
  const path = new URL(req.url, 'http://placeholder').pathname;
  const handler = routes.get(path);
  if (!handler) {
    res.writeHead(404);
    res.end();
    return;
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    res.writeHead(500);
    res.end(String(err && err.message ? err.message : err));
  });
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}/copilot2copilot`;
const getState = async () => (await fetch(`${base}/state`)).json();
const getConfig = async () => (await fetch(`${base}/config`)).json();
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

try {
  // ── 1. 畸形地址必须被拒，且 Host 仍然活着 ──────────────────────────────
  const bad = ['ws://a b', 'ws://127.0.0.1:87a7', 'wss://', 'ftp://relay.example.com', 'ws://relay.example.com/ws'];
  for (const relayUrlBad of bad) {
    const saved = await post('/config', { relayUrl: relayUrlBad });
    assert.equal(saved.status, 400, `畸形地址应被拒绝：${relayUrlBad}`);
    assert.ok(saved.body.error, `应返回错误原因：${relayUrlBad}`);
  }
  assert.equal((await getConfig()).config.relayUrl, '', '畸形地址不得写进配置');
  assert.equal((await getState()).status, 'offline', '被拒后应保持 offline');
  assert.ok((await getState()).configured === false, '未保存任何有效地址');

  // 合法地址会被规范化成 origin（去掉末尾斜杠 / 补 ws://）
  const ok = await post('/config', { relayUrl: `http://127.0.0.1:${relay.address().port}/` });
  assert.equal(ok.status, 200, '合法地址应保存成功');
  assert.equal(ok.body.config.relayUrl, relayUrl, '应规范化为 ws://host:port');
  await waitFor(async () => (await getState()).status === 'online');
  await post('/disconnect');

  // ── 2. 并发连接只能建立一条 WS ─────────────────────────────────────────
  healthzDelay = 150; // 拉长探测窗口，让并发的 /connect 撞在一起
  upgradeCount = 0;
  await Promise.all([post('/connect'), post('/connect'), post('/connect')]);
  await waitFor(async () => (await getState()).status === 'online');
  await sleep(200);
  assert.equal(upgradeCount, 1, `并发重试只应建立一条 WS，实际 ${upgradeCount} 条`);

  // ── 3. 手动断开要清干净 ────────────────────────────────────────────────
  const online = await getState();
  assert.equal(online.status, 'online');
  assert.equal(online.peers.length, 1, '连接后应看到在线同事');

  // 等待中的发送在断开时必须立刻结算，而不是干等到 wait_seconds 超时
  const sendPromise = tools.get('c2c_send').execute({ to: 'peer-x', message: 'ping', wait_seconds: 120 });
  await sleep(120);
  const before = Date.now();
  await post('/disconnect');
  const sendResult = await sendPromise;
  const elapsed = Date.now() - before;
  assert.equal(sendResult.status, 'offline', '断开后等待中的发送应以 offline 结算');
  assert.ok(elapsed < 3000, `应在断开时立刻结算，实际等了 ${elapsed}ms`);

  const after = await getState();
  assert.deepEqual(after.peers, [], '断开后不应残留在线同事');
  assert.equal(after.relayVersion, '', '断开后不应残留中继版本');
  assert.equal(after.status, 'offline');
  assert.equal((await getConfig()).config.relayUrl, relayUrl, '断开不应清掉已保存的配置');

  console.log('DSH 连接生命周期测试：全部通过');
} finally {
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch { /* ignore */ }
  }
  await new Promise((resolve) => app.close(resolve));
  wss.close();
  await new Promise((resolve) => relay.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
