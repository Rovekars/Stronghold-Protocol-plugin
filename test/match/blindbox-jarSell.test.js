// 盲盒·砸罐子（jar）：战斗中「售卖干员」功能（用户需求 2026-10-13）。
// 核心 g.sell 的 _gate 只放行休整期，而 jar 全程战斗（无休整期），故新增 MOD intent g.jarSell 保留售卖功能：
// 战斗中板上已部署的干员先撤掉战斗单位（与 jarRetreat 同一套路，e2e 已证明），再解除一次 PREP gate 调 ps.sell；
// 手牌/整备区干员直接售卖。本测试确定性覆盖成交逻辑 + 门禁绕过 + 非 jar 拒绝。
// 注：板上干员「同时移除战斗单位」依赖真实 Battle.retreatToBench（FakeBattle 未实现），该分支由 e2e 撤退路径复用证明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';
import { PHASE } from '../../shared/constants.js';

const chessId = () => chessOfTier(1)[0];

function jarMatch(phase) {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  h.toPrep(1);
  const m = h.m;
  // 直接置 jar 模式（绕过 g.blindBoxSet 的完整 jar 战场初始化；本测试只验证 g.jarSell 成交逻辑）
  m.mods.blindbox = { mode: 'jar', blindScout: {}, jars: {} };
  if (phase) m.phase = phase;
  return h;
}

test('g.jarSell：jar 模式（PREP）售卖手牌干员，资金按售价增加、棋子离手', () => {
  const h = jarMatch(PHASE.PREP);
  const m = h.m;
  const ps = h.ps('p_0');
  const piece = give(m, ps, chessId(), 'hand');
  const fundsBefore = ps.funds;
  const price = m.gd.sellPrice(piece.id);
  const res = m.handle('p_0', { t: 'g.jarSell', uid: piece.uid });
  assert.deepEqual(res, { ok: true }, 'g.jarSell 成交');
  assert.equal(ps.funds, fundsBefore + (Number.isFinite(price) ? Math.max(0, Math.trunc(price)) : 1), 'funds += sellPrice');
  assert.equal(ps.hand.some((p) => p && p.uid === piece.uid), false, '离开了手牌');
  h.invariants();
});

test('g.jarSell：jar 模式（COMBAT，板上干员、当前无 live 战场）也能售卖（绕过 PREP 门禁）', () => {
  const h = jarMatch(PHASE.COMBAT);
  const m = h.m;
  const ps = h.ps('p_0');
  const tile = legalTileFor(m, ps, chessId());
  assert.ok(tile, '有合法落点');
  const piece = give(m, ps, chessId(), 'board', tile);
  const fundsBefore = ps.funds;
  const price = m.gd.sellPrice(piece.id);
  const res = m.handle('p_0', { t: 'g.jarSell', uid: piece.uid });
  assert.deepEqual(res, { ok: true }, 'combat 阶段仍可售卖（门禁已绕过）');
  assert.equal(ps.funds, fundsBefore + (Number.isFinite(price) ? Math.max(0, Math.trunc(price)) : 1), 'funds += sellPrice');
  assert.equal(ps.board.size, 0, '离开了棋盘');
});

test('g.jarSell：非 jar 模式拒绝', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  m.phase = PHASE.COMBAT;
  const piece = give(m, ps, chessId(), 'hand');
  const res = m.handle('p_0', { t: 'g.jarSell', uid: piece.uid });
  assert.notEqual(res && res.ok, true, '非 jar 模式必须拒绝');
});

test('g.jarSell：非 chess 目标（道具）拒绝', () => {
  const h = jarMatch(PHASE.COMBAT);
  const m = h.m;
  const ps = h.ps('p_0');
  const items = Object.values(m.gd.item ? m.gd.item : {});
  const itemId = (m.gd.itemList && m.gd.itemList()[0]) || Object.keys(m.gd.items || {}).map((k) => m.gd.item(k)).filter(Boolean)[0]?.id;
  if (!itemId) return; // 数据无道具则跳过
  const piece = give(m, ps, itemId, 'hand');
  const res = m.handle('p_0', { t: 'g.jarSell', uid: piece.uid });
  assert.notEqual(res && res.ok, true, '道具不能被 g.jarSell 售卖');
});
