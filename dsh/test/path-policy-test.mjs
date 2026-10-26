/**
 * DSH 文件外发路径策略测试：
 *   node dsh/test/path-policy-test.mjs
 *
 * 验证默认只允许 sendFileRoots 内的文件，且 realpath 能挡住符号链接逃逸；
 * allowAny 只作为显式开关。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFileAllowed } from '../index.js';

const base = mkdtempSync(join(tmpdir(), 'dsh-path-policy-'));
try {
  const root = join(base, 'outbox');
  mkdirSync(root);
  const inside = join(root, 'ok.txt');
  writeFileSync(inside, 'ok');
  const outside = join(base, 'secret.txt');
  writeFileSync(outside, 'secret');

  assert.equal(await isFileAllowed(inside, [root]), true, '白名单目录内文件应允许');
  assert.equal(await isFileAllowed(outside, [root]), false, '白名单目录外文件应拒绝');

  const link = join(root, 'link.txt');
  symlinkSync(outside, link);
  assert.equal(await isFileAllowed(link, [root]), false, '符号链接不得逃逸白名单');

  assert.equal(await isFileAllowed(outside, [root], true), true, 'allowAny 显式开启后允许任意文件');
  assert.equal(await isFileAllowed(join(base, 'missing.txt'), [root]), false, '不存在的文件应拒绝');

  console.log('DSH 文件外发路径策略测试：全部通过');
} finally {
  rmSync(base, { recursive: true, force: true });
}
