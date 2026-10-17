// 复现脚本：盲盒「敌人」模式 → PREP → ① 商店应该是官方商店且能正常购买 ② 敌方情报抽屉里应有侦察按钮且点了能侦察
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const MODE = process.env.BB_MODE || 'enemy';
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'repro', { prefix: 'repro' });
const log = (...a) => console.log('[repro]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await c.open();
  await c.page.evaluate((m) => localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: m })), MODE);
  log('pref:', await c.page.evaluate(() => localStorage.getItem('sp.blindbox.pref')));
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('杜宾');
  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', '绝境模拟');
  await c.click('.create-box button', '开始独立模拟');
  await c.waitFor((s) => !!s.room, 'solo room', 30000);
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  const s0 = await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  log('reached', s0.phase, 'round', s0.round);
  await sleep(1200);

  const before = await c.page.evaluate(() => {
    const p = globalThis.__SP__.store.get().match.private || {};
    return {
      funds: p.funds ?? null,
      slots: (p.shop?.slots || []).map((s) => ({ price: s?.price ?? null, sold: !!s?.sold, name: s?.card?.name ?? null })),
      blind: document.querySelectorAll('.scard--blind').length,
      cards: document.querySelectorAll('.scard').length,
      temp: (p.temp || []).filter(Boolean).length,
      hand: (p.hand || []).filter(Boolean).length,
    };
  });
  log('BEFORE BUY:', JSON.stringify(before, null, 1));

  // 尝试买下第一张卡（官方商店是两段确认：点一次 armed，再点一次成交）
  // 记录所有上行请求，便于判断「点击到底有没有发出 g.buy」
  await c.page.evaluate(() => {
    window.__REQ = [];
    const net = globalThis.__SP__.net;
    const orig = net.request.bind(net);
    net.request = (t, f, o) => { window.__REQ.push(t); return orig(t, f, o); };
  });
  const diag = await c.page.evaluate(() => [...document.querySelectorAll('.scard')].map((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      cls: el.className, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      hit: hit ? (hit.className || hit.tagName) : null, contains: hit ? el.contains(hit) : false,
      disabled: !!el.disabled, pointerEvents: getComputedStyle(el).pointerEvents,
    };
  }));
  log('CARD DIAG:', JSON.stringify(diag, null, 1));
  let buyLog = 'not attempted';
  if (before.cards > 0) {
    // A) 真实鼠标（c.click）
    await c.click('.scard', null, { nth: 0, timeout: 15000 });
    await sleep(400);
    const armedA = await c.page.evaluate(() => document.querySelectorAll('.scard.is-armed').length);
    await c.click('.scard', null, { nth: 0, timeout: 15000 });
    await sleep(1200);
    const afterA = await c.page.evaluate(() => ({ reqs: window.__REQ.slice(), funds: globalThis.__SP__.store.get().match.private?.funds ?? null }));
    log('A) real mouse:', JSON.stringify({ armed: armedA, ...afterA }));
    // B) DOM click（绕开命中判定，验证是「点不到」还是「点了没反应」）
    await c.page.evaluate(() => { const el = document.querySelectorAll('.scard')[0]; el && el.click(); });
    await sleep(400);
    const armedB = await c.page.evaluate(() => document.querySelectorAll('.scard.is-armed').length);
    await c.page.evaluate(() => { const el = document.querySelectorAll('.scard')[0]; el && el.click(); });
    await sleep(1500);
    const after = await c.page.evaluate(() => {
      const p = globalThis.__SP__.store.get().match.private || {};
      return {
        funds: p.funds ?? null,
        slots: (p.shop?.slots || []).map((s) => ({ price: s?.price ?? null, sold: !!s?.sold })),
        temp: (p.temp || []).filter(Boolean).length,
        hand: (p.hand || []).filter(Boolean).length,
        board: (p.board || []).length,
        reqs: window.__REQ.slice(),
        toast: document.querySelector('.toast')?.textContent?.trim() || null,
      };
    });
    buyLog = JSON.stringify({ armedAfterFirstTap: armedB, ...after });
  }
  log('AFTER BUY:', buyLog);

  // 敌方情报抽屉：侦察按钮 + 点击侦察
  await c.click('.gtop__iconbtn[aria-label="本局信息"]').catch((e) => log('open drawer failed', e.message));
  await c.page.waitForSelector('.edrawer', { timeout: 5000 });
  const drawer = await c.page.evaluate(() => ({
    activeTab: [...document.querySelectorAll('.edrawer .tabs__tab')].findIndex((t) => t.classList.contains('is-active')),
    rows: [...document.querySelectorAll('.edrawer .erow')].map((r) => r.textContent.trim()),
    scoutBtn: !!document.querySelector('.blind-scout'),
    scoutText: document.querySelector('.blind-scout')?.textContent.trim() || null,
    nextEnemies: globalThis.__SP__.store.get().match.private?.nextEnemies ?? null,
  }));
  log('DRAWER:', JSON.stringify(drawer, null, 1));
  if (drawer.scoutBtn) {
    await c.click('.blind-scout');
    await sleep(1500);
    const after = await c.page.evaluate(() => ({
      rows: [...document.querySelectorAll('.edrawer .erow')].map((r) => r.textContent.trim()),
      nextEnemies: globalThis.__SP__.store.get().match.private?.nextEnemies ?? null,
      funds: globalThis.__SP__.store.get().match.private?.funds ?? null,
    }));
    log('AFTER SCOUT:', JSON.stringify(after, null, 1));
  }
  await c.shot('repro-enemy-buy');
  log('PROBLEMS:', JSON.stringify(c.problems.slice(0, 12), null, 1));
} catch (e) {
  log('ERROR:', e?.message || e);
  try { await c.shot('repro-fail'); } catch {}
  log('PROBLEMS:', JSON.stringify(c.problems.slice(0, 12)));
} finally {
  await c.close();
  await srv.stop();
}
