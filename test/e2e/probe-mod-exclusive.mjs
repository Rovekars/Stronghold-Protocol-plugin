// 探针：创造模式 与 盲盒模式 不能同时启用（真实浏览器，走标题页 MOD 管理的真实点击）。
// 覆盖三件事：
//   ① 启动时纠正历史存档：若两个都启用，加载后自动卸下后加载的那个；
//   ② 在 MOD 管理里启用盲盒 → 创造模式自动变成「已卸下」并弹提示；
//   ③ 再启用创造模式 → 盲盒自动变成「已卸下」。
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const CREATIVE = 'creativemode';
const BLINDBOX = 'blindbox';
const FAIL = [];
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'mx', { prefix: 'mx' });
const log = (...a) => console.log('[mx]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await c.open();

  // ① startup reconcile: both enabled in the stored map → one must be auto-unloaded
  await c.page.evaluate((a, b) => {
    localStorage.setItem('sp.mods.off', JSON.stringify({}));
  }, CREATIVE, BLINDBOX);
  await c.page.reload({ waitUntil: 'networkidle2' });
  const ids = await c.page.waitForFunction(
    () => (globalThis.__SP__?.plugins?.length ? globalThis.__SP__.plugins.map((p) => p.id) : null),
    { timeout: 30000, polling: 200 },
  ).then((h) => h.jsonValue());
  log('插件:', ids.join(', '));
  if (!ids.includes(CREATIVE) || !ids.includes(BLINDBOX)) FAIL.push(`两个插件都应被加载：${ids.join(', ')}`);
  const offAfterBoot = await c.page.evaluate(() => JSON.parse(localStorage.getItem('sp.mods.off') || '{}'));
  const both = !offAfterBoot[CREATIVE] && !offAfterBoot[BLINDBOX];
  if (both) FAIL.push(`启动后两个插件仍然同时启用：${JSON.stringify(offAfterBoot)}`);
  log('启动后 sp.mods.off:', JSON.stringify(offAfterBoot));

  await sleep(600);
  // ② / ③: real clicks in the MOD manager
  const toggle = async (id) => c.page.evaluate((mid) => {
    const rows = [...document.querySelectorAll('.mod-mgr__row')];
    const row = rows.find((r) => {
      const name = r.querySelector('.plugin-card__name')?.textContent || '';
      return name === '创造模式' ? mid === 'creativemode' : name === '盲盒模式' ? mid === 'blindbox' : false;
    });
    if (!row) return null;
    const btn = row.querySelector('.plugin-card__toggle');
    const before = btn.textContent.trim();
    btn.click();
    return before;
  }, id);
  const states = () => c.page.evaluate(() => {
    const out = {};
    for (const r of document.querySelectorAll('.mod-mgr__row')) {
      const name = r.querySelector('.plugin-card__name')?.textContent || '';
      out[name] = r.querySelector('.plugin-card__toggle')?.textContent.trim();
    }
    out.__toast = [...document.querySelectorAll('.toast-host .toast__text')].map((t) => t.textContent);
    return out;
  });
  const openMgr = async () => {
    await c.page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /插件\s*MOD/.test(b.textContent));
      btn?.click();
    });
    await sleep(400); // let the panel body render before clicking a card
    await c.page.evaluate(() => document.querySelector('.plugin-card')?.click());
    await sleep(500); // …and the manager modal
  };

  // make sure both are off first (卸下 is never blocked)
  await openMgr();
  if (!(await c.page.$('.mod-mgr__row'))) FAIL.push('MOD 管理弹窗没有打开（.mod-mgr__row 为空）');
  for (const id of [CREATIVE, BLINDBOX]) {
    const s = await states();
    const label = id === CREATIVE ? '创造模式' : '盲盒模式';
    if (s[label] === '已启用') await toggle(id);
    await sleep(200);
  }

  // enable 盲盒模式 first, then 创造模式 — the first must be unloaded by the second
  await toggle(BLINDBOX);
  await sleep(400);
  let s = await states();
  log('启用盲盒后:', JSON.stringify(s));
  if (s['盲盒模式'] !== '已启用') FAIL.push(`盲盒模式应已启用，实际：${s['盲盒模式']}`);

  await toggle(CREATIVE);
  await sleep(400);
  s = await states();
  log('再启用创造模式后:', JSON.stringify(s));
  if (s['创造模式'] !== '已启用') FAIL.push(`创造模式应已启用，实际：${s['创造模式']}`);
  if (s['盲盒模式'] !== '已卸下') FAIL.push(`盲盒模式应被自动卸下，实际：${s['盲盒模式']}`);
  if (!s.__toast.some((t) => t && /不能同时启用/.test(t))) FAIL.push(`未提示自动卸下（toast=${JSON.stringify(s.__toast)}）`);

  // and back the other way
  await toggle(BLINDBOX);
  await sleep(400);
  s = await states();
  log('再启用盲盒后:', JSON.stringify(s));
  if (s['盲盒模式'] !== '已启用') FAIL.push(`盲盒模式应已启用，实际：${s['盲盒模式']}`);
  if (s['创造模式'] !== '已卸下') FAIL.push(`创造模式应被自动卸下，实际：${s['创造模式']}`);

  if (c.problems.length) FAIL.push(`页面错误：\n${c.problems.join('\n')}`);
  log(FAIL.length ? `FAIL(${FAIL.length})` : 'ALL OK');
} catch (e) {
  FAIL.push(String(e && e.stack || e));
} finally {
  await c.close?.().catch?.(() => {});
  await srv.stop({ hard: true });
}
if (FAIL.length) { console.error(FAIL.join('\n')); process.exit(1); }
