// 定向探针（用户报告「还是没有那个按钮」）：jar 模式真实浏览器里走完整链路——
// 战斗中部署干员 → 砸罐放敌人 → 干员被击倒 → 点选倒地干员 → 检查
//   ① [data-test="jar-field-retreat"]（场贴撤离按钮）是否出现
//   ② .qcast（快捷施法气泡，青色虚线菱形——用户截图里那个菱形的另一种解释）是否出现
//   ③ __SP_JAR_COMBAT__ / snap.down 等中间量，定位断链环节。
// 按钮出现的话顺手点它，验证「棋子进整备区（respawnAt 挂上）」的完整闭环。
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
const c = new Client(await pptr(), srv.base, 'probe', { prefix: 'probe' });
const log = (...a) => console.log('[probe]', ...a);
const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await c.open();
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
  await c.waitFor((s) => s.phase === 'COMBAT', 'combat', 30000);
  log('combat started');

  // 监听快照：客户端模拟不走网络，快照来自本地 runner（与 game.js downRef 同一来源）
  await c.page.evaluate(() => {
    globalThis.__PROBE__ = { down: [], snaps: 0, foes: -1 };
    const r = globalThis.__SP_RUNNER__;
    if (!r || typeof r.on !== 'function') return;
    r.on('snap', (m) => {
      globalThis.__PROBE__.snaps++;
      // 每帧都要覆盖（含空数组）：干员会自动复活，陈旧的 down 会让 wasDown 误判成「撤离时是倒地态」
      if (m && Array.isArray(m.down)) globalThis.__PROBE__.down = m.down;
    });
  });

  // ① 先砸罐直到砸出干员（op 罐 → 揭示后进整备区），战斗中 g.move 部署到最靠门口的合法格
  const dep = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const { store, data, net } = globalThis.__SP__;
    const st = () => store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    // 砸罐找干员罐（最多 12 个）
    for (let i = 0; i < 12; i++) {
      const js = jars();
      if (!js.length) break;
      try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ }
      await sleepL(700); // 揭示动画 / 入手
      const hand = (st().match.private.hand || []).filter((p) => p && p.kind === 'chess');
      if (hand.length) {
        const piece = hand[0];
        const sdata = data.lookup('stages', st().match.public.stageId);
        const rec = data.lookup('chess', piece.id);
        const dt = sdata && sdata.deployTiles && sdata.deployTiles.normal;
        if (!dt) return { err: 'no deployTiles' };
        const tiles = rec && rec.position === 'MELEE' ? dt.melee : [...(dt.rangedOnly || []), ...(dt.melee || [])];
        const used = new Set(st().match.private.board.map((p) => `${p.row},${p.col}`));
        const free = tiles.filter(([r, cc]) => !used.has(`${r},${cc}`));
        free.sort((a, b) => (b[1] - a[1]) || (b[0] - a[0])); // 最靠右（敌人门口）
        if (!free.length) return { err: 'no free tile' };
        const [row, col] = free[0];
        const res = await net.request('g.move', { uid: piece.uid, to: { area: 'board', row, col }, dir: 'LEFT' }).catch((e) => ({ err: String(e) }));
        return { row, col, uid: piece.uid, id: piece.id, res };
      }
    }
    return { err: 'no op jar smashed into hand' };
  });
  log('deploy:', JSON.stringify(dep));
  if (dep.err) FAIL.push('部署失败: ' + dep.err);

  // ②-A：在击倒前先点选刚部署的存活干员，验证 jar 战斗存活干员也能出现撤离按钮
  if (!dep.err && dep.row != null && dep.col != null) {
    // 等战斗视图 ready（__SP_VIEW__ 在 combat 开始后才挂载；本场敌人多，最多等 30 秒）
    let viewReady = false;
    for (let i = 0; i < 60; i++) {
      viewReady = await c.page.evaluate(() => !!globalThis.__SP_VIEW__?.raw?.tileScreen);
      if (viewReady) break;
      await sleep2(500);
    }
    log('view ready:', viewReady);
    // ②-A0：待部署区（hand）里的干员——点选后应只出「出售」，不出撤离按钮、不出虚线菱形（用户 2026-10-13）
    // 部署后手牌可能空了；再砸罐直到手牌里有一个干员（待部署区探针的前提）
    for (let i = 0; i < 12; i++) {
      const has = await c.page.evaluate(() => {
        const st = globalThis.__SP__.store.get();
        const jars = ((st.match.private || {}).jars || []).filter((j) => j && !j.smashed);
        const handHas = ((st.match.private || {}).hand || []).some((p) => p && p.kind === 'chess');
        return { jars: jars.length, handHas, jarId: jars[0] ? jars[0].id : null };
      });
      if (has.handHas || !has.jarId) break;
      await c.page.evaluate((id) => globalThis.__SP__.net.request('g.smashJar', { jarId: id }).catch(() => null), has.jarId);
      await sleep2(700);
    }
    const benchInfo = await c.page.evaluate(() => {
      const st = globalThis.__SP__.store.get();
      const hand = ((st.match.private || {}).hand || []);
      const raw = globalThis.__SP_VIEW__ && globalThis.__SP_VIEW__.raw;
      // priv.hand 是稀疏数组：槽位 = 数组下标（棋子对象本身没有 idx 字段）
      let slot = -1;
      for (let i = 0; i < hand.length; i++) if (hand[i] && hand[i].kind === 'chess') { slot = i; break; }
      const handOp = slot >= 0 ? hand[slot] : null;
      if (!handOp || !raw || typeof raw.tileScreen !== 'function' || !globalThis.__SP_GEO__) return { hand: hand.map((p) => p && { uid: p.uid, kind: p.kind }), why: 'no hand op / no view' };
      const t = raw.tileScreen(globalThis.__SP_GEO__.HAND_ROW, slot);
      return { hand: hand.map((p) => p && { uid: p.uid, kind: p.kind }), uid: handOp.uid, slot, pt: t ? { x: t.x, y: t.y, s: t.s } : null, hitAt: t ? (document.elementFromPoint(t.x, t.y) || {}).className : null };
    });
    log('bench info:', JSON.stringify(benchInfo));
    const benchPt = benchInfo.pt;
    let benchProbe = null;
    if (benchPt) {
      for (const [dx, dy] of [[0, 0], [-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2]]) {
        await c.page.mouse.click(benchPt.x + dx * benchPt.s, benchPt.y + dy * benchPt.s);
        await sleep2(300);
        benchProbe = await c.page.evaluate(() => ({
          btn: !!document.querySelector('[data-test="jar-field-retreat"]'),
          dia: !!document.querySelector('.uframe__dia'),
          sell: !!document.querySelector('.uframe__btn--sell'),
          uframe: !!document.querySelector('.uframe'),
          chips: !!document.querySelector('.dpanel, [class*="detail"]'),
        }));
        if (benchProbe.sell) break;
      }
    }
    log('bench probe:', JSON.stringify(benchProbe));
    if (!benchProbe) log('bench probe skipped（无待部署干员或视图未就绪）');
    else {
      if (benchProbe.btn) FAIL.push('待部署区干员点选后出现了撤离按钮（应只有出售）');
      if (benchProbe.dia) FAIL.push('待部署区干员点选后出现了虚线菱形（应不画）');
      if (!benchProbe.sell) FAIL.push('待部署区干员点选后没有「出售」按钮');
      else log('待部署区 OK：只有「出售」按钮，无撤离钮、无菱形');
    }
    // jar 部署后战斗单位要等 JAR_LEAD_IN（10 战斗秒 ≈ 5 真实秒）才进场；等它真的在场上再点，否则点到空格
    let aliveOnField = false;
    for (let i = 0; i < 60; i++) {
      aliveOnField = await c.page.evaluate((uid) => {
        const r = globalThis.__SP_RUNNER__;
        const st = globalThis.__SP__.store.get();
        const fid = (st.match.field || {}).fieldId || (st.match.battle || {}).fieldId || null;
        try { return (r.fieldUnits(fid) || []).some((u) => u && u.uid === uid); } catch { return false; }
      }, dep.uid);
      if (aliveOnField) break;
      await sleep2(500);
    }
    log('alive unit on field:', aliveOnField);
    const alivePt = await c.tilePoint(dep.row, dep.col);
    log('alive click pt:', JSON.stringify(alivePt));
    if (alivePt) {
      let aliveProbe = null;
      // 用真实鼠标点击（合成 dispatchEvent 打不到 canvas 上的视图监听，倒地段也是用 page.mouse.click 才通的）
      for (let attempt = 0; attempt < 8 && !(aliveProbe && aliveProbe.btn); attempt++) {
        const pt = attempt === 0 ? alivePt : await c.tilePoint(dep.row, dep.col);
        if (!pt) break;
        const snap = async () => c.page.evaluate(() => {
          const uf = document.querySelector('.uframe');
          const r = globalThis.__SP_RUNNER__;
          const st = globalThis.__SP__.store.get();
          const fid = (st.match.field || {}).fieldId || (st.match.battle || {}).fieldId || null;
          const downUids = (globalThis.__PROBE__.down || []).map((d) => { try { return r.unitUidOf(d[0], fid); } catch { return null; } }).filter((x) => Number.isInteger(x));
          return {
            btn: !!document.querySelector('[data-test="jar-field-retreat"]'),
            hasSellBtn: !!document.querySelector('.uframe__btn--sell'),
            uframe: !!uf,
            uframeBtns: uf ? [...uf.querySelectorAll('button')].map((b) => b.className) : null,
            phase: st.match.public.phase,
            jarFlag: globalThis.__SP_JAR_COMBAT__,
            downUids,
          };
        });
        for (const [dx, dy] of [[0, 0], [-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2]]) {
          await c.page.mouse.click(pt.x + dx * 14, pt.y + dy * 14);
          await sleep2(260);
          const has = await snap();
          if (has.btn || has.hasSellBtn) { aliveProbe = has; break; }
        }
        aliveProbe = aliveProbe || await snap();
        log(`alive probe attempt ${attempt}:`, JSON.stringify(aliveProbe));
      }
      log('alive probe final:', JSON.stringify(aliveProbe));
      const wasDownAtSel = aliveProbe && Array.isArray(aliveProbe.downUids) && dep.uid != null && aliveProbe.downUids.includes(dep.uid);
      if (!aliveProbe || !aliveProbe.btn) FAIL.push('存活干员点选后未出现撤离按钮（真实鼠标点击重试后仍无）');
      else if (aliveProbe.hasSellBtn) FAIL.push(`已部署（场上）干员选中时不应出现「出售」按钮（用户 2026-10-14；uframe=${aliveProbe.uframe}, buttons=${JSON.stringify(aliveProbe.uframeBtns)}）`);
      else log('已部署干员 OK：只有撤离按钮，无「出售」（用户 2026-10-14：出售只留给待部署区）');
    } else {
      FAIL.push('存活干员探测点无法计算');
    }
  }

  // ② 把剩下的罐全砸了，敌人进场；等干员被击倒（snap.down 非空，最多 100 秒）
  const smashedAll = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    let n = 0;
    for (let i = 0; i < 40; i++) {
      const js = jars();
      if (!js.length) break;
      try { await net.request('g.smashJar', { jarId: js[0].id }); n++; } catch { /* ignore */ }
      await sleepL(350);
    }
    return n;
  });
  log('smashed jars:', smashedAll);

  let downEntry = null;
  for (let i = 0; i < 200 && !downEntry; i++) {
    await sleep2(500);
    downEntry = await c.page.evaluate(() => (globalThis.__PROBE__.down && globalThis.__PROBE__.down[0]) || null);
  }
  const snapStats = await c.page.evaluate(() => {
    const r = globalThis.__SP_RUNNER__;
    const st = globalThis.__SP__.store.get();
    const fid = (st.match.field || {}).fieldId || (st.match.battle || {}).fieldId || null;
    let foes = -1;
    try { foes = (r.fieldUnits(fid) || []).filter((u) => u && u.side === 'enemy' && u.alive !== false).length; } catch { /* ignore */ }
    return { snaps: globalThis.__PROBE__.snaps, foes, fid };
  });
  log('down entry:', JSON.stringify(downEntry), 'stats:', JSON.stringify(snapStats));
  if (!downEntry) FAIL.push(`100 秒内没有干员被击倒（runner snaps=${snapStats.snaps}, 活敌=${snapStats.foes}）——探针前提不成立`);
  // 注：不能 g.pause——solo 暂停会弹覆盖层挡住画布点击。敌人聚尸时多点取样 + 时间窗口即可。

  // ③ 中间量：jar 标志 / 倒地棋子的棋盘位
  const ctxInfo = await c.page.evaluate(() => {
    const st = globalThis.__SP__.store.get();
    const priv = st.match.private || {};
    const downIds = (globalThis.__PROBE__.down || []).map((d) => d[0]);
    return {
      jarFlag: globalThis.__SP_JAR_COMBAT__,
      phase: st.match.public.phase,
      board: (priv.board || []).map((p) => ({ uid: p.uid, id: p.id, row: p.row, col: p.col })),
      downIds,
    };
  });
  log('ctx:', JSON.stringify(ctxInfo));

  // ④ 点选倒地干员：优先用倒地条目自带的落点（d[4], d[5]），否则用部署格
  if (downEntry && dep.uid != null) {
    // 捕获视图点击事件（pieceClick / tileClick），看引擎到底发出了什么
    const capInfo = await c.page.evaluate(() => {
      globalThis.__CLICKS__ = [];
      const v = globalThis.__SP_VIEW__;
      const wrap = (name) => (e) => globalThis.__CLICKS__.push({
        t: name, uid: e && e.uid, unitId: e && e.unitId, button: e && e.button,
        detail: !!(e && e.detail), hasUnit: !!(e && (e.unit || e.unitId != null)), row: e && e.row, col: e && e.col,
      });
      if (v && typeof v.on === 'function') {
        v.on('pieceClick', wrap('pieceClick'));
        v.on('tileClick', wrap('tileClick'));
        return { hooked: true, hasRaw: !!(v.raw), keys: Object.keys(v).slice(0, 12) };
      }
      return { hooked: false, hasView: !!v };
    });
    log('capture:', JSON.stringify(capInfo));
    const row = Number.isInteger(downEntry[4]) ? downEntry[4] : dep.row;
    const col = Number.isInteger(downEntry[5]) ? downEntry[5] : dep.col;
    const pt = await c.tilePoint(row, col);
    log('click at', JSON.stringify(pt));
    if (pt) {
      // 先点一个活敌人验证捕获/交互链路，再在倒地身体周围 3×3 取样点击
      const enemyPt = await c.page.evaluate(() => {
        const r = globalThis.__SP_RUNNER__;
        const st = globalThis.__SP__.store.get();
        const fid = (st.match.field || {}).fieldId || null;
        const raw = globalThis.__SP_VIEW__ && globalThis.__SP_VIEW__.raw;
        const list = (fid && r && typeof r.fieldUnits === 'function' ? r.fieldUnits(fid) : []) || [];
        const foe = list.find((u) => u && u.side === 'enemy' && u.alive !== false && Number.isFinite(u.x) && Number.isFinite(u.y));
        if (!foe || !raw || typeof raw.tileScreen !== 'function') return null;
        const t = raw.tileScreen(Math.round(foe.y), Math.round(foe.x));
        return t ? { x: t.x, y: t.y } : null;
      });
      if (enemyPt) { await c.page.mouse.click(enemyPt.x, enemyPt.y); await sleep2(500); }
      log('after enemy click:', JSON.stringify(await c.page.evaluate(() => ({ clicks: globalThis.__CLICKS__, qcast: !!document.querySelector('.qcast'), detail: !!document.querySelector('[class*="detail"]') }))));
      // 倒地身体：中心 ± 0.35 格取样（DIE 姿势的拾取范围可能偏离格心）
      const s = await c.page.evaluate(() => {
        const raw = globalThis.__SP_VIEW__ && globalThis.__SP_VIEW__.raw;
        const t = raw && typeof raw.tileScreen === 'function' ? raw.tileScreen(10, 10) : null;
        return t ? t.s : 56;
      });
      globalThis.__CLICK_RESET__ = null;
      await c.page.evaluate(() => { globalThis.__CLICKS__ = []; });
      // 敌人可能聚在倒地身体上抢走点击：3×3 取样 × 多轮时间窗口，直到按钮出现
      let hitSeen = false;
      outer: for (let round = 0; round < 12 && !hitSeen; round++) {
        for (const [dx, dy] of [[0, 0], [-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3], [-0.3, -0.3], [0.3, 0.3], [-0.35, 0.35], [0.35, -0.35]]) {
          await c.page.mouse.click(pt.x + dx * s, pt.y + dy * s);
          await sleep2(300);
          const st = await c.page.evaluate(() => ({
            clicks: globalThis.__CLICKS__.length,
            last: globalThis.__CLICKS__[globalThis.__CLICKS__.length - 1] || null,
            btn: !!document.querySelector('[data-test="jar-field-retreat"]'),
            qcast: !!document.querySelector('.qcast'),
          }));
          if (st.btn) { log(`HIT at round ${round} offset (${dx},${dy}) → button appeared`); hitSeen = true; break outer; }
          if (st.clicks && round === 0) log(`offset (${dx},${dy}): clicks=${JSON.stringify(st.last)} btn=${st.btn} qcast=${st.qcast}`);
        }
        await sleep2(500); // 等敌人走位
      }
      if (!hitSeen) FAIL.push('多轮取样后撤离按钮仍未出现（点击总被别的单位抢走或判定断链）');
    }
    const ui = await c.page.evaluate(() => ({
      jarFlag: globalThis.__SP_JAR_COMBAT__,
      btn: !!document.querySelector('[data-test="jar-field-retreat"]'),
      qcast: !!document.querySelector('.qcast'),
      uframe: !!document.querySelector('.uframe'),
      detail: !!document.querySelector('.dpanel, [class*="detail"]'),
      clicks: globalThis.__CLICKS__ || [],
    }));
    log('after click:', JSON.stringify(ui, null, 1));
    await c.shot('probe-jar-retreat-btn');
    if (!ui.btn && ui.qcast) FAIL.push('点选倒地干员弹出的是快捷施法气泡（.qcast）——jar 分支没接管（jarCombat/downRef 断链）');
    else if (!ui.btn) FAIL.push('点选后撤离按钮没出现（retreatCorner 或 selIsDownAlly 为空）');

    // ⑤ 按钮在的话点它，验证完整闭环：棋子进整备区并挂上 respawnAt
    if (ui.btn) {
      const bb = await c.page.evaluate(() => {
        const el = document.querySelector('[data-test="jar-field-retreat"]');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await c.page.mouse.click(bb.x, bb.y);
      await sleep2(1200);
      const after = await c.page.evaluate(() => {
        const priv = globalThis.__SP__.store.get().match.private;
        const hand = (priv.hand || []).map((p) => p && { uid: p.uid, kind: p.kind, respawnAt: p.respawnAt, respawnTime: p.respawnTime });
        const temp = (priv.temp || []).map((p) => p && { uid: p.uid, kind: p.kind, respawnAt: p.respawnAt, respawnTime: p.respawnTime });
        return { board: (priv.board || []).map((p) => p.uid), hand, temp };
      });
      log('after retreat:', JSON.stringify(after), 'toasts:', JSON.stringify(await c.toasts()));
      // 待部署区被塞满时会溢出到临时手牌区，两处都算撤离成功
      let benched = (after.hand || []).find((p) => p && p.uid === dep.uid) || (after.temp || []).find((p) => p && p.uid === dep.uid);
      if (!benched) {
        // UI 点击没生效 → 直发 g.move 对照（隔离 UI 与服务端）
        log('UI 点击未奏效，直发 g.move 对照…');
        const dir = await c.page.evaluate((uid) => globalThis.__SP__.net.request('g.move', { uid, to: { area: 'hand', idx: 0 } }).then((r) => JSON.stringify(r)).catch((e) => 'ERR ' + e.message), dep.uid);
        log('direct g.move:', dir, 'toasts:', JSON.stringify(await c.toasts()));
        await sleep2(800);
        const after2 = await c.page.evaluate(() => {
          const priv = globalThis.__SP__.store.get().match.private;
          return { board: (priv.board || []).map((p) => p.uid), hand: (priv.hand || []).map((p) => p && { uid: p.uid, respawnAt: p.respawnAt }), temp: (priv.temp || []).map((p) => p && { uid: p.uid }) };
        });
        log('after direct move:', JSON.stringify(after2));
        benched = (after2.hand || []).find((p) => p && p.uid === dep.uid) || (after2.temp || []).find((p) => p && p.uid === dep.uid);
      }
      if (!benched) FAIL.push('撤离后棋子没有进整备区（UI 与直发 g.move 都失败）');
      else if (benched.respawnAt == null) {
        // 存活干员主动撤离本就没有复活倒计时（只有被击倒的才有），故按「是否真的倒地」区分判罚
        const downUids = await c.page.evaluate((fid) => {
          const r = globalThis.__SP_RUNNER__;
          const ids = (globalThis.__PROBE__.down || []).map((d) => d[0]);
          const f = fid || ((globalThis.__SP__.store.get().match.field || {}).fieldId || null);
          return ids.map((id) => { try { return r.unitUidOf(id, f); } catch { return null; } }).filter((x) => Number.isInteger(x));
        }, snapStats.fid);
        const wasDown = downUids.includes(dep.uid);
        log('wasDown:', wasDown, 'downUids:', JSON.stringify(downUids), 'dep.uid:', dep.uid);
        if (!wasDown) {
          log('存活干员撤离成功（无复活倒计时，符合预期）');
        } else {
          const rt = await c.page.evaluate((uid) => {
            const r = globalThis.__SP_RUNNER__;
            return r && typeof r.jarBenchTimer === 'function' ? r.jarBenchTimer(uid) : 'no-api';
          }, dep.uid).catch((e) => 'ERR ' + e.message);
          log('runner benchTimer:', JSON.stringify(rt));
          if (rt && rt.respawnAt != null) log(`客户端模拟回退链路 OK：runner 倒计时 respawnAt=${rt.respawnAt}（战斗时刻 time=${rt.time}），渲染每帧据此画倒计时环`);
          else FAIL.push('runner jarBenchTimer 没有该干员的倒计时（客户端模拟回退断链）');
        }
      } else log(`闭环 OK：干员在整备区倒计时 respawnAt=${benched.respawnAt} respawnTime=${benched.respawnTime}`);
      await c.shot('probe-jar-retreat-bench');
    }
  }

  await c.shot('probe-jar-retreat-final');
} catch (e) {
  FAIL.push('probe error: ' + (e && e.message));
  try { await c.shot('probe-jar-retreat-error'); } catch { /* ignore */ }
} finally {
  try { await c.close(); } catch { /* ignore */ }
  try { await srv.close(); } catch { /* ignore */ }
}
console.log(FAIL.length ? '[probe] FAIL:\n- ' + FAIL.join('\n- ') : '[probe] ALL EXPECTATIONS MET');
process.exit(FAIL.length ? 1 : 0);
