// 创造模式 MOD (public/mod/创造模式.js + server/match/player/creative.js + match/intents.js creativeSet)
// 的服务端逻辑测试：
//   * g.creativeSet：开启 / 关闭（cap 复位 999）、m.creativeState 广播、LOBBY 拒绝；
//   * g.creativePick：创造模式关闭 → CREATIVE_OFF；未知 id → BAD_TARGET；PREP 免费自取（资金分文不动）、
//     第三份立即 3 合 1、金色干员可直接领取、手牌 + 临时整备区全满 → HAND_FULL；
//   * 盟约叠层上限：本局 layerCap 生效于休整期增益（ps.addLayers）、普通战斗 spec.flags.layerCap、
//     Battle.addLayers 的实时层；关闭创造模式后回到官方 999；invariants 在层数超过 999 时依然全绿。
// 每条路径跑完引擎不变量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, DATA } from './harness.js';
import { BOND_LAYER_CAP, layerGainRoom, INFINITE_FUNDS } from '../../shared/constants.js';

/** Co-op match at PREP R1. */
function setup({ seed = 41 } = {}) {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

const normalIds = () => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden && !c.isDiy);
const anyChessId = () => normalIds().map((c) => c.chessId).sort()[0];
const anyItemId = () => Object.values(DATA.items).map((it) => it.id).sort()[0];
const goldenOf = (baseId) => Object.values(DATA.chess).find((c) => c.isGolden && c.baseId === baseId)?.chessId || null;
const states = (h) => h.bc.filter((x) => x.t === 'm.creativeState');
const ownedOf = (p0, baseId) => [...p0.board.values(), ...p0.hand.filter(Boolean), ...p0.temp.filter(Boolean)]
  .filter((p) => p && p.kind === 'chess' && DATA.chess[p.id].baseId === baseId);
const itemsOf = (p0, itemId) => [...p0.hand.filter(Boolean), ...p0.temp.filter(Boolean)]
  .filter((p) => p && p.kind === 'item' && p.id === itemId);

test('g.creativeSet：开启广播 m.creativeState，可设本局叠层上限；关闭后上限复位 999', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, layerCap: 5000 }), { ok: true });
  assert.equal(m.creative.on, true);
  assert.equal(m.creative.layerCap, 5000);
  assert.equal(m.layerCapNow(), 5000);
  const st = states(h);
  assert.equal(st.length, 1);
  assert.deepEqual(st[0], { t: 'm.creativeState', on: true, layerCap: 5000, infiniteFunds: false });
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: false }), { ok: true });
  assert.equal(m.creative.on, false);
  assert.equal(m.creative.layerCap, BOND_LAYER_CAP, 'the cap resets to 999');
  assert.equal(m.layerCapNow(), BOND_LAYER_CAP);
  h.invariants();
});

test('g.creativePick：关闭时 CREATIVE_OFF；未知 id BAD_TARGET', () => {
  const h = setup();
  const m = h.m;
  assert.equal(m.handle('p_0', { t: 'g.creativePick', id: anyChessId() }).error, 'CREATIVE_OFF');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.creativePick', id: 'no_such_chess' }).error, 'BAD_TARGET');
  h.invariants();
});

test('g.creativePick：PREP 免费自取——资金分文不动、从共享池扣、进手牌', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  const id = anyChessId();
  const fundsBefore = p0.funds;
  assert.deepEqual(m.handle('p_0', { t: 'g.creativePick', id }), { ok: true });
  assert.equal(p0.funds, fundsBefore, 'free — the sandbox never charges');
  assert.equal(ownedOf(p0, DATA.chess[id].baseId).length, 1, 'the piece is owned now');
  h.invariants();
});

test('g.creativePick：凑齐第三份立即 3 合 1（与购买同规则）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  const id = anyChessId();
  const golden = goldenOf(DATA.chess[id].baseId);
  assert.ok(golden, 'the fixture chess has a golden tier');
  for (let i = 0; i < 2; i++) assert.ok(give(m, p0, id, 'hand'));
  assert.deepEqual(m.handle('p_0', { t: 'g.creativePick', id }), { ok: true });
  const goldens = [...p0.board.values(), ...p0.hand.filter(Boolean), ...p0.temp.filter(Boolean)]
    .filter((p) => p && p.kind === 'chess' && p.id === golden);
  assert.equal(goldens.length, 1, 'the merge produced the elite');
  h.invariants();
});

test('g.creativePick：金色干员可直接领取', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  const golden = goldenOf(DATA.chess[anyChessId()].baseId);
  assert.deepEqual(m.handle('p_0', { t: 'g.creativePick', id: golden }), { ok: true });
  assert.equal(ownedOf(p0, DATA.chess[golden].baseId).length, 1, 'the elite is owned');
  h.invariants();
});

test('g.creativePick：手牌与临时整备区全满 → HAND_FULL', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  const ids = normalIds().map((c) => c.chessId);
  const H = p0.hand.length;
  const T = p0.temp.length;
  assert.ok(ids.length >= H + T + 1, 'enough distinct fixture chess');
  for (let i = 0; i < H; i++) give(m, p0, ids[i], 'hand', i);
  for (let i = 0; i < T; i++) give(m, p0, ids[H + i], 'temp', i);
  assert.equal(p0.hand.filter((x) => x == null).length + p0.temp.filter((x) => x == null).length, 0, 'no room left');
  const r = m.handle('p_0', { t: 'g.creativePick', id: ids[H + T] });
  assert.equal(r.error, 'HAND_FULL');
  h.invariants();
});

test('g.creativePick kind:"item"：PREP 免费自取道具——资金分文不动、进卡槽（手牌）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  const id = anyItemId();
  const fundsBefore = p0.funds;
  assert.deepEqual(m.handle('p_0', { t: 'g.creativePick', id, kind: 'item' }), { ok: true });
  assert.equal(p0.funds, fundsBefore, 'free — the sandbox never charges');
  assert.equal(itemsOf(p0, id).length, 1, 'the item sits in the hand (card slots)');
  h.invariants();
});

test('g.creativePick kind:"item"：未知道具 BAD_TARGET；kind 缺省仍按干员处理（旧协议兼容）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.creativePick', id: 'no_such_item', kind: 'item' }).error, 'BAD_TARGET');
  const id = anyChessId();
  assert.deepEqual(m.handle('p_0', { t: 'g.creativePick', id }), { ok: true }, 'no kind → chess (1.1 protocol)');
  assert.equal(ownedOf(p0, DATA.chess[id].baseId).length, 1);
  h.invariants();
});

test('g.creativePick kind:"item"：手牌与临时整备区全满 → HAND_FULL（acquireItem 销毁并拒绝）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true }), { ok: true });
  const ids = normalIds().map((c) => c.chessId);
  const H = p0.hand.length;
  const T = p0.temp.length;
  assert.ok(ids.length >= H + T, 'enough distinct fixture chess');
  for (let i = 0; i < H; i++) give(m, p0, ids[i], 'hand', i);
  for (let i = 0; i < T; i++) give(m, p0, ids[H + i], 'temp', i);
  assert.equal(p0.hand.filter((x) => x == null).length + p0.temp.filter((x) => x == null).length, 0, 'no room left');
  assert.equal(m.handle('p_0', { t: 'g.creativePick', id: anyItemId(), kind: 'item' }).error, 'HAND_FULL');
  h.invariants();
});

test('本局叠层上限：休整期增益（ps.addLayers）在 cap 处停下，关闭后回到 999', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const bondId = Object.keys(p0.bonds)[0];
  assert.ok(bondId, 'the fixture player has bonds');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, layerCap: 50 }), { ok: true });
  assert.equal(p0.addLayers(bondId, 30, { reason: 'creative' }), 30);
  assert.equal(p0.layers[bondId], 30);
  assert.equal(p0.addLayers(bondId, 30, { reason: 'creative' }), 20, 'clamped at the match cap 50');
  assert.equal(p0.layers[bondId], 50);
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: false }), { ok: true });
  assert.equal(p0.addLayers(bondId, 30, { reason: 'creative' }), 30, 'back under the official 999');
  assert.equal(p0.layers[bondId], 80);
  h.invariants();
});

test('本局叠层上限：普通战斗 spec.flags.layerCap 携带本局上限', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, layerCap: 40 }), { ok: true });
  const opts = m._normalOpts(h.ps('p_0'));
  assert.equal(opts.flags.layerCap, 40, 'the normal battle spec carries the match cap');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: false }), { ok: true });
  assert.equal(m._normalOpts(h.ps('p_0')).flags.layerCap, BOND_LAYER_CAP, 'back to the official cap');
  h.invariants();
});

test('g.creativeLayers：直接设定某盟约的当前层数（可高可低，可归零）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const bondId = Object.keys(p0.bonds)[0];
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, layerCap: 999 }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeLayers', bondId, layers: 123 }), { ok: true });
  assert.equal(p0.layers[bondId], 123, 'jumps straight to 123 — no gain, no cap-side arithmetic');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeLayers', bondId, layers: 7 }), { ok: true });
  assert.equal(p0.layers[bondId], 7, 'can go down as well');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeLayers', bondId, layers: 0 }), { ok: true });
  assert.equal(p0.layers[bondId], 0);
  h.invariants();
});

test('g.creativeLayers：层数按本局 cap 裁剪；未开创造 / 非 PREP / 未知道约 → 拒绝', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const bondId = Object.keys(p0.bonds)[0];
  assert.equal(m.handle('p_0', { t: 'g.creativeLayers', bondId, layers: 5 }).error, 'CREATIVE_OFF',
    'the sandbox is off');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, layerCap: 30 }), { ok: true });
  assert.equal(m.handle('p_0', { t: 'g.creativeLayers', bondId: 'no_such_bond', layers: 5 }).error, 'BAD_TARGET');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeLayers', bondId, layers: 9999 }), { ok: true });
  assert.equal(p0.layers[bondId], 30, 'clamped to this match cap (30)');
  const savedPhase = m.phase; // leaving PREP (BATTLE): the write is refused
  m.phase = 'BATTLE';
  assert.equal(m.handle('p_0', { t: 'g.creativeLayers', bondId, layers: 3 }).error, 'WRONG_PHASE');
  m.phase = savedPhase;
  assert.equal(p0.layers[bondId], 30);
  h.invariants();
});

test('layerGainRoom：cap 参数语义（默认 999、低于/高于默认皆生效）', () => {
  assert.equal(layerGainRoom(30, 100), 100, 'default cap 999 is not the binding one here');
  assert.equal(layerGainRoom(990, 100), 9, 'the official 999 clamps');
  assert.equal(layerGainRoom(30, 100, 40), 10, 'a lower match cap clamps');
  assert.equal(layerGainRoom(1500, 100, 5000), 100, 'a higher match cap lets gains pass 999');
  assert.equal(layerGainRoom(1500, 100, BOND_LAYER_CAP), 0, 'without the cap a count past 999 gains nothing');
});

test('invariants：本局 cap 高于 999 时层数越界 999 依然全绿', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const bondId = Object.keys(p0.bonds)[0];
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, layerCap: 5000 }), { ok: true });
  assert.equal(p0.addLayers(bondId, 1500, { reason: 'creative' }), 1500);
  assert.equal(p0.layers[bondId], 1500, 'past the official 999 in the sandbox');
  h.invariants();
});

test('g.creativeSet 无限资金：开启后所有玩家资金顶满 INFINITE_FUNDS 并广播 infiniteFunds:true', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const f0 = p0.funds;
  assert.notEqual(f0, INFINITE_FUNDS, 'sanity: the original funds were not already infinite');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, infiniteFunds: true }), { ok: true });
  assert.equal(m.creative.infiniteFunds, true);
  assert.equal(p0.funds, INFINITE_FUNDS, 'the requesting player’s display funds are topped up');
  // match-wide: every other player’s funds are topped up too (the loop in creativeSet covers all seats)
  for (const p of m.players.values()) if (p !== p0) assert.equal(p.funds, INFINITE_FUNDS, `${p.playerId}’s funds topped up`);
  const st = states(h);
  assert.deepEqual(st[st.length - 1], { t: 'm.creativeState', on: true, layerCap: BOND_LAYER_CAP, infiniteFunds: true });
  h.invariants();
});

test('无限资金：开启后购买不再扣减资金（服务端不再收费，审计放行）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, infiniteFunds: true }), { ok: true });
  const idx = p0.shop.slots.findIndex((s) => s && !s.sold);
  assert.ok(idx >= 0, 'the shop has a slot to buy');
  const before = p0.funds;
  const r = m.handle('p_0', { t: 'g.buy', slot: idx });
  assert.equal(r.ok, true, 'the buy succeeded');
  assert.equal(p0.funds, before, 'infinite funds: the buy did NOT deduct');
  h.invariants();
});

test('无限资金：关闭后保持当前资金不变（不清零，不重置为 0）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, infiniteFunds: true }), { ok: true });
  assert.equal(p0.funds, INFINITE_FUNDS);
  assert.deepEqual(m.handle('p_0', { t: 'g.creativeSet', on: true, infiniteFunds: false }), { ok: true });
  assert.equal(m.creative.infiniteFunds, false);
  assert.equal(p0.funds, INFINITE_FUNDS, 'funds are kept (no reset) after turning the flag off');
  h.invariants();
});
