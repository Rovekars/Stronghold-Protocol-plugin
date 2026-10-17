// 复现脚本：盲盒敌人模式 → 进 PREP → 打开敌方情报抽屉 → 检查侦察按钮是否存在
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'repro', { prefix: 'repro' });
const log = (...a) => console.log('[repro]', ...a);
try {
  await c.open();
  await c.page.evaluate(() => localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: 'enemy' })));
  log('pref set to enemy:', await c.page.evaluate(() => localStorage.getItem('sp.blindbox.pref')));
  // 关掉可能自动弹出的玩法说明
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('杜宾');
  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', '绝境模拟');
  await c.click('.create-box button', '开始独立模拟');
  await c.waitFor((s) => !!s.room, 'solo room', 30000);
  log('room reached');
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  log('INFO_CHECK reached');
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  log('BAND_DRAFT reached');
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  const s0 = await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  log('reached', s0.phase, 'round', s0.round);
  // 确认服务端模式
  await sleep(800);
  const serverMode = await c.page.evaluate(() => globalThis.__SP__.store.get().match.public?.blindBoxMode ?? globalThis.__SP__.store.get().match.blindBox?.mode ?? 'unknown');
  const nextEnemies = await c.page.evaluate(() => globalThis.__SP__.store.get().match.private?.nextEnemies ?? null);
  log('serverMode(heuristic):', serverMode, 'nextEnemies:', JSON.stringify(nextEnemies));
  // 打开敌方情报抽屉（先测默认页签，再手动点 2 页签）
  await c.click('.gtop__iconbtn[aria-label="本局信息"]').catch((e) => log('open drawer failed', e.message));
  await c.page.waitForSelector('.edrawer', { timeout: 5000 });
  const defaultInfo = await c.page.evaluate(() => ({
    tabCount: document.querySelectorAll('.edrawer .tabs__tab').length,
    activeTab: [...document.querySelectorAll('.edrawer .tabs__tab')].findIndex((t) => t.classList.contains('is-active')),
  }));
  log('DEFAULT TAB:', JSON.stringify(defaultInfo));
  await c.click('.edrawer .tabs__tab:nth-child(2)');
  await sleep(400);
  const info = await c.page.evaluate(() => {
    const rows = [...document.querySelectorAll('.edrawer .erow')];
    const btn = document.querySelector('.blind-scout');
    return {
      tabCount: document.querySelectorAll('.edrawer .tabs__tab').length,
      activeTab: [...document.querySelectorAll('.edrawer .tabs__tab')].findIndex((t) => t.classList.contains('is-active')),
      rows: rows.map((r) => r.textContent.trim()),
      hasScoutButton: !!btn,
      scoutText: btn ? btn.textContent.trim() : null,
      nextEnemies: globalThis.__SP__.store.get().match.private?.nextEnemies ?? null,
    };
  });
  log('DRAWER INFO:', JSON.stringify(info, null, 2));
  await c.shot('repro-enemy');
  log('PROBLEMS:', JSON.stringify(c.problems));
} catch (e) {
  log('ERROR:', e?.message || e);
  try { await c.shot('repro-fail'); } catch {}
  log('PROBLEMS:', JSON.stringify(c.problems));
} finally {
  await c.close();
  await srv.stop();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
