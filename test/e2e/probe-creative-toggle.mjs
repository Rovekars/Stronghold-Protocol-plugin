// 探针：创造模式大厅卡片的开关点击行为复现。
// 被怀疑的 bug：CreativeLobbyCard 的整行是一个 <button>，pill 开关是嵌在里面的另一个 <button>
//   （HTML 不允许按钮嵌套），且主开关的 pill 传 stop=false —— 点击 pill 会冒泡到外层再触发一次 toggle。
// 本探针分别测量三条点击路径：pill 本体 / 卡片正文 / 无限资金 pill，观察 aria-pressed 与 toast 次数。
import { startRealServer, Client } from './client.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }
mkdirSync(path.join(ROOT, 'test/e2e/out'), { recursive: true });

const FAIL = [];
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'crv', { prefix: 'crv' });
const log = (...a) => console.log('[crv]', ...a);
try {
  await c.open();
  // title screen → lobby: enter a codename and click 开始
  await c.page.waitForSelector('input', { timeout: 20000 });
  await c.page.keyboard.type('探针');
  await c.page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /开\s*始/.test(b.textContent));
    btn?.click();
  });
  // deterministic off state
  await c.page.evaluate(() => { try { localStorage.removeItem('sp.creativemode.pref'); } catch { /* ignore */ } });
  await c.page.reload({ waitUntil: 'networkidle2' });
  await c.page.waitForSelector('.lobby-mod-entries .brackets', { timeout: 30000 });
  const card = await c.page.$('.lobby-mod-entries .brackets');
  await card.screenshot({ path: path.join(ROOT, 'test/e2e/out/crv-card.png') });

  const readState = () => c.page.evaluate(() => {
    const card = document.querySelector('.lobby-mod-entries .brackets');
    const row = card.querySelector(':scope > button');
    const pill = row.querySelector(':scope button'); // nested pill
    const infPill = card.querySelector(':scope > div > button'); // footer row: <div><span>文案</span><button pill/></div>
    const toasts = [...document.querySelectorAll('.toast-host .toast')].map((t) => ({
      text: t.querySelector('.toast__text')?.textContent,
      count: t.querySelector('.toast__count')?.textContent || '1',
    }));
    return {
      rowPressed: row?.getAttribute('aria-pressed'),
      pillPressed: pill?.getAttribute('aria-pressed'),
      infPressed: infPill?.getAttribute('aria-pressed'),
      toasts,
    };
  });

  const clearToasts = () => c.page.evaluate(() => {
    document.querySelectorAll('.toast-host .toast').forEach((t) => t.remove());
  });

  const s0 = await readState();
  log('初始:', JSON.stringify(s0));

  // 1) click the nested pill of the main row
  await c.page.evaluate(() => {
    const card = document.querySelector('.lobby-mod-entries .brackets');
    const row = card.querySelector(':scope > button');
    row.querySelector(':scope button').click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const s1 = await readState();
  log('点击创造模式 pill 后:', JSON.stringify(s1));
  if (s1.rowPressed !== 'true') FAIL.push(`点击 pill 后创造模式未开启（aria-pressed=${s1.rowPressed}）`);
  if (s1.toasts.length !== 1 || s1.toasts[0].count !== '1') FAIL.push(`点击 pill 触发了 ${s1.toasts.length} 条 toast（count=${s1.toasts.map((t) => t.count)}）—— 单击被结算了多次`);
  clearToasts();

  // 2) click the card body (title area) — should toggle once
  await c.page.evaluate(() => {
    const card = document.querySelector('.lobby-mod-entries .brackets');
    const row = card.querySelector(':scope > button');
    row.querySelectorAll(':scope span')[2]?.click(); // the title span 创造模式
  });
  await new Promise((r) => setTimeout(r, 300));
  const s2 = await readState();
  log('点击卡片正文后:', JSON.stringify(s2));
  if (s2.rowPressed !== 'false') FAIL.push(`点击正文后创造模式未关闭（aria-pressed=${s2.rowPressed}）`);
  if (s2.toasts.length !== 1 || s2.toasts[0].count !== '1') FAIL.push(`点击正文触发了 ${s2.toasts.length} 条 toast（count=${s2.toasts.map((t) => t.count)}）`);
  clearToasts();

  // 3) the 无限资金 pill (control group — has stopPropagation)
  await c.page.evaluate(() => {
    const card = document.querySelector('.lobby-mod-entries .brackets');
    card.querySelector(':scope > div > button').click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const s3 = await readState();
  log('点击无限资金 pill 后:', JSON.stringify(s3));
  if (s3.infPressed !== 'true') FAIL.push(`无限资金 pill 点击后未开启（aria-pressed=${s3.infPressed}）`);
  if (s3.toasts.length !== 1 || s3.toasts[0].count !== '1') FAIL.push(`无限资金 pill 触发了 ${s3.toasts.length} 条 toast（count=${s3.toasts.map((t) => t.count)}）`);

  if (c.problems.length) FAIL.push(`页面错误：\n${c.problems.join('\n')}`);
  log(FAIL.length ? `FAIL(${FAIL.length})` : 'ALL OK');
} catch (e) {
  FAIL.push(String(e && e.stack || e));
} finally {
  await c.close?.().catch?.(() => {});
  await srv.stop({ hard: true });
}
if (FAIL.length) { console.error(FAIL.join('\n')); process.exit(1); }
