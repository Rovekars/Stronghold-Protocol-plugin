// 定向探针（用户报告 2026-10-16）：jar 战斗中拖装备落点被拒 / 替换对话框取消后，装备视图应自动回到待部署区。
// 复现机制（app.js dropDragVisual）：落点是 board/hand 格时视图被乐观补间到目标格并挂进 pending 等服务端确认；
// pending 超时「送回原槽」的清理原本只在 mode==='prep' 跑——jar 战斗是 battle 模式，被拒 / 取消（无 intent、
// priv 不变）时视图永远停在战场。修复 = jarMode 下战斗帧循环同样跑 expireDropPending。
// 确定性断言：拖任意非 MAGIC 手牌道具到「空合法格」（必被拒，toast「请将装备拖拽至干员身上」）→ 3s 后视图应回整备区。
// 对话框路径（干员 2/2 后拖到干员身上再取消）走同一 pending 机制，作为尽力补充验证。
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

  let viewReady = false;
  for (let i = 0; i < 60; i++) {
    viewReady = await c.page.evaluate(() => !!globalThis.__SP_VIEW__?.raw?.tileScreen);
    if (viewReady) break;
    await sleep2(500);
  }
  log('view ready:', viewReady);
  if (!viewReady) FAIL.push('战斗视图未 ready');

  // ① 砸罐直到手牌有干员 → 部署到合法格
  const dep = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const { store, data, net } = globalThis.__SP__;
    const st = () => store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    for (let i = 0; i < 15; i++) {
      const js = jars();
      if (!js.length) break;
      try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ }
      await sleepL(700);
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
        free.sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
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

  // ② 尽力把干员穿满 2 件（升级调度中心拓宽道具池；被拒 / 同 id 合成的干扰跳过）——用于对话框路径
  const equipRes = await c.page.evaluate(async (opUid) => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const { store, data, net } = globalThis.__SP__;
    const st = () => store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    const itemsOn = (uid) => (((st().match.private.board || []).find((p) => p && p.uid === opUid) || {}).items || []);
    const handItems = () => (st().match.private.hand || []).filter((p) => p && p.kind === 'item');
    const usable = () => handItems().filter((p) => {
      const rec = data.lookup('items', p.id);
      return rec && rec.itemType === 'EQUIP' && !(typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip'));
    });
    for (let i = 0; i < 6; i++) { try { await net.request('g.levelUp', {}); } catch { /* ignore */ } await sleepL(250); }
    const done = [];
    const deadIds = [];
    for (let i = 0; i < 80 && done.length < 2; i++) {
      const us = usable().filter((p) => !done.includes(p.uid) && !deadIds.includes(p.id)
        && !done.some((u) => ((st().match.private.hand || []).find((x) => x && x.uid === u) || {}).id === p.id));
      if (us.length) {
        const res = await net.request('g.jarEquip', { itemUid: us[0].uid, targetUid: opUid }).catch(() => null);
        await sleepL(400);
        if (itemsOn(opUid).includes(us[0].uid)) done.push(us[0].uid);
        else deadIds.push(us[0].id);
        continue;
      }
      const js = jars();
      if (!js.length) break;
      try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ }
      await sleepL(700);
    }
    return { done, count: itemsOn(opUid).length };
  }, dep.uid);
  log('equip full attempt:', JSON.stringify(equipRes));

  // ③ 找一个空合法格（确定性被拒落点）+ 任意非 MAGIC 手牌道具
  const setup = await c.page.evaluate(() => {
    const { store, data } = globalThis.__SP__;
    const st = store.get();
    const priv = st.match.private;
    const sdata = data.lookup('stages', st.match.public.stageId);
    const dt = sdata && sdata.deployTiles && sdata.deployTiles.normal;
    const used = new Set(priv.board.map((p) => `${p.row},${p.col}`));
    const tiles = [...(dt ? dt.melee : []), ...(dt ? dt.rangedOnly : [])].filter(([r, cc]) => !used.has(`${r},${cc}`));
    // 最靠左上（远离门口的敌人），离整备区远一点无所谓
    tiles.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const emptyTile = tiles[0] || null;
    const raw = globalThis.__SP_VIEW__ && globalThis.__SP_VIEW__.raw;
    const tp = emptyTile && raw && typeof raw.tileScreen === 'function' ? raw.tileScreen(emptyTile[0], emptyTile[1]) : null;
    const item = (priv.hand || []).find((p) => p && p.kind === 'item') ||
      (priv.temp || []).find((p) => p && p.kind === 'item') || null;
    let itemRec = null;
    if (item) itemRec = data.lookup('items', item.id);
    return {
      emptyTile, tilePt: tp ? { x: tp.x, y: tp.y } : null,
      item: item ? { uid: item.uid, id: item.id, magic: !!(itemRec && itemRec.itemType === 'MAGIC') } : null,
      handHasItem: !!(priv.hand || []).some((p) => p && p.kind === 'item'),
    };
  });
  log('setup:', JSON.stringify(setup));
  if (!setup.item) FAIL.push('手牌 / 临时区没有道具可拖');
  if (!setup.tilePt) FAIL.push('拿不到空格屏幕坐标');

  // ④ 真实拖拽：道具 → 空合法格（必被拒：toast「请将装备拖拽至干员身上」）
  await c.hookRequests();
  if (setup.item && !setup.item.magic && setup.tilePt) {
    const from0 = await c.piecePoint(setup.item.uid, 0.6);
    log('drag from', JSON.stringify(from0), 'to empty tile', JSON.stringify(setup.tilePt));
    for (const [dx, dy] of [[0, 0], [-0.25, 0], [0.25, 0]]) {
      const from = await c.piecePoint(setup.item.uid, 0.6);
      if (!from) break;
      await c.drag({ x: from.x + dx * 40, y: from.y + dy * 40 }, setup.tilePt);
      await sleep2(700);
      const toasts = await c.toasts();
      if (toasts.some((t) => t.includes('请将装备拖拽至干员身上'))) { log('refused-drop toast fired'); break; }
    }
  }

  // ⑤ 对话框路径（尽力）：若干员已 2/2 且手牌还有 EQUIP，拖到干员身上 → 取消
  let dialogCancelled = false;
  if (equipRes.count >= 2) {
    const t2 = await c.page.evaluate(() => {
      const priv = globalThis.__SP__.store.get().match.private;
      const it = (priv.hand || []).find((p) => p && p.kind === 'item') || null;
      return it ? { uid: it.uid, id: it.id } : null;
    });
    if (t2) {
      const to = await c.piecePoint(dep.uid, 0.5);
      const from = await c.piecePoint(t2.uid, 0.6);
      if (to && from) {
        await c.drag(from, to);
        await sleep2(900);
        if (await c.page.evaluate(() => !!document.querySelector('.eqr'))) {
          log('replace dialog open → cancel');
          await c.shot('equip-dialog');
          await c.click('.eqr__cancel');
          dialogCancelled = true;
          await sleep2(600);
        } else {
          log('no dialog on operator drop (operator may have moved)');
        }
      }
    }
  }

  // ⑥ 归位断言：等 pending 超时（1300ms）+ 补间，道具视图应回到整备区（远离战场落点）
  await sleep2(3000);
  await c.shot('after-return');
  const check = await c.page.evaluate((itemUid) => {
    const priv = globalThis.__SP__.store.get().match.private;
    const still = [...(priv.hand || []), ...(priv.temp || [])].some((p) => p && p.uid === itemUid);
    const raw = globalThis.__SP_VIEW__ && globalThis.__SP_VIEW__.raw;
    const v = raw && typeof globalThis.__SP_VIEW__.pieceScreenRect === 'function' ? globalThis.__SP_VIEW__.pieceScreenRect(itemUid) : null;
    const bench = raw && typeof raw.tileScreen === 'function' && globalThis.__SP_GEO__ ? raw.tileScreen(globalThis.__SP_GEO__.HAND_ROW, 0) : null;
    return { still, pos: v ? { x: v.left + v.width / 2, y: v.top + v.height * 0.6 } : null, benchY: bench ? bench.y : null };
  }, setup.item ? setup.item.uid : -1);
  log('check:', JSON.stringify(check), 'dialogCancelled:', dialogCancelled);
  if (setup.item) {
    if (!check.still) FAIL.push(`道具（uid=${setup.item.uid}）不在 hand/temp —— 服务端把它弄丢了`);
    if (check.pos && Number.isFinite(check.benchY)) {
      const nearBench = Math.abs(check.pos.y - check.benchY) < 120;
      log(`item view near bench row (benchY=${Math.round(check.benchY)}, itemY=${Math.round(check.pos.y)}):`, nearBench);
      if (!nearBench) FAIL.push(`装备视图仍停留在战场（y=${Math.round(check.pos.y)}，整备区 y=${Math.round(check.benchY)}）——卡场 bug 未修复`);
    } else {
      log('拿不到归位判定坐标（跳过视图断言）');
    }
  }
  log('requests:', JSON.stringify(await c.requests()));
} catch (e) {
  FAIL.push('exception: ' + (e && e.message));
  console.error(e);
} finally {
  try { await c.shot('final'); } catch { /* ignore */ }
  try { if (srv && typeof srv.stop === 'function') await srv.stop({ hard: true }); else if (srv && typeof srv.close === 'function') await srv.close(); } catch { /* ignore */ }
}

if (FAIL.length) { console.error('FAIL:\n- ' + FAIL.join('\n- ')); process.exit(1); }
console.log('PROBE OK');
