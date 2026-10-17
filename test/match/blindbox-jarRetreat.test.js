// 盲盒·砸罐子（jar）：主动撤离（击倒 / 存活干员撤回待部署区）必须保住干员身上的装备（素材），
// 且再部署时装备一并带回战斗（用户 2026-10-16：部分击倒干员撤离回待部署区会丢失素材）。
// 口径：装备记在棋子 piece.items 上（服务端权威），撤离只是棋子从 board 回到 hand/temp —— 对象本身不动，
// items 必须原样保留；战斗中再部署时 jarUnitInput 把 items 一并交给 deployFromInput。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor, DATA } from './harness.js';
import { GEO } from '../../shared/constants.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};

/** 战斗中部署（走 MOD 的 ps.move 旁路 → 注入正在运行的战斗），返回该战斗里的单位 */
const deployInCombat = (m, ps, chessId) => {
  const piece = give(m, ps, chessId, 'hand');
  const at = legalTileFor(m, ps, chessId);
  assert.ok(at, `找不到 ${chessId} 的合法格`);
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: at[0], col: at[1] }, dir: 'LEFT' });
  assert.deepEqual(r, { ok: true }, `战斗中部署应成功（${JSON.stringify(r)}）`);
  const f = (m.fields || []).find((x) => x && x.battle && Array.isArray(x.players) && x.players.includes('p_0') && !x.done);
  assert.ok(f, '应存在 p_0 的战斗');
  const u = f.battle.allyUnits.find((x) => x && x.uid === piece.uid && !x.removed);
  assert.ok(u, '部署后战斗里应有该单位');
  return { piece, unit: u, field: f };
};

/** 让一个已部署干员倒地（击倒态：isDown，带再部署倒计时） */
const knockDown = (m, ps, u) => {
  const f = (m.fields || []).find((x) => x && x.battle && Array.isArray(x.battle.allyUnits) && x.battle.allyUnits.includes(u));
  assert.ok(f, '战斗里应有该单位');
  f.battle.retreat(u, { reason: 'killed' });
  assert.ok(f.battle.isDown(u), '干员应处于击倒态（isDown）');
  return f;
};

test('jar 撤离：击倒干员撤离回待部署区，装备（素材）不丢', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const c1 = chessOfTier(1)[0];
  const { piece, unit } = deployInCombat(m, ps, c1);
  // 战斗中穿装：装备从手牌挂到干员身上（piece.items）
  const it = giveItem(m, ps, Object.values(DATA.items).find((x) => x && x.visible !== false && !x.isGolden)?.id ?? null, 'hand');
  if (it) {
    const eq = m.handle('p_0', { t: 'g.jarEquip', itemUid: it.uid, targetUid: piece.uid });
    assert.deepEqual(eq, { ok: true }, `战斗中穿装应成功（${JSON.stringify(eq)}）`);
  }
  const before = (piece.items || []).map((x) => x.id);
  assert.ok(before.length >= 1, `干员身上应有装备（items=${JSON.stringify(before)}）`);

  knockDown(m, ps, unit);
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'hand', idx: 0 } });
  assert.deepEqual(r, { ok: true }, `击倒干员撤离应成功（${JSON.stringify(r)}）`);
  const back = ps.hand.find((p) => p && p.uid === piece.uid) || null;
  assert.ok(back, '撤离后干员应在待部署区');
  assert.deepEqual((back.items || []).map((x) => x.id), before, '装备（素材）必须原样保留');
  assert.equal(ps.board.has(`${unit.tileR},${unit.tileC}`), false);
  h.invariants();
});

test('jar 撤离：待部署区满时溢出到暂存区，装备同样不丢', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 9 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const c1 = chessOfTier(1)[0];
  const { piece, unit } = deployInCombat(m, ps, c1);
  const it = giveItem(m, ps, Object.values(DATA.items).find((x) => x && x.visible !== false && !x.isGolden)?.id ?? null, 'hand');
  if (it) assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: it.uid, targetUid: piece.uid }), { ok: true });
  const before = (piece.items || []).map((x) => x.id);
  assert.ok(before.length >= 1);
  // 填满常规手牌（互不相同的基础干员，避免立即合成）
  const fillers = [];
  for (const id of chessOfTier(1)) {
    if (fillers.some((f) => m.gd.baseIdOf(f) === m.gd.baseIdOf(id))) continue;
    fillers.push(id);
    if (fillers.length >= GEO.HAND_SIZE) break;
  }
  assert.ok(fillers.length >= GEO.HAND_SIZE);
  for (const id of fillers) ps.acquireChess(id, { fromPool: false, silent: true });
  assert.equal(ps.hand.filter(Boolean).length, GEO.HAND_SIZE, '手牌已满');
  knockDown(m, ps, unit);
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'temp', idx: 0 } });
  assert.deepEqual(r, { ok: true }, `手牌满时应溢出到暂存区（${JSON.stringify(r)}）`);
  const back = ps.temp.find((p) => p && p.uid === piece.uid) || null;
  assert.ok(back, '撤离后干员应在暂存区');
  assert.deepEqual((back.items || []).map((x) => x.id), before, '溢出到暂存区时装备同样不丢');
  h.invariants();
});

test('jar 撤离：存活干员撤回待部署区，装备不丢（且能带着装备再部署）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 13 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const c1 = chessOfTier(1)[0];
  const { piece } = deployInCombat(m, ps, c1);
  const it = giveItem(m, ps, Object.values(DATA.items).find((x) => x && x.visible !== false && !x.isGolden)?.id ?? null, 'hand');
  if (it) assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: it.uid, targetUid: piece.uid }), { ok: true });
  const before = (piece.items || []).map((x) => x.id);
  assert.ok(before.length >= 1);
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'hand', idx: 1 } });
  assert.deepEqual(r, { ok: true }, `存活干员撤离应成功（${JSON.stringify(r)}）`);
  const back = ps.hand[1];
  assert.ok(back && back.uid === piece.uid, '应在 hand 槽 1');
  assert.deepEqual((back.items || []).map((x) => x.id), before, '存活干员撤离装备不丢');
  // 再部署：装备随 deployFromInput 进战斗
  const at = legalTileFor(m, ps, c1);
  const r2 = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: at[0], col: at[1] }, dir: 'LEFT' });
  assert.deepEqual(r2, { ok: true }, `再部署应成功（${JSON.stringify(r2)}）`);
  const f = (m.fields || []).find((x) => x && x.battle && Array.isArray(x.players) && x.players.includes('p_0') && !x.done);
  const u2 = f && f.battle.allyUnits.find((x) => x && x.uid === piece.uid && !x.removed);
  assert.ok(u2, '再部署后战斗里应有该单位');
  assert.deepEqual((u2.items || []).map((x) => (typeof x === 'string' ? x : x && x.id)), before, '再部署时装备一并带回战斗');
  h.invariants();
});
