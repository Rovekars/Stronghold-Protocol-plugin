// 回归测试：jar 模式回合推进与罐子刷新规则（用户需求）
// ① 砸完场上所有罐子、敌人出完且场上没有敌人 → 进入下一回合；
// ② 有干员部署的地块不刷新罐子（跨回合保留部署，新罐只落空闲格）。
import { startRealServer, Client } from './client.mjs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FAIL = [];
const srv = await startRealServer();
const c = new Client(await import('puppeteer-core').then((m) => m.default), srv.base, 'jarround', { prefix: 'jarround' });
const log = (...a) => console.log('[jarround]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await c.open();
  if (process.env.FORCE_FALLBACK === '1') await c.page.evaluate(() => { globalThis.__SP_RENDER__ = 'fallback'; });
  await c.page.evaluate(() => localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: 'jar' })));
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
  await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    for (let i = 0; i < 80 && st().match.public.phase !== 'COMBAT'; i++) await sl(100);
  });

  // ① 砸完全部罐子
  const smashedAll = await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    let n = 0;
    for (let i = 0; i < 60 && jars().length; i++) {
      try { await net.request('g.smashJar', { jarId: jars()[0].id }); n++; } catch { /* ignore */ }
      await sl(250);
    }
    return { smashed: n, left: jars().length, hand: ((st().match.private || {}).hand || []).filter((p) => p && p.kind === 'chess').length };
  });
  log('SMASHED ALL:', JSON.stringify(smashedAll));
  if (smashedAll.left !== 0) FAIL.push(`还有 ${smashedAll.left} 个罐子没砸开`);

  // 把所有拿到的干员部署到已砸开的罐子格上（走标准 g.move，服务端即时注入战斗）
  const deployed = await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const priv = () => st().match.private || {};
    const placed = [];
    for (let round = 0; round < 3; round++) {
      const hand = (priv().hand || []).filter((p) => p && p.kind === 'chess');
      if (!hand.length) break;
      // 找一个没有己方棋子的格子：优先已砸开的罐子格
      const boardKeys = new Set((priv().board || []).map((p) => `${p.row},${p.col}`));
      const free = (priv().jars || []).filter((j) => j && j.smashed && !boardKeys.has(`${j.row},${j.col}`));
      const spots = free.length ? free : (priv().jars || []).filter((j) => j && !boardKeys.has(`${j.row},${j.col}`));
      if (!spots.length) break;
      const spot = spots[0];
      try {
        await net.request('g.move', { uid: hand[0].uid, to: { area: 'board', row: spot.row, col: spot.col }, dir: 'RIGHT' });
        placed.push({ uid: hand[0].uid, row: spot.row, col: spot.col });
      } catch { /* ignore */ }
      await sl(400);
    }
    await sl(500);
    return { placed, board: (priv().board || []).filter((p) => p && p.kind === 'chess').map((p) => ({ uid: p.uid, row: p.row, col: p.col })) };
  });
  log('DEPLOYED:', JSON.stringify(deployed));
  if (!deployed.board.length) FAIL.push('一个干员都没部署上去（g.move 被拒？）');

  // ② 等回合推进：砸完全部罐 + 敌人出完 + 场上无敌人 → 下一回合（轮次 +1）
  const advance = await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    const startRound = st().match.public.round || 1;
    const t0 = Date.now();
    let seen = null;
    while (Date.now() - t0 < 150000) {
      const s = st();
      const pub = s.match.public || {};
      const priv = s.match.private || {};
      if ((pub.round || 1) > startRound) {
        seen = { round: pub.round, phase: pub.phase, jars: (priv.jars || []).length, hand: (priv.hand || []).filter((p) => p && p.kind === 'chess').length };
        break;
      }
      await sl(500);
    }
    return { startRound, seen, elapsedMs: Date.now() - t0 };
  });
  log('ADVANCE:', JSON.stringify(advance));
  if (!advance.seen) FAIL.push(`砸完全部罐子并部署后 ${advance.elapsedMs}ms 内没有进入下一回合（round 仍是 ${advance.startRound}）`);
  else if (!advance.seen.jars) FAIL.push('下一回合没有生成新罐子');

  // ③ 新回合的罐子不得落在已部署干员的格上；干员跨回合保留。
  // 注意：回合推进先到 ROUND_START，jar 的新罐子在随后的 PREP 钩子里才生成（之前 priv.jars 还是上轮旧罐），
  // 所以要等到 PREP / COMBAT 再检查。
  const after = await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const ph = (st().match.public || {}).phase;
      if (ph === 'PREP' || ph === 'COMBAT') break;
      await sl(200);
    }
    await sl(300);
    const priv = st().match.private || {};
    return {
      round: (st().match.public || {}).round,
      phase: (st().match.public || {}).phase,
      board: (priv.board || []).filter((p) => p && p.kind === 'chess').map((p) => ({ row: p.row, col: p.col })),
      jarTiles: (priv.jars || []).map((j) => `${j.row},${j.col}`),
      unsmashed: (priv.jars || []).filter((j) => j && !j.smashed).length,
    };
  });
  log('AFTER:', JSON.stringify(after));
  const occupied = new Set(after.board.map((b) => `${b.row},${b.col}`));
  const clash = after.jarTiles.filter((k) => occupied.has(k));
  if (clash.length) FAIL.push(`新回合在有干员的地块上刷了罐子：${JSON.stringify(clash)}（部署：${JSON.stringify(after.board)}）`);
  if (!after.board.length) FAIL.push('上一波部署的干员没有保留到下一回合');
  if (!after.unsmashed) FAIL.push('新回合没有生成未砸的新罐子');

  // ④ 资金不清零：第 2 回合战斗中资金 > 0（上回合结余 + 本回合收入），且战斗中能升级调度中心
  const funds = await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && (st().match.public || {}).phase !== 'COMBAT') await sl(200);
    const priv = () => st().match.private || {};
    const f0 = Number(priv().funds) || 0;
    const lv0 = (priv().shop || {}).level ?? 1;
    let upRes = null;
    try { upRes = await net.request('g.levelUp'); } catch (e) { upRes = { err: String(e && e.message || e) }; }
    await sl(300);
    return { phase: (st().match.public || {}).phase, fundsBefore: f0, levelBefore: lv0, upRes, fundsAfter: Number(priv().funds) || 0, levelAfter: (priv().shop || {}).level ?? 1 };
  });
  log('FUNDS:', JSON.stringify(funds));
  if (!(funds.fundsBefore > 0)) FAIL.push(`第 2 回合资金被归零（${funds.fundsBefore}）——结余应跨回合保留`);
  if (!funds.upRes || funds.upRes.t !== 'ok') FAIL.push(`战斗中升级调度中心被拒：${JSON.stringify(funds.upRes)}`);
  if (funds.levelAfter !== funds.levelBefore + 1) FAIL.push(`升级后等级没变（${funds.levelBefore} → ${funds.levelAfter}）`);
  if (!(funds.fundsAfter < funds.fundsBefore)) FAIL.push(`升级没扣费（${funds.fundsBefore} → ${funds.fundsAfter}）`);
  await c.shot('jar-round-advance');
} catch (e) {
  log('ERROR:', (e && e.message) || e);
  FAIL.push(String((e && e.message) || e));
} finally {
  if (FAIL.length) { log('FAILED EXPECTATIONS:', JSON.stringify(FAIL, null, 1)); process.exitCode = 1; }
  else log('ALL EXPECTATIONS MET');
  await c.close();
  await srv.stop();
}
