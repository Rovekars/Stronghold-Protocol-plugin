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
  // jar 存档选择页：出现就点「新开一局（不读档）」
  try {
    await c.page.waitForSelector('.jar-sv-modal', { timeout: 5000 });
    await c.click('.jar-sv-modal button', '新开一局');
    log('存档页 → 新开一局');
  } catch { log('没有存档页（直接开局）'); }
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

  // ---- 多干员场景：布置 4 个干员，等它们被击倒，逐个点选 -------------------------------------------
  const deployed = [];
  for (let i = 0; i < 40 && deployed.length < 4; i++) {
    const got = await c.page.evaluate(async () => {
      const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
      const { store, data, net } = globalThis.__SP__;
      const st = () => store.get();
      const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
      const js = jars();
      if (!js.length) return { none: true };
      try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ }
      await sleepL(600);
      const hand = (st().match.private.hand || []).filter((p) => p && p.kind === 'chess');
      if (!hand.length) return { wait: true };
      const piece = hand[0];
      const sdata = data.lookup('stages', st().match.public.stageId);
      const rec = data.lookup('chess', piece.id);
      const dt = sdata && sdata.deployTiles && sdata.deployTiles.normal;
      if (!dt) return { err: 'no deployTiles' };
      const tiles = rec && rec.position === 'MELEE' ? dt.melee : [...(dt.rangedOnly || []), ...(dt.melee || [])];
      const used = new Set((st().match.private.board || []).map((p) => `${p.row},${p.col}`));
      const free = tiles.filter(([r, cc]) => !used.has(`${r},${cc}`));
      if (!free.length) return { wait: true };
      free.sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
      const [row, col] = free[0];
      const res = await net.request('g.move', { uid: piece.uid, to: { area: 'board', row, col }, dir: 'LEFT' }).catch((e) => ({ err: String(e) }));
      return { row, col, uid: piece.uid, id: piece.id, res };
    });
    if (got && got.uid != null && !(got.res && (got.res.err || got.res.ok === false))) { deployed.push(got); log('deployed', JSON.stringify(got)); }
  }
  log('deployed count:', deployed.length);

  // 砸光剩下的罐，敌人进场
  const rest = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    let n = 0;
    for (let i = 0; i < 60; i++) {
      const js = ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
      if (!js.length) break;
      try { await net.request('g.smashJar', { jarId: js[0].id }); n++; } catch { /* ignore */ }
      await sleepL(300);
    }
    return n;
  });
  log('rest jars smashed:', rest);

  // 时间线：每 500ms 记录一次 round/phase/boardUids/handUids/tempUids/downUids，捕获棋子消失的那一刻
  let prev = null;
  const timeline = [];
  for (let i = 0; i < 480; i++) {
    const snap = await c.page.evaluate(() => {
      const r = globalThis.__SP_RUNNER__;
      const st = globalThis.__SP__.store.get();
      const priv = st.match.private || {};
      const fid = (st.match.field || {}).fieldId || (st.match.battle || {}).fieldId || null;
      const down = (globalThis.__PROBE__.down || []).map((d) => {
        let uid = null; try { uid = r.unitUidOf(d[0], fid); } catch { /* ignore */ }
        return { unitId: d[0], uid, row: d[4], col: d[5] };
      });
      const toasts = [...document.querySelectorAll('.toast, .toasts > *, [class*="toast"]')].map((n) => (n.textContent || '').slice(0, 60));
      return {
        t: Date.now(), round: st.match.public.round, phase: st.match.public.phase, toasts,
        board: (priv.board || []).map((p) => p && p.uid).filter((x) => x != null),
        hand: (priv.hand || []).map((p) => p && p.uid).filter((x) => x != null),
        temp: (priv.temp || []).map((p) => p && p.uid).filter((x) => x != null),
        down,
      };
    });
    const key = JSON.stringify([snap.round, snap.phase, snap.board, snap.hand, snap.temp, snap.down.map((d) => d.uid)]);
    if (key !== prev) {
      prev = key; timeline.push(snap);
      log('T', snap.round, snap.phase, 'board=' + JSON.stringify(snap.board), 'hand=' + JSON.stringify(snap.hand), 'temp=' + JSON.stringify(snap.temp), 'down=' + JSON.stringify(snap.down), 'toast=' + JSON.stringify(snap.toasts));
    }
    if (snap.down.length >= 2 && snap.board.length) {
      // 至少两个倒地：停下来做点选检查
      const last = timeline[timeline.length - 1];
      if (last.down.length >= 2 && (snap.t - (last.t || 0) > 0)) { /* continue a bit */ }
    }
    if (timeline.length > 40) break;
    await sleep2(120);
  }

  // ---- 素材（装备）链路：给场上干员穿装备 → 等它被击倒 → 撤离 → 比对装备 -------------------------
  // 1) 砸罐拿到一件道具（item），战斗中穿到某个已部署干员身上
  const equipInfo = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const { store, net } = globalThis.__SP__;
    const st = () => store.get();
    for (let i = 0; i < 40; i++) {
      const priv = st().match.private || {};
      const board = (priv.board || []).filter((p) => p && p.kind === 'chess');
      const item = (priv.hand || []).find((p) => p && p.kind === 'item');
      if (item && board.length) {
        const res = await net.request('g.jarEquip', { itemUid: item.uid, targetUid: board[0].uid }).catch((e) => ({ err: String(e) }));
        return { targetUid: board[0].uid, itemId: item.id, res };
      }
      const jars = ((priv).jars || []).filter((j) => j && !j.smashed);
      if (!jars.length) break;
      await net.request('g.smashJar', { jarId: jars[0].id }).catch(() => null);
      await sleepL(600);
    }
    return { err: '没有拿到道具 / 没有场上干员' };
  });
  log('equip:', JSON.stringify(equipInfo));

  if (equipInfo.targetUid != null) {
    // 2) 等这个干员被击倒
    let d = null;
    for (let i = 0; i < 240; i++) {
      d = await c.page.evaluate((uid) => {
        const r = globalThis.__SP_RUNNER__;
        const st = globalThis.__SP__.store.get();
        const fid = (st.match.field || {}).fieldId || (st.match.battle || {}).fieldId || null;
        const raw = (globalThis.__PROBE__.down || []).map((e) => {
          let uid2 = null; try { uid2 = r.unitUidOf(e[0], fid); } catch { /* ignore */ }
          return { unitId: e[0], uid: uid2, row: e[4], col: e[5] };
        });
        return raw.find((x) => x.uid === uid) || null;
      }, equipInfo.targetUid);
      if (d) break;
      await sleep2(500);
    }
    log('down of equipped op:', JSON.stringify(d));
    if (d) {
      const before = await c.page.evaluate((uid) => {
        const priv = globalThis.__SP__.store.get().match.private || {};
        const all = [...(priv.board || []), ...(priv.hand || []), ...(priv.temp || [])].filter(Boolean);
        const p = all.find((x) => x.uid === uid) || null;
        return p ? { uid: p.uid, id: p.id, items: (p.items || []).map((i) => i.id) } : null;
      }, d.uid);
      log('before retreat:', JSON.stringify(before));
      const pt = d.row != null ? await c.tilePoint(d.row, d.col) : null;
      if (pt) {
        for (const [dx, dy] of [[0, 0], [-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25]]) {
          await c.page.mouse.click(pt.x + dx * 14, pt.y + dy * 14);
          await sleep2(240);
          if (await c.page.evaluate(() => !!document.querySelector('[data-test="jar-field-retreat"]'))) break;
        }
        await c.page.evaluate(() => document.querySelector('[data-test="jar-field-retreat"]')?.click());
        await sleep2(900);
      }
      const after = await c.page.evaluate((uid) => {
        const priv = globalThis.__SP__.store.get().match.private || {};
        const inHand = (priv.hand || []).find((p) => p && p.uid === uid) || null;
        const inTemp = (priv.temp || []).find((p) => p && p.uid === uid) || null;
        const p = inHand || inTemp;
        const loose = [...(priv.hand || []), ...(priv.temp || [])].filter((x) => x && x.kind === 'item').map((x) => x.id);
        return { area: inHand ? 'hand' : inTemp ? 'temp' : 'none', piece: p ? { uid: p.uid, id: p.id, items: (p.items || []).map((i) => i.id) } : null, looseItems: loose };
      }, d.uid);
      log('after retreat:', JSON.stringify(after));
    }
  }
  log('multi done');
} catch (e) {
  console.log('[multi2] error', e && e.message);
} finally {
  try { await c.close(); } catch { /* ignore */ }
  try { await srv.stop({ hard: true }); } catch { /* ignore */ }
}
