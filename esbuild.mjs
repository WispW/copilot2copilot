import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  charset: 'utf8',
};

/**
 * 主界面（webview）：Preact + TSX → 单文件 IIFE。
 * 产物放 dist/（构建产物目录，不入库），源码在 src/webview/（.vscodeignore 已排除，不进 vsix）。
 * 不产出 sourcemap：包内不含 .map 文件，留下引用只会让 webview 里报 404。
 */
/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
  charset: 'utf8',
};

if (watch) {
  const [extensionCtx, webviewCtx] = await Promise.all([
    esbuild.context(options),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(options), esbuild.build(webviewOptions)]);
}
