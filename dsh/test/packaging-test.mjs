/**
 * DSH 打包排除测试：
 *   node dsh/test/packaging-test.mjs
 *
 * dsh/ 不属于 VS Code 扩展；若未加入 .vscodeignore，vsce 会把 dsh/.token
 * 或 dsh/node_modules 打进 vsix（Issue 发现于 PR #18 审查）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignore = readFileSync(join(REPO, '.vscodeignore'), 'utf8');

assert.match(ignore, /^dsh\/\*\*$/m, '.vscodeignore 必须排除 dsh/**');
assert.match(ignore, /node_modules\/\*\*/m, '根 node_modules 仍需排除');

console.log('DSH 打包排除测试：全部通过');
