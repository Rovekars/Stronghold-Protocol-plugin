// 盲盒·砸罐子（jar）：客户端模拟（生产默认）下，已部署干员的棋子不得在回合内被无故销毁
// （用户 2026-10-16：部分击倒干员撤离回待部署区会丢失素材 / 部分干员点击只弹详情窗 ——
//  两者共同前提是「priv 里找不到这个棋子」；本文件盯住棋子的存活）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};

test('jar（客户端模拟）：回合内推进战斗，已部署棋子始终留在玩家阵容里', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 31, clientCombat: true }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const ids = chessOfTier(1);
  const deployed = [];
  const skip = new Set();
  for (let i = 0; i < 3; i++) {
    const piece = give(m, ps, ids[i], 'hand');
    const at = legalTileFor(m, ps, ids[i], skip);
    assert.ok(at, `找不到 ${ids[i]} 的合法格`);
    skip.add(`${at[0]},${at[1]}`);
    const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: at[0], col: at[1] }, dir: 'LEFT' });
    assert.deepEqual(r, { ok: true }, `部署应成功（${JSON.stringify(r)}）`);
    deployed.push(piece);
  }
  // 推进 60 秒虚拟时间（战斗跑起来，干员会被打 / 被击倒 / 自动再部署）
  const t0 = m.clock ? m.clock.now() : 0;
  h.run(() => (m.clock ? m.clock.now() : Date.now()) - t0 > 60000 || h.ended != null, { maxSteps: 400000 });
  for (const p of deployed) {
    const loc = ps.find(p.uid);
    assert.ok(loc, `uid ${p.uid}（${p.id}）的棋子在战斗中消失了（应始终留在 board / 被撤离才进 hand）`);
  }
  h.invariants();
});
