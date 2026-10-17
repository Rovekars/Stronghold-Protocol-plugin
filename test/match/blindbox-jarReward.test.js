// 盲盒·砸罐子（jar）：战斗中领取晋升奖励（用户 2026-10-16 报告：点击「确认选择」干员没进待部署区）。
//
// 根因：g.reward（pickReward）的 _gate 只放行「PREP 且未 ready」；jar 无休整期、晋升奖励在战斗中
// 合成时入队，此时 phase=COMBAT 且全员已被 endPrep 置 ready → 服务端永远拒 WRONG_PHASE，
// 客户端 .catch(() => {}) 静默吞掉 → 卡片点了没反应。
// 修复：_gate 增加 allowCombat（仅 jar 模式放行 COMBAT），pickReward 在 jar 下 allowWhenReady。
// 本文件同时钉死：非 jar 对局在 COMBAT 领奖励仍被拒（原生行为不回退）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, chessOfTier } from './harness.js';
import { GEO } from '../../shared/constants.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};

test('jar 晋升奖励：战斗中可领取——干员进待部署区，不变量成立', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  assert.equal(m.phase, 'COMBAT', 'jar 无休整期，应已进入战斗');
  assert.equal(ps.ready, true, 'endPrep 已把玩家置 ready（gate 必须放行 ready 玩家）');
  // 战斗中合成晋升 → 入队三选一（显式 ids：不依赖池子随机）
  const picks = chessOfTier(2).slice(0, 3);
  assert.ok(picks.length >= 1, '池子里有 tier2 干员可选');
  const offer = ps.pushRewardOffer('merge', { ids: picks });
  assert.ok(offer, '战斗中入队晋升奖励成功');
  assert.equal(ps.offers.length, 1);

  // 修复点：COMBAT + ready 下领取成功
  const r = m.handle('p_0', { t: 'g.reward', idx: 0 });
  assert.deepEqual(r, { ok: true }, `领取应成功（got ${JSON.stringify(r)}）`);
  assert.equal(ps.offers.length, 0, '领取后 offer 出队');
  assert.ok(ps.hand.some((p) => p && p.id === picks[0]), '干员进待部署区（hand）');
  assert.equal(ps.temp.some((p) => p && p.id === picks[0]), false, '手牌有空位时不应落入暂存区');
  h.invariants();
});

test('jar 晋升奖励：手牌满时落暂存区（不丢人），领取仍成功', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 11 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const handSize = GEO.HAND_SIZE;
  // 用互不相同的基础干员填满手牌（同 base 两份会立即合成，破坏「手牌满」前提）
  const fillers = [];
  for (const id of chessOfTier(1)) {
    const base = m.gd.baseIdOf(id);
    if (fillers.some((f) => m.gd.baseIdOf(f) === base)) continue;
    fillers.push(id);
    if (fillers.length >= handSize) break;
  }
  assert.ok(fillers.length >= handSize, `tier1 池子足以填满手牌（需要 ${handSize}）`);
  // 战斗中授予干员与砸罐同路（acquireChess 无阶段限制；fromPool=false 不耗公共池）
  for (const id of fillers) ps.acquireChess(id, { fromPool: false, silent: true });
  assert.equal(ps.hand.filter(Boolean).length, handSize, '手牌已满');
  const pick = chessOfTier(2).find((id) => !fillers.some((f) => m.gd.baseIdOf(f) === m.gd.baseIdOf(id)));
  assert.ok(pick, '找到不与 filler 同 base 的奖励干员');
  ps.pushRewardOffer('merge', { ids: [pick] });
  const r = m.handle('p_0', { t: 'g.reward', idx: 0 });
  assert.deepEqual(r, { ok: true }, `手牌满时领取仍成功（got ${JSON.stringify(r)}）`);
  assert.ok(ps.hand.some((p) => p && p.id === pick) || ps.temp.some((p) => p && p.id === pick),
    '干员落到手牌或暂存区，不丢失');
  h.invariants();
});

test('非 jar 对局：COMBAT 中领奖励仍被拒（原生 PREP-only 行为不回退）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  h.toPrep(1);
  // 非 jar：正常休整期收尾（人类 ready + bot 自行 ready → endPrep → COMBAT）；endPrep 会清 offers，
  // 故先开战再入队（这正是 jar 才会出现的「战斗中存在奖励」场景，这里验证原生 gate 仍拒它）
  h.m.handle('p_0', { t: 'g.ready', ready: true });
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const picks = chessOfTier(2).slice(0, 3);
  ps.pushRewardOffer('merge', { ids: picks });
  assert.equal(h.m.phase, 'COMBAT');
  const r = h.m.handle('p_0', { t: 'g.reward', idx: 0 });
  assert.ok(!r.ok, `非 jar 战斗中领取必须被拒（got ${JSON.stringify(r)}）`);
  assert.equal(r.error, 'WRONG_PHASE');
  assert.equal(ps.offers.length, 1, 'offer 保留（没被消费）');
  assert.equal(ps.hand.some((p) => p && p.id === picks[0]), false, '没有干员进手牌');
});
