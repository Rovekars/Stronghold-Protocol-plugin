// 复现脚本：砸罐子模式两个用户实测问题
// ① 未砸罐就出怪（jar 模式下所有怪只能来自罐子、砸开后 5 秒才出）
// ② 砸出的干员/道具不出现在等待区、战斗中无法放置（快速部署条被 HUD 盖住？）
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
const c = new Client(await pptr(), srv.base, 'repro', { prefix: 'repro' });
const log = (...a) => console.log('[repro]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await c.open();
  if (process.env.FORCE_FALLBACK === '1') {
    await c.page.evaluate(() => { globalThis.__SP_RENDER__ = 'fallback'; });
  }
  await c.page.evaluate(() => localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: 'jar' })));
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('杜宾');
  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', process.env.BB_DIFF || '绝境模拟');
  await c.click('.create-box button', '开始独立模拟');
  await c.waitFor((s) => !!s.room, 'solo room', 30000);
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  log('reached prep, round', (await c.st()).round);

  // 等自动开战
  const auto = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    for (let i = 0; i < 80 && st().match.public.phase !== 'COMBAT'; i++) await sleepL(100);
    return { phase: st().match.public.phase, jars: ((st().match.private || {}).jars || []).length };
  });
  log('AUTO COMBAT:', JSON.stringify(auto));
  if (auto.phase !== 'COMBAT') { FAIL.push('没有自动开战'); throw new Error('no combat'); }

  // ① 不砸任何罐子，连续采样敌人数量 14 秒（用户：还没砸罐子就出怪）
  const timeline = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    const fid = (st().match.field || {}).fieldId || (st().match.battle || {}).fieldId || null;
    const r = globalThis.__SP_RUNNER__;
    const bid = (st().match.battle || {}).battleId || null;
    const entry = bid && r && r._entries ? r._entries.get(bid) : null;
    const rows = [];
    for (let i = 0; i < 14; i++) {
      await sleepL(1000);
      const list = r && typeof r.fieldUnits === 'function' && fid ? (r.fieldUnits(fid) || []) : [];
      const foes = list.filter((u) => u && u.side === 'enemy').length;
      rows.push({ t: i + 1, foes, bt: entry && entry.battle ? Math.round((entry.battle.time || 0) * 10) / 10 : null, total: entry && entry.battle ? entry.battle.total : null });
    }
    return { fid, rows };
  });
  log('ENEMY TIMELINE (no smash):', JSON.stringify(timeline));
  const maxFoes = Math.max(...timeline.rows.map((r) => r.foes));
  if (maxFoes > 0) FAIL.push(`① 未砸罐就出怪：${maxFoes} 个敌人出现（timeline=${timeline.rows.map((r) => r.foes).join(',')}）`);

  // ② 砸罐拿到干员+道具，检查快速部署条是否可见
  const gather = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    const handPieces = (kind) => {
      const priv = st().match.private || {};
      return [...(priv.temp || []), ...(priv.hand || [])].filter((p) => p && p.kind === kind);
    };
    let smashed = 0;
    for (let i = 0; i < 30 && (handPieces('chess').length === 0 || handPieces('item').length === 0); i++) {
      const js = jars();
      if (!js.length) break;
      try { await net.request('g.smashJar', { jarId: js[0].id }); smashed++; } catch { /* ignore */ }
      await sleepL(350);
    }
    return { smashed, chess: handPieces('chess').length, items: handPieces('item').length, left: jars().length };
  });
  log('GATHER:', JSON.stringify(gather));
  await sleep(3500); // 等揭示浮层（2.6s）完全退出 + m.private 推送

  const ui = await c.page.evaluate(() => {
    const shopbar = document.querySelector('.shopbar');
    const r = shopbar ? shopbar.getBoundingClientRect() : null;
    return {
      privChess: ((globalThis.__SP__.store.get().match.private || {}).hand || []).filter(Boolean).length,
      // 原生商店栏（jar 模式下 = JarBar）：开战后必须还在原地（用户要求：商店位置不变）
      shopbarExists: !!shopbar,
      shopbarLabel: shopbar?.getAttribute('aria-label') || null,
      shopbarVisible: !!(r && r.width > 0 && r.height > 0),
      // 自建 UI 必须不存在
      jarDeployGone: !document.querySelector('.jar-deploy'),
      jarCombatInfoGone: !document.querySelector('.jar-combat-info'),
    };
  });
  log('NATIVE BAR UI:', JSON.stringify(ui));

  // ③ 原生待部署区必须在战斗中可见，倒计时必须隐藏，商店栏必须原位常驻
  const handCheck = await c.page.evaluate(() => {
    const label = document.querySelector('.ff-hand-label');
    const slots = [...document.querySelectorAll('.ff-slot')];
    const pieces = [...document.querySelectorAll('.ff-piece')];
    const cd = document.querySelector('.countdown');
    const cdStyle = cd ? getComputedStyle(cd) : null;
      const handRect = label ? label.getBoundingClientRect() : null;
    const sp = globalThis.__SP__;
    const pr = sp && sp.store ? sp.store.get().match?.private : null;
    // 引擎视图：整备区棋子是 canvas 渲染的，用 view.raw.jarBench()（prep 棋子视图数）探
    let benchCount = null;
    try { benchCount = typeof globalThis.__SP_VIEW__?.raw?.jarBench === 'function' ? globalThis.__SP_VIEW__.raw.jarBench() : null; } catch { /* ignore */ }
    return {
      viewKind: globalThis.__SP_VIEW__?.kind || null,
      boardClass: document.querySelector('.ff-board')?.className || null,
      storeHand: Array.isArray(pr?.hand) ? pr.hand.filter(Boolean).length : 'na',
      storeTemp: Array.isArray(pr?.temp) ? pr.temp.filter(Boolean).length : 'na',
      benchCount,
      handLabelExists: !!label,
      handLabelText: label ? label.textContent.trim() : null,
      handLabelVisible: !!(handRect && handRect.width > 0 && handRect.height > 0),
      slotCount: slots.length,
      pieceCount: pieces.length,
      jarDeployGone: !document.querySelector('.jar-deploy'),
      jarCombatInfoGone: !document.querySelector('.jar-combat-info'),
      countdownExists: !!cd,
      countdownDisplay: cdStyle ? cdStyle.display : null,
      pieceKinds: pieces.slice(0, 8).map((p) => p.className.split(/\s+/).find((c) => c.startsWith('ff-piece--'))?.replace('ff-piece--', '') || '?'),
    };
  });
  log('HAND AREA UI:', JSON.stringify(handCheck));
  await c.shot('repro-jar-issues');
  if (handCheck.viewKind === 'fallback') {
    if (!handCheck.handLabelExists || !handCheck.handLabelVisible) FAIL.push('fallback 视图：原生待部署区（整备区）在 jar 战斗中没有显示');
    if (handCheck.pieceCount === 0) FAIL.push('fallback 视图：原生待部署区里没有砸出的干员/道具卡片');
  } else {
    // 引擎视图：原生整备区是 canvas 渲染的，用 view.raw.jarBench()（prep 棋子视图数）探
    if (!(handCheck.benchCount > 0)) FAIL.push(`引擎视图：原生整备区里没有砸出的干员/道具（jarBench=${handCheck.benchCount}，storeHand=${handCheck.storeHand}）`);
  }
  if (!handCheck.jarDeployGone) FAIL.push('自建「快速部署」条仍然存在（应已删除，走原生整备区）');
  if (!handCheck.jarCombatInfoGone) FAIL.push('左下角自建信息条仍然存在（应已删除，商店栏原位常驻取代）');
  if (!ui.shopbarExists || !ui.shopbarVisible) FAIL.push(`jar 战斗中原生商店栏不在原位（shopbarExists=${ui.shopbarExists}, visible=${ui.shopbarVisible}）`);
  if (handCheck.countdownExists && handCheck.countdownDisplay !== 'none') FAIL.push('jar 战斗中倒计时仍然可见');

  // ④ 倒计时的运行逻辑不生效：battle.timeLimit = 3600（引擎硬顶，本波倒计时不再驱动战斗）；
  //    砸光全部罐子后锚点被撤（b.jarClear / removeSpawnsByTag），战斗恢复「清完即收尾」的自然结束。
  const timer = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    const net = globalThis.__SP__.net;
    const bid = (st().match.battle || {}).battleId || null;
    const r = globalThis.__SP_RUNNER__;
    const entry = bid && r && r._entries ? r._entries.get(bid) : null;
    const out = { timeLimit: entry && entry.battle ? entry.battle.timeLimit : null };
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    for (let i = 0; i < 40 && jars().length; i++) {
      try { await net.request('g.smashJar', { jarId: jars()[0].id }); } catch { /* ignore */ }
      await sleepL(250);
    }
    out.unsmashed = jars().length;
    await sleepL(6000); // 撤锚点延迟 4s + 敌人注入/结算余量
    const b2 = entry && entry.battle;
    out.anchorPending = b2 && Array.isArray(b2._pending) ? b2._pending.filter((p) => p && p.tag === 'jar-anchor').length : 'na';
    out.finished = b2 ? !!b2.finished : null;
    out.reason = b2 && b2.finished ? b2.reason : null;
    return out;
  });
  log('TIMER LOGIC:', JSON.stringify(timer));
  if (timer.timeLimit !== 3600) FAIL.push(`jar 战斗时限应为 3600（倒计时逻辑关闭），实际 ${timer.timeLimit}`);
  if (timer.unsmashed !== 0) FAIL.push(`还有 ${timer.unsmashed} 个罐子没砸开`);
  if (timer.anchorPending !== 0) FAIL.push(`最后一罐砸开后锚点仍挂在 pending 里（=${timer.anchorPending}）——战斗会永远等不到收尾`);
} catch (e) {
  log('ERROR:', e?.message || e);
  try { await c.shot('repro-jar-issues-fail'); } catch {}
} finally {
  if (FAIL.length) {
    log('FAILED EXPECTATIONS:', JSON.stringify(FAIL, null, 1));
    process.exitCode = 1;
  } else {
    log('ALL EXPECTATIONS MET');
  }
  await c.close();
  await srv.stop();
}
