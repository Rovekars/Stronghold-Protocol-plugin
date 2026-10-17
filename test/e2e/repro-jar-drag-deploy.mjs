// 回归测试：jar 战斗中「原生整备区 → 拖拽 → 朝向轮盘 → g.move → 干员落场」全链路
// 背景：引擎视图 onPointerMove 曾用 drag.dragging 门控，而 pressed→dragging 的阈值判定就在
// pointerMove 内部——死锁成点击，干员永远拖不出去（用户实测「无法拖拽到场上放置」）。
// 现用 drag.active（pressed/dragging 都转发）。降级视图走自己的 DOM 拖拽，同样覆盖。
import { startRealServer, Client } from './client.mjs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FAIL = [];
const srv = await startRealServer();
const c = new Client(await import('puppeteer-core').then((m) => m.default), srv.base, 'jardrag', { prefix: 'jardrag' });
const log = (...a) => console.log('[jardrag]', ...a);
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
  // 砸罐：拿到干员，并砸开一个格子作落点
  await c.page.evaluate(async () => {
    const sl = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    for (let i = 0; i < 30; i++) {
      const hand = ((st().match.private || {}).hand || []).filter((p) => p && p.kind === 'chess');
      if (hand.length && jars().length) break;
      if (!jars().length) break;
      try { await net.request('g.smashJar', { jarId: jars()[0].id }); } catch { /* ignore */ }
      await sl(300);
    }
  });
  await sleep(3000);

  // 记录器：view 事件 + g.move 消息
  await c.page.evaluate(() => {
    const sp = globalThis.__SP__;
    const view = globalThis.__SP_VIEW__;
    const rec = { events: [], reqs: [] };
    window.__dragRec = rec;
    for (const n of ['pieceDragStart', 'pieceDrop', 'pieceDragEnd', 'pieceClick']) {
      view.on(n, (p) => rec.events.push({ n, uid: p && p.uid, from: p && p.from, target: p && p.target }));
    }
    const orig = sp.net.request.bind(sp.net);
    sp.net.request = (t, p) => { if (t === 'g.move') rec.reqs.push({ t, p: JSON.parse(JSON.stringify(p || {})) }); return orig(t, p); };
  });

  const pos = await c.page.evaluate(() => {
    const sp = globalThis.__SP__;
    const view = globalThis.__SP_VIEW__;
    const priv = sp.store.get().match.private || {};
    const hand = (priv.hand || []).filter((p) => p && p.kind === 'chess');
    const out = { viewKind: view.kind, hand: hand.length, bench: null, target: null };
    if (view.kind === 'fallback') {
      const chessUids = new Set(hand.map((p) => p.uid));
      const el = [...document.querySelectorAll('.ff-piece')].find((n) => chessUids.has(Number(n.dataset.uid)));
      if (el) { const r = el.getBoundingClientRect(); out.bench = { uid: Number(el.dataset.uid), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    } else {
      const chessUids = new Set(hand.map((p) => p.uid));
      for (const [k, v] of view.raw.debug.views) {
        if (!String(k).startsWith('p:') || !chessUids.has(Number(String(k).slice(2)))) continue;
        if (v.screen && Number.isFinite(v.screen.x) && Number.isFinite(v.screen.y)) { out.bench = { uid: Number(String(k).slice(2)), x: v.screen.x, y: v.screen.y }; break; }
      }
    }
    const jar = (priv.jars || []).find((j) => j && j.smashed) || null;
    if (jar) { const t = view.tileScreen(jar.row, jar.col); out.target = { row: jar.row, col: jar.col, x: t && t.x, y: t && t.y }; }
    return out;
  });
  log('POS:', JSON.stringify(pos));

  if (!pos.bench) FAIL.push(`整备区里没有拿到干员卡片（hand=${pos.hand}, view=${pos.viewKind}）`);
  if (!pos.target || !Number.isFinite(pos.target.x)) FAIL.push('没有已砸开的罐子格子作落点');

  if (pos.bench && pos.target && Number.isFinite(pos.target.x)) {
    // ① 从整备区干员处按下 → 拖向战场格（路过中点，越过拖拽阈值）→ 松手（pieceDrop）
    await c.page.mouse.move(pos.bench.x, pos.bench.y);
    await sleep(150);
    await c.page.mouse.down();
    await sleep(150);
    await c.page.mouse.move((pos.bench.x + pos.target.x) / 2, (pos.bench.y + pos.target.y) / 2, { steps: 8 });
    await c.page.mouse.move(pos.target.x, pos.target.y, { steps: 8 });
    await c.page.mouse.up();
    await sleep(400);
    // ② 朝向轮盘应当出现 → 拖过死区提交朝向（RIGHT）
    const wheel = await c.page.evaluate(() => {
      const w = document.querySelector('.fwheel');
      return w ? true : null;
    });
    log('WHEEL:', wheel);
    if (!wheel) FAIL.push('拖到战场格后朝向轮盘没有出现（拖拽被死锁成点击 / 或 pieceDrop 被拒）');
    else await c.swipe('RIGHT');
    await sleep(1500);
  }

  const rec = await c.page.evaluate(() => {
    const sp = globalThis.__SP__;
    const priv = sp.store.get().match.private || {};
    return {
      events: window.__dragRec.events,
      reqs: window.__dragRec.reqs,
      toasts: [...document.querySelectorAll('.toast-host .toast__text')].map((n) => n.textContent.trim()),
      board: (priv.board || []).filter((p) => p && p.kind === 'chess').map((p) => ({ id: p.id, row: p.row, col: p.col })),
      hand: (priv.hand || []).filter((p) => p && p.kind === 'chess').length,
    };
  });
  log('RESULT:', JSON.stringify(rec));
  const names = rec.events.map((e) => e.n);
  if (!names.includes('pieceDragStart')) FAIL.push('整备区干员拖不起来（pieceDragStart 没触发——pressed→dragging 死锁？）');
  if (!names.includes('pieceDrop')) FAIL.push('拖到战场格没有落下（pieceDrop 没触发）');
  if (!rec.reqs.length) FAIL.push('没有发出 g.move（朝向轮盘没提交 / 链路中断）');
  else {
    const mv = rec.reqs[0].p;
    if (!mv || mv.to?.area !== 'board' || !Number.isInteger(mv.to?.row)) FAIL.push(`g.move 目标不是战场格：${JSON.stringify(mv)}`);
    if (!mv?.dir) FAIL.push('g.move 没带朝向 dir');
  }
  if (pos.target && !rec.board.some((b) => b.row === pos.target.row && b.col === pos.target.col)) {
    FAIL.push(`干员没有落到目标格（${pos.target.row},${pos.target.col}）：board=${JSON.stringify(rec.board)}`);
  }
  if (rec.toasts.length) FAIL.push(`出现报错 toast：${JSON.stringify(rec.toasts)}`);
  await c.shot('jar-drag-deploy');
} catch (e) {
  log('ERROR:', (e && e.message) || e);
  FAIL.push(String((e && e.message) || e));
} finally {
  if (FAIL.length) { log('FAILED EXPECTATIONS:', JSON.stringify(FAIL, null, 1)); process.exitCode = 1; }
  else log('ALL EXPECTATIONS MET');
  await c.close();
  await srv.stop();
}
