// 盲盒 MOD (public/mod/盲盒模式.js + server/match/player/economy.js priceOf + match/intents.js blindBoxSet/scoutWave
// + match/views.js nextEnemiesFor) 的服务端逻辑测试：价格是服务器权威的，所以「底价 2（1 级 2 资金）、每升一级 +1」必须在这里成立；
// 敌人盲盒的隐藏 / 侦察同样服务端权威，所以 redacted / partial 也在这里验证。
//   * g.blindBoxSet：默认关闭时是官方价；shop/all 模式下每个格子价格 = 底价 2 + 等级 - 1（含道具格）；
//   * 升级后价格上涨 1；关闭后回到官方价；
//   * 真实购买按盲盒价扣费（不是原价）；
//   * LOBBY 阶段拒绝；g.blindBoxGet 单播当前状态（含 mode）；
//   * 敌人盲盒：普通波 nextEnemiesFor 标 redacted，侦察后只回 partial（空中/地面数量），boss 波不隐藏。
// 每条路径跑完引擎不变量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, give, giveItem, chessOfTier, legalTileFor } from './harness.js';
import { __jarEnemyTest } from '../../public/mod/盲盒模式.js';
import { FakeBattle } from './fakeBattle.js';
import { ERR, PHASE } from '../../shared/constants.js';

/** Co-op match at PREP R1. */
function setup({ seed = 47 } = {}) {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

const boxStates = (h) => h.bc.filter((x) => x.t === 'm.blindBoxState');
// 盲盒底价（与 public/mod/盲盒模式.js 的 BLIND_BOX_BASE 一致）：1 级 = 2 资金，每升一级 +1
const BOX_BASE = 2;
/** 盲盒价：底价 + (等级 - 1)。 */
const boxPrice = (lv) => BOX_BASE + (lv - 1);
// 真·单文件 MOD：盲盒的 per-match 状态在 m.mods.blindbox（server/mods.js modState），不再是引擎本体字段
const bbState = (m) => m.mods.blindbox;
const liveSlots = (p) => (p.shop.slots || []).filter((s) => s && !s.sold);

test('盲盒默认关闭：价格是官方价（不是等级）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.equal(bbState(m).mode, 'off', 'the switch starts off — the MOD never changes a match on its own');
  const slots = liveSlots(p0);
  assert.ok(slots.length, 'the shop has slots');
  // 官方价来自干员/道具原价；这里只要求"不开就不是盲盒价"——即至少有一个格子的价格不等于盲盒价，
  // 否则说明盲盒逻辑在关闭状态下也生效了。
  const lv = p0.shop.level;
  const allEqualLevel = slots.every((s) => p0.priceOf(s) === boxPrice(lv));
  assert.equal(allEqualLevel, false, 'with the switch off the prices are the rolled ones, not one box price');
  h.invariants();
});

test('g.blindBoxSet：shop 模式开启后每个格子（干员与道具）价格 = 底价 2 + 等级 - 1，并广播 m.blindBoxState{mode}', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const lv = p0.shop.level;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'shop' }), { ok: true });
  assert.equal(bbState(m).mode, 'shop');
  for (const s of liveSlots(p0)) {
    assert.equal(p0.priceOf(s), boxPrice(lv), `every slot costs the blind-box price (${boxPrice(lv)}) — kind ${s.kind}`);
  }
  const st = boxStates(h);
  assert.equal(st.length, 1, 'the switch is broadcast once');
  assert.deepEqual(st[0], { t: 'm.blindBoxState', mode: 'shop' });
  h.invariants();
});

test('盲盒价格随等级递增：1 级 = 底价 2，升一级 +1 资金', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'all' }), { ok: true });
  const before = p0.shop.level;
  const priceBefore = p0.priceOf(liveSlots(p0)[0]);
  assert.equal(priceBefore, boxPrice(before), `level ${before} costs ${boxPrice(before)}`);
  if (before === 1) assert.equal(priceBefore, 2, 'the base price is 2 (not 1)');
  // give the player enough funds to afford the upgrade, then level up
  p0.funds = 9999;
  assert.deepEqual(p0.levelUp(), { ok: true }, 'the shop levels up');
  const after = p0.shop.level;
  assert.equal(after, before + 1, 'one level higher');
  for (const s of liveSlots(p0)) assert.equal(p0.priceOf(s), boxPrice(after), `the box price is now ${boxPrice(after)}`);
  assert.equal(p0.priceOf(liveSlots(p0)[0]), priceBefore + 1, '+1 资金 per level');
  h.invariants();
});

test('盲盒下真实购买按等级扣费（不是原价）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'shop' }), { ok: true });
  p0.funds = 9999;
  const slots = p0.shop.slots;
  const idx = slots.findIndex((s) => s && !s.sold && s.kind === 'chess');
  assert.ok(idx >= 0, 'a chess slot exists');
  const lv = p0.shop.level;
  const fundsBefore = p0.funds;
  const res = p0.buy(idx);
  assert.deepEqual(res, { ok: true }, 'the buy goes through');
  assert.equal(fundsBefore - p0.funds, boxPrice(lv), `paid the box price (${boxPrice(lv)}), not the card's own price`);
  h.invariants();
});

test('g.blindBoxSet 关闭：价格回到官方价；重复设置不重复广播', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const official = liveSlots(p0).map((s) => p0.priceOf(s));
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'shop' }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'off' }), { ok: true });
  assert.equal(bbState(m).mode, 'off');
  const back = liveSlots(p0).map((s) => p0.priceOf(s));
  assert.deepEqual(back, official, 'the official prices come back');
  const st = boxStates(h);
  assert.equal(st.length, 2, 'one broadcast on, one off');
  // an unchanged switch is a no-op (no third broadcast)
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'off' }), { ok: true });
  assert.equal(boxStates(h).length, 2, 'setting the same value again broadcasts nothing');
  h.invariants();
});

test('g.blindBoxSet 在 LOBBY 被拒绝；g.blindBoxGet 单播当前状态（含 mode）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
  const m = h.m;
  // the switch is a match (not lobby) setting: refuse while the room has not started a match yet
  const realPhase = m.phase;
  m.phase = PHASE.LOBBY;
  assert.equal(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'shop' }).error, 'WRONG_PHASE');
  m.phase = realPhase;
  assert.equal(bbState(m).mode, 'off');
  h.toPrep(1);
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'shop' }), { ok: true });
  // the answer is unicast to the asking client only (same shape as g.creativeGet)
  const pushed = [];
  const origSend = m.sendTo;
  m.sendTo = (id, msg) => { pushed.push({ to: id, ...msg }); };
  try { assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxGet' }), { ok: true }); } finally { m.sendTo = origSend; }
  assert.equal(pushed.length, 1, 'unicast to the asking client only');
  assert.deepEqual(pushed[0], { to: 'p_0', t: 'm.blindBoxState', mode: 'shop' });
  h.invariants();
});

test('敌人盲盒：普通波隐藏敌人情报（redacted），侦察后只回类型+总数量（partial）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'enemy' }), { ok: true });
  const red = m.nextEnemiesFor(p0);
  assert.equal(red.length, 1, 'a single redacted placeholder (no enemyKey → pen/drawer hide it)');
  assert.equal(red[0].redacted, true, 'marked redacted, never reveals who');
  assert.ok(red[0].total >= 0, 'still carries the total count of the wave');
  // the real preview is hidden (no enemyKey in the redacted entry)
  assert.equal(red[0].enemyKey, undefined, 'the real enemy key is withheld from the client');
  // 免费侦察 → partial（只回空中 / 地面数量）
  assert.deepEqual(m.handle('p_0', { t: 'g.scoutWave', round: 1 }), { ok: true });
  const part = m.nextEnemiesFor(p0);
  assert.equal(part.length, 1);
  assert.equal(part[0].partial, true, 'scouted shows partial intel only');
  assert.equal(part[0].redacted, undefined, 'partial is not redacted');
  assert.ok(Number.isInteger(part[0].fly) && part[0].fly >= 0, 'fly count is a non-negative integer');
  assert.ok(Number.isInteger(part[0].ground) && part[0].ground >= 0, 'ground count is a non-negative integer');
  assert.equal(part[0].scale, undefined, 'no scale word leaked');
  assert.equal(part[0].total, undefined, 'no total leaked (only air/ground counts)');
  h.invariants();
});

test('敌人盲盒：侦察费用——免费 1 次，之后花 2×等级 资金；资金不足被拒', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'enemy' }), { ok: true });
  const lv = p0.shop.level;
  // 免费第 1 次
  assert.deepEqual(m.handle('p_0', { t: 'g.scoutWave', round: 1 }), { ok: true });
  // 第 2 次需付费且资金不足 → 拒绝
  p0.funds = 0;
  assert.equal(m.handle('p_0', { t: 'g.scoutWave', round: 1 }).error, 'NO_FUNDS');
  // 充值后再侦察 → 成功并扣费 2×等级
  p0.funds = 9999;
  const before = p0.funds;
  assert.deepEqual(m.handle('p_0', { t: 'g.scoutWave', round: 1 }), { ok: true });
  assert.equal(before - p0.funds, 2 * lv, `paid 2×level (${2 * lv}) for the paid re-scout`);
  h.invariants();
});

test('敌人盲盒：boss / 领袖波不隐藏（即使 enemy 模式开启）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'enemy' }), { ok: true });
  // 模拟一个 boss 回合（boss 波信息照常明示，让玩家能准备 boss 打法）
  const realBoss = m.bossWaves;
  const realGroup = m.bossGroupOf;
  m.bossWaves = { dummy: 1 };
  m.bossGroupOf = () => ({ wave: { spawns: [] }, side: 'L' });
  const r = m.nextEnemiesFor(p0);
  assert.deepEqual(r, [], 'a boss wave is never redacted — it returns the (here empty) real preview');
  m.bossWaves = realBoss;
  m.bossGroupOf = realGroup;
  // 回到普通波则重新隐藏
  const red = m.nextEnemiesFor(p0);
  assert.equal(red[0] && red[0].redacted, true, 'a normal wave stays redacted under enemy mode');
  h.invariants();
});

test('敌人盲盒仅在 enemy / all 模式生效；shop / off 模式敌人情报正常显示', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  // shop 模式：敌人情报照常（只是商店变盲盒）
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'shop' }), { ok: true });
  const normal = m.nextEnemiesFor(p0);
  assert.ok(normal.length > 0 && normal[0].enemyKey, 'shop mode keeps the normal enemy preview (has enemyKey)');
  // off 模式同样正常
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'off' }), { ok: true });
  const off = m.nextEnemiesFor(p0);
  assert.ok(off.length > 0 && off[0].enemyKey, 'off keeps the normal enemy preview');
  h.invariants();
});

// ── 砸罐子（jar 模式）─────────────────────────────────────────────────────────────
test('砸罐子：g.blindBoxSet 接受 jar 模式；进入 PREP 为每位存活玩家在每个可部署格子上放一个罐子', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  assert.equal(bbState(m).mode, 'jar');
  // enterPrep 已为每个存活玩家生成罐子：数量 = 可部署格子数（不再铺满全屏网格）
  const p0 = h.ps('p_0');
  const jars0 = bbState(m).jars[p0.playerId] || [];
  const dm = m.deployMapFor(p0);
  assert.ok(dm && dm.size > 0, '存在可部署格子');
  assert.equal(jars0.length, dm.size, `罐子数 = 可部署格子数（${dm.size}），实际 ${jars0.length}`);
  // 不再生成全屏网格
  assert.equal(bbState(m).jarGrid, undefined, 'jar 模式不再生成网格');
  // 客户端私有视图只拿到 id + 是否砸开 + 格子坐标，不含内容
  const pv = p0.privateView();
  assert.ok(Array.isArray(pv.jars), 'private view 带 jars 字段');
  assert.equal(pv.jars.length, jars0.length);
  assert.equal(pv.jarGrid, undefined, 'private view 不再带 jarGrid');
  for (const j of pv.jars) {
    assert.ok(typeof j.id === 'string' && j.smashed === false, 'jar view 只有 id + smashed=false');
    assert.ok(typeof j.row === 'number' && typeof j.col === 'number', 'jar view 带格子坐标 row/col（board 坐标）');
    assert.equal('opId' in j, false, '罐子内容不下发到客户端');
    assert.equal('itemId' in j, false, '道具内容也不下发到客户端');
  }
  h.invariants();
});

test('砸罐子：有干员部署的地块不刷新罐子（跨回合保留部署，新罐只落空闲格）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  const dm = m.deployMapFor(p0);
  const id = chessOfTier(1)[0];
  const at = legalTileFor(m, p0, id); // 该干员的合法部署格
  assert.ok(at, '存在合法部署格');
  give(m, p0, id, 'board', at); // 实放一名干员在场上（跨回合保留）
  bbState(m).generate();
  const jars = bbState(m).jars[p0.playerId] || [];
  assert.equal(jars.length, dm.size - 1, `已部署格不刷罐：${dm.size} - 1，实际 ${jars.length}`);
  assert.ok(!jars.some((j) => j.row === at[0] && j.col === at[1]), '干员占着的格子没有罐子');
  assert.ok(jars.length > 0, '空闲格仍然有罐子');
  h.invariants();
});

test('砸罐子：休整期结束不清零资金（结余留给升级调度中心）；非 jar 模式照常清零', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  // 核心规则：非 jar 模式休整期结束结余清零（无结转编队时）
  p0.addFunds(10, { reason: 'test' });
  p0.endPrep();
  assert.equal(p0.funds, 0, '非 jar 模式休整期结束结余清零（核心规则不变）');
  // jar 模式：不清零——没有商店可花，结余要留给升级调度中心（决定罐中干员阶数 / 道具池等级）
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  p0.addFunds(10, { reason: 'test' });
  p0.endPrep();
  assert.equal(p0.funds, 10, 'jar 模式休整期结束保留结余资金（不再归零）');
  // 跨轮累积：下一回合收入照常加在保留的结余之上
  const before = p0.funds;
  p0.startRound(2);
  assert.ok(p0.funds > before, `第 2 回合资金在结余上继续累积（${before} → ${p0.funds}）`);
  h.invariants();
});

test('砸罐子：战斗中也能升级调度中心（无休整期，服务端解除 PREP 门禁）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat: true }).start();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // 从头驱动进 PREP：phase hook 见到 jar 模式 → 排 600ms 后的自动 endPrep
  const okCombat = h.run(() => m.phase === PHASE.COMBAT, { maxSteps: 2e5 });
  assert.ok(okCombat, '自动进入战斗');
  p0.addFunds(50, { reason: 'test' });
  const lv0 = p0.shop.level;
  const price = p0.shop.upgradePrice;
  const f0 = p0.funds;
  assert.deepEqual(m.handle('p_0', { t: 'g.levelUp' }), { ok: true }, '战斗中升级调度中心成功（PREP 门禁已解除）');
  assert.equal(p0.shop.level, lv0 + 1, '调度中心等级 +1');
  assert.equal(p0.funds, f0 - price, `升级扣费（${f0} → ${p0.funds}，价 ${price}）`);
  h.invariants();
});

test('砸罐子：切换到非 jar 模式会清掉罐子；PREP 中途切到 jar 立即生成', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  assert.ok((bbState(m).jars[p0.playerId] || []).length > 0, 'jar 已生成（每个可部署格子一个）');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'off' }), { ok: true });
  assert.equal(Object.keys(bbState(m).jars).length, 0, '离开 jar 模式清空罐子'); // 空对象
  // PREP 中途再切回 jar 仍应生成
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  assert.ok((bbState(m).jars[p0.playerId] || []).length > 0, '中途切回也生成罐子');
  h.invariants();
});

test('砸罐子：砸开「干员」罐 → 免费获得一名干员（入整备区）；不扣资金', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  const jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'operator');
  if (!jar) return; // 本次随机没抽到干员罐，跳过（不影响不变量）
  const handBefore = p0.hand.filter(Boolean).length;
  const fundsBefore = p0.funds;
  const r = m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id });
  assert.deepEqual(r, { ok: true }, '砸罐成功');
  assert.equal(jar.smashed, true, '罐子标记为已砸开');
  assert.ok(p0.hand.filter(Boolean).length >= handBefore, '干员入整备区（或已合成）');
  assert.equal(p0.funds, fundsBefore, '砸罐不给也不扣资金');
  // 不可重复砸
  assert.equal(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id }).error, 'BAD_MSG', '已砸开的罐子不可再砸');
  h.invariants();
});

test('砸罐子：砸开「道具」罐 → 道具进整备区（acquireItem，同款自动合成金色）；不扣资金', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  // 每格一个罐，道具权重 20%，几乎必有；极端情况下重生成几轮再找
  let jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'item');
  for (let t = 0; !jar && t < 20; t++) {
    bbState(m).generate();
    jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'item');
  }
  assert.ok(jar && jar.itemId, '存在道具罐（kind=item 且带 itemId）');
  const countItems = () => [...p0.hand, ...p0.temp].filter((x) => x && x.kind === 'item').length;
  const before = countItems();
  const fundsBefore = p0.funds;
  assert.deepEqual(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id }), { ok: true }, '砸罐成功');
  assert.equal(jar.smashed, true, '罐子标记为已砸开');
  assert.equal(p0.funds, fundsBefore, '砸罐不给也不扣资金');
  assert.ok(countItems() >= before, '道具进入整备区（或与同款合成金色 —— 合成不减件）');
  // 不可重复砸
  assert.equal(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id }).error, 'BAD_MSG', '已砸开的罐子不可再砸');
  h.invariants();
});

test('砸罐子：砸开「敌人」罐 → 注入本波敌人（nextEnemies 出现 bounty 来源）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  const jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'enemy');
  if (!jar) return; // 本次没抽到敌人罐
  const before = m.nextEnemiesFor(p0).length;
  assert.deepEqual(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id }), { ok: true });
  assert.ok(p0.bounties.some((b) => b.card && b.card.jar && b.card.enemyKey === jar.enemyKey), '敌人罐进入 ps.bounties');
  const bount = p0.bounties.find((b) => b.card && b.card.jar && b.card.enemyKey === jar.enemyKey);
  assert.equal(bount.card.count, jar.count, '注入数量等于罐子随波次缩放的数量');
  const after = m.nextEnemiesFor(p0);
  assert.ok(after.length >= before, '砸开敌人罐后本波敌人预览增加或持平');
  assert.ok(after.some((e) => e.source === 'bounty'), '敌人预览含 bounty 来源（罐中敌人）');
  h.invariants();
});

test('砸罐子：敌人罐注入数量随波次缩放（杂兵早2/中3/后4；同盟再+1；R11+ 再+1 上限6；R6 起精英减半出），且干员 / 敌人 / 道具三类都抽得到', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  // 强度分档（用户 2026-10-15）：杂兵/老练按波次 2→3→4；精英（tier≥2，R6 才解锁）一次 1-3 只，给玩家凑阵容时间
  // 第 10 关（R11+）后：tier<3 的敌人数量再 +1（上限 6，用户要求「提升敌人的数量」）
  // 同盟模式（用户 2026-10-16）：单罐敌人再 +1（上限 6）——多人分摊火力，出怪量要跟上
  const expectFor = (round, key) => {
    const t = __jarEnemyTest.tier(m, key);
    let c = t >= 3 ? 1 // 大首领一次一只
      : t >= 2 ? Math.max(1, Math.min(3, 1 + Math.floor((round - 1) / 6)))
      : Math.min(4, 2 + Math.floor((round - 1) / 3));
    if (t < 3) c = Math.min(6, c + 1); // 同盟 +1
    if (t < 3 && round >= 11) c = Math.min(6, c + 1); // R11+ 再 +1
    return c;
  };
  for (const round of [1, 3, 4, 6, 7, 9, 12]) {
    m.round = round;
    bbState(m).generate();
    for (const j of (bbState(m).jars[p0.playerId] || [])) {
      if (j.kind === 'enemy') assert.equal(j.count, expectFor(round, j.enemyKey), `round ${round} 敌人罐(${j.enemyKey}) 数量应=${expectFor(round, j.enemyKey)}`);
    }
  }
  // 跑 40 次生成（约 40 × 可部署格数 个罐子），统计三类内容都可能出现，且道具比干员少（20% vs 40%）
  const seen = { operator: 0, enemy: 0, item: 0, buff: 0 };
  for (let s = 0; s < 40; s++) { m.round = 5; bbState(m).generate(); for (const j of (bbState(m).jars[p0.playerId] || [])) seen[j.kind]++; }
  assert.ok(seen.operator > 0 && seen.enemy > 0 && seen.item > 0, `干员 / 敌人 / 道具三类都能抽到，实际 ${JSON.stringify(seen)}`);
  assert.ok(seen.item < seen.operator, `道具罐（20%）应少于干员罐（40%），实际 ${JSON.stringify(seen)}`);
  h.invariants();
});

test('砸罐子：敌人池铺满整个stage（不只本波），轮流分配不连出同一种', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  // 期望池（与 MOD 的 enemyPool 同规则，用户 2026-10-15 强度重做）：全敌人库按回合强度上限过滤 +
  // 排除 mode.inactiveEnemyKeys——R1-2 仅杂兵，种类已远超模式波次模板的个位数
  const expectPool = () => {
    const cur = Number(m.round) || 1;
    const maxTier = cur <= 2 ? 0 : cur <= 5 ? 1 : 2;
    const out = [];
    for (const k of Object.keys(m.gd.raw.enemies || {})) {
      if (m.gd.inactiveEnemies && m.gd.inactiveEnemies.has(k)) continue;
      if (__jarEnemyTest.tier(m, k) <= maxTier) out.push(k);
    }
    return out;
  };
  const pool = expectPool();
  const waveDistinct = new Set((m.wave.spawns || []).map((s) => s.enemyKey || s.key).filter(Boolean));
  assert.ok(pool.length >= 2, `敌人池至少两种，实际 ${pool.length}`);
  assert.ok(pool.length > waveDistinct.size, `敌人池（${pool.length}）应比本波种类（${waveDistinct.size}）多——全库分档`);
  for (const k of pool) assert.ok(__jarEnemyTest.tier(m, k) <= 2, '池内无首领级（BOSS/超模）');
  const jars = bbState(m).jars[p0.playerId] || [];
  const enemyJars = jars.filter((j) => j.kind === 'enemy');
  assert.ok(enemyJars.length >= 2, '一轮里至少有2个敌人罐');
  for (const j of enemyJars) assert.ok(pool.includes(j.enemyKey), '敌人罐取的敌人在池内');
  // 轮流分配：种类数 = min(敌人罐数, 池大小)，不会「只有一种敌人」
  const distinct = new Set(enemyJars.map((j) => j.enemyKey));
  assert.equal(distinct.size, Math.min(enemyJars.length, pool.length),
    `敌人种类应=min(敌人罐数${enemyJars.length}, 池${pool.length})，实际 ${distinct.size}`);
  h.invariants();
});

test('砸罐子（兜底）：服务端代跑模式下敌人罐走 bounty 随本波战斗出现，休整期不中断', () => {
  const h = setup(); // clientCombat=false（harness 默认）：不开遭遇战
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  const jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'enemy');
  if (!jar) return; // 本次没抽到敌人罐
  const battlesBefore = (FakeBattle.instances || []).length;
  assert.equal(m.phase, PHASE.PREP, '砸之前还在休整期');
  assert.deepEqual(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id }), { ok: true });
  assert.equal(m.phase, PHASE.PREP, '砸出敌人罐绝不强制结束休整期');
  const jarBounties = p0.bounties.filter((b) => b.card && b.card.jar);
  assert.equal(jarBounties.length, 1, '兜底路径：罐中敌人入 bounty，随本波战斗出现（不重复）');
  assert.equal(jarBounties[0].card.enemyKey, jar.enemyKey);
  assert.equal((FakeBattle.instances || []).length, battlesBefore, '没有提前构造任何战斗');
  assert.equal(h.allTo('p_0', 'b.start').length, 0, '没有下发 b.start');
  h.invariants();
});

test('砸罐子（无休整期）：PREP 即生成罐子并 600ms 后自动开战；本波普通敌人全部禁用，只挂不计数的锚点', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat: true }).start();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1);
  assert.ok((bbState(m).jars[p0.playerId] || []).length > 0, 'PREP 即生成罐子');
  // 所有怪只能来自罐子：_normalOpts 里除锚点外 time 全是 Infinity（永不派出、不计 total、滤出 spec）
  const opts = m._normalOpts(p0);
  const wave = (m.wave.spawns || []).filter((s) => s && typeof s.enemyKey === 'string');
  assert.ok(wave.length > 0, '本波有普通敌人（测试前提）');
  const anchors = opts.spawns.filter((s) => s && s.tag === 'jar-anchor');
  assert.equal(anchors.length, 1, '恰好一个锚点 spawn（挂住 _pending，避免第一拍就 cleared）');
  assert.equal(anchors[0].countInTotal, false, '锚点不计入 total');
  assert.ok(anchors[0].time > opts.timeLimit, '锚点时刻远超 timeLimit（timeout 先到，永不走出）');
  for (const s of opts.spawns) {
    if (s.tag === 'jar-anchor') continue;
    assert.equal(s.time, Infinity, '普通 spawn 全部置为永不（time: Infinity）');
  }
  // 无休整期：罐子生成后 600ms 自动开战
  const okCombat = h.run(() => m.phase === PHASE.COMBAT, { maxSteps: 2e5 });
  assert.ok(okCombat, '罐子生成后自动进入战斗（无休整期）');
  h.invariants();
});

test('砸罐子（无休整期）：敌人罐砸出后延后 10 战斗秒（5 真实秒）才注入战斗', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat: true }).start();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1);
  const okCombat = h.run(() => m.phase === PHASE.COMBAT, { maxSteps: 2e5 });
  assert.ok(okCombat, '自动进入战斗');
  const jars = bbState(m).jars[p0.playerId] || [];
  const enemyJars = jars.filter((j) => j.kind === 'enemy');
  if (!enemyJars.length) return; // 本次没抽到敌人罐（概率）
  const jar = enemyJars[0];
  assert.deepEqual(m.handle('p_0', { t: 'g.smashJar', round: m.round, jarId: jar.id }), { ok: true });
  const msg = h.lastTo('p_0', 'b.jarSpawn');
  assert.ok(msg, '敌人罐砸出 → b.jarSpawn 下发');
  assert.equal(msg.spawns.length, 1);
  assert.equal(msg.spawns[0].enemyKey, jar.enemyKey, '注入的就是罐中敌人');
  assert.equal(msg.spawns[0].count, jar.count, '数量按罐子缩放');
  assert.equal(msg.spawns[0].time, 10, '出场缓冲 10 战斗秒（= 5 真实秒，战斗恒 2 倍速）');
  // spec 同步补写（接管 / headless 重建时敌人也在）：time = 战斗已进行时刻 + 缓冲
  const f = (m.fields || []).find((x) => Array.isArray(x.players) && x.players.includes(p0.playerId));
  const pushed = (f.spec.spawns || []).filter((s) => s.enemyKey === jar.enemyKey && s.tag === 'bounty');
  assert.ok(pushed.length >= 1, 'spec 同步补写该敌人');
  assert.ok(pushed.every((s) => s.time >= 10), 'spec time = 战斗已进行时刻 + 缓冲');
  assert.equal(p0.bounties.filter((b) => b.card && b.card.jar).length, 0, '战斗中砸出不走 bounty（不会在之后的波次重复出现）');
  h.invariants();
});

test('砸罐子：砸出干员罐不打断战斗节奏（拿到就能部署，穿装 / 落格照常）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  let jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'operator');
  for (let t = 0; !jar && t < 20; t++) { bbState(m).generate(); jar = (bbState(m).jars[p0.playerId] || []).find((j) => j.kind === 'operator'); }
  if (!jar) return;
  assert.deepEqual(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: jar.id }), { ok: true });
  assert.equal(m.phase, PHASE.PREP, '干员罐不触发开战——休整继续，拿到就能部署');
  h.invariants();
});

test('砸罐子：非法砸罐被拒（非 PREP / 不存在 / 非字符串 id）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
  const m = h.m;
  assert.equal(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: 'x' }).error, 'WRONG_PHASE', 'LOBBY 拒绝');
  h.toPrep(1);
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.smashJar', round: 1, jarId: 'nope' }).error, 'BAD_TARGET', '不存在的罐子');
  assert.equal(m.handle('p_0', { t: 'g.smashJar', round: 1 }).error, 'BAD_MSG', '缺 jarId');
  h.invariants();
});


test('砸罐子：合并精锐照常弹出「高一级干员三选一」并可免费选取（jar 底栏自绘 reward）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  const id = chessOfTier(1, (c) => c.position === 'MELEE').find((x) => m.pool.has(x));
  assert.ok(id, '池里有 1 阶近战干员');
  const golden = DATA.chess[id].goldenId;
  assert.ok(golden, '该干员有精锐版本');
  // 商店 slot 0 上架该干员；场上 + 手牌各放一个，再买一个 → 3 份触发合并
  p0.shop.slots[0] = { kind: 'chess', id, basePrice: m.gd.chessPrice(id), frozen: false, sold: false };
  give(m, p0, id, 'board', [9, 3]);
  give(m, p0, id);
  p0.funds = 100;
  assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot: 0 }), { ok: true });
  const elite = p0.board.get('9,3');
  assert.ok(elite && elite.id === golden, '合并出精锐');
  assert.equal(p0.stats.merges, 1, '合并计数 +1');
  // 晋升奖励入队（pushRewardOffer('merge')：tier = min(调度中心等级+1, 6)，3 个不同干员免费选 1）
  const offer = p0.privateView().shop.rewardOffer;
  assert.ok(offer, '合并后入队三选一奖励');
  assert.equal(offer.source, 'merge');
  assert.equal(offer.slots.length, 3);
  assert.ok(Number.isInteger(offer.tier) && offer.tier >= 1 && offer.tier <= 6, `奖励档位合法（${offer.tier}）`);
  for (const s of offer.slots) { assert.equal(s.price, 0, '免费'); assert.ok(DATA.chess[s.id], '槽位是合法干员'); }
  // 免费选一个（g.reward idx 映射 slots 下标）：不扣资金，干员进整备区，offer 清空
  const funds = p0.funds;
  const pick = offer.slots[1].id;
  assert.deepEqual(m.handle('p_0', { t: 'g.reward', idx: 1 }), { ok: true });
  assert.equal(p0.funds, funds, '选取奖励不扣资金');
  assert.ok(p0.hand.some((p) => p && p.id === pick) || p0.hand.some((p) => p && p.id === DATA.chess[pick].goldenId), '所选干员进整备区');
  assert.equal(p0.privateView().shop.rewardOffer, null, '选取后 offer 清空');
  assert.deepEqual(m.handle('p_0', { t: 'g.reward', idx: 0 }).error, ERR.BAD_TARGET, '清空后不能再选');
  h.invariants();
});

test('砸罐子：紧急调度券改为随机获得不高于当前调度中心等级的干员（jar 无商店）', () => {
  const h = setup();
  const m = h.m;
  const ps = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  // 调度中心等级 2 → 只应获得 tier ≤ 2 的干员
  ps.shop.level = 2;
  const carrier = give(m, ps, chessOfTier(1)[0], 'hand');
  const ticket = giveItem(m, ps, 'chess_item_2_02_e_a'); // 紧急调度券 ×1（装备即销毁）
  const beforeUids = new Set([...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)].map((p) => p.uid));
  assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: ticket.uid, targetUid: carrier.uid }), { ok: true });
  const after = [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)];
  const gained = after.filter((p) => !beforeUids.has(p.uid));
  assert.ok(gained.length >= 1, ' jar 模式仍能获得干员（改走池子 roll）');
  for (const p of gained) {
    const rec = DATA.chess[p.id];
    assert.ok(rec, '获得的是合法干员');
    assert.ok(rec.tier <= 2, `获得干员「${rec.name}」阶数 ${rec.tier} 不高于调度中心等级 2`);
  }
  assert.equal(after.some((p) => p.kind === 'item'), false, '调度券装备即销毁');
  // 等级 1 时同样只出不高于 1 阶的
  ps.shop.level = 1;
  const carrier2 = give(m, ps, chessOfTier(1)[1] || chessOfTier(1)[0], 'hand');
  const ticket2 = giveItem(m, ps, 'chess_item_2_02_e_b'); // ×2 版本：不重复出同一干员
  const before2 = new Set([...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)].map((p) => p.uid));
  assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: ticket2.uid, targetUid: carrier2.uid }), { ok: true });
  const after2 = [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)];
  const gained2 = after2.filter((p) => !before2.has(p.uid));
  assert.ok(gained2.length >= 1, '×2 版本至少获得 1 名');
  for (const p of gained2) {
    const rec = DATA.chess[p.id];
    assert.ok(rec && rec.tier <= 1, `等级 1 时获得干员阶数 ${rec && rec.tier} 不高于 1`);
  }
  const ids2 = gained2.map((p) => p.id);
  assert.equal(ids2.length, new Set(ids2).size, '×2 版本不重复出同一干员');
  h.invariants();
});
