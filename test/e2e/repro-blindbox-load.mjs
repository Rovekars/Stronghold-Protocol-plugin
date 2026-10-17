// 复现 / 冒烟：盲盒插件在真实浏览器里能否正常加载。
// 历史 bug：MOD 顶层 `({ X } = await import('/js/ui/xxx.js'))` 忘了在声明行补 X —— ESM 严格模式下
//   给未声明变量赋值直接抛 ReferenceError，`node --check` 查不出来，只有真跑才炸（插件整份失效）。
// main.js 把每个插件的加载结果放进 __SP__.plugins（含 meta.error），本脚本断言盲盒插件 error 为空。
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const FAIL = [];
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'load', { prefix: 'load' });
const log = (...a) => console.log('[load]', ...a);
try {
  await c.open();
  const plugins = await c.page.waitForFunction(
    () => (globalThis.__SP__ && globalThis.__SP__.plugins && globalThis.__SP__.plugins.length
      ? globalThis.__SP__.plugins : null),
    { timeout: 30000, polling: 200 },
  ).then((h) => h.jsonValue());
  log('plugins loaded:', plugins.length);
  for (const p of plugins) log(`  - ${p.name || p.id}: ${p.error ? 'ERROR ' + p.error : 'ok'}`);
  const bb = plugins.find((p) => /盲盒/.test(p.name || p.id || ''));
  if (!bb) FAIL.push('盲盒插件没有出现在 __SP__.plugins 里');
  else if (bb.error) FAIL.push(`盲盒插件加载失败：${bb.error}`);
  if (c.problems.length) FAIL.push(`页面错误：\n${c.problems.join('\n')}`);
  log(FAIL.length ? `FAIL(${FAIL.length})` : 'ALL OK');
} catch (e) {
  FAIL.push(String(e && e.stack || e));
} finally {
  await c.close?.().catch?.(() => {});
  await srv.stop({ hard: true });
}
if (FAIL.length) { console.error(FAIL.join('\n')); process.exit(1); }
