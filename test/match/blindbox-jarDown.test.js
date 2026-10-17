// 盲盒·砸罐子（jar）：干员被击倒后，棋子必须仍在玩家阵容里（board），
// 否则点选它时 placeCtx 里没有这个棋子 → 只弹详情窗 / 什么都没有（用户 2026-10-16「部分未击倒干员点击后只弹出详细窗」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};

const deployInCombat = (m, ps, chessId, skip = new Set()) => {
  const piece = give(m, ps, chessId, 'hand');
  const at = legalTileFor(m, ps, chessId, skip);
  assert.ok(at, `找不到 ${chessId} 的合法格`);
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: at[0], col: at[1] }, dir: 'LEFT' });
  assert.deepEqual(r, { ok: true }, `战斗中部署应成功（${JSON.stringify(r)}）`);
  const f = (m.fields || []).find((x) => x && x.battle && Array.isArray(x.players) && x.players.includes('p_0') && !x.done);
  const u = f && f.battle.allyUnits.find((x) => x && x.uid === piece.uid && !x.removed);
  return { piece, unit: u, field: f };
};

test('jar：多个干员被击倒后，每个棋子都还在玩家阵容里（可点选 / 可撤离）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 21 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const ids = chessOfTier(1);
  const a = deployInCombat(m, ps, ids[0]);
  const b = deployInCombat(m, ps, ids[1]);
  const c = deployInCombat(m, ps, ids[2]);
  // 全部击倒（倒地态：isDown + 再部署倒计时）
  for (const { unit, field } of [a, b, c]) {
    assert.ok(unit && field, '部署后应有战斗单位');
    field.battle.retreat(unit, { reason: 'killed' });
    assert.ok(field.battle.isDown(unit), '应处于击倒态');
  }
  // 战斗推进一段（击倒后的自动再部署 / 快照刷新都跑一遍）
  h.run(() => h.m.phase === 'COMBAT', { maxSteps: 20000 });
  for (const { piece } of [a, b, c]) {
    const loc = ps.find(piece.uid);
    assert.ok(loc, `uid ${piece.uid} 的棋子在击倒后必须还在阵容里（area=${loc && loc.area}）`);
    assert.equal(loc.area, 'board', `uid ${piece.uid} 被击倒时棋子仍应在 board（实际 ${loc.area}）`);
  }
  h.invariants();
});

test('jar：击倒干员再部署倒计时结束后，棋子仍在且可撤离', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 23 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const { piece, unit, field } = deployInCombat(m, ps, chessOfTier(1)[0]);
  field.battle.retreat(unit, { reason: 'killed' });
  assert.ok(field.battle.isDown(unit));
  // 倒计时走完（自动再部署）：棋子不能被吃掉
  h.run(() => !field.battle.isDown(unit) || h.m.phase !== 'COMBAT', { maxSteps: 60000 });
  const loc = ps.find(piece.uid);
  assert.ok(loc, '再部署后棋子不能消失');
  // 主动撤离：应成功回到待部署区
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'hand', idx: 2 } });
  assert.deepEqual(r, { ok: true }, `撤离应成功（${JSON.stringify(r)}）`);
  assert.ok(ps.hand[2] && ps.hand[2].uid === piece.uid, '应回到 hand 槽 2');
  h.invariants();
});
