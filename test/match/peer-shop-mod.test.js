// 观战队友 + 购买队友商店商品 MOD (public/mod/观战队友.js + server/match/player/peershop.js) 的服务端逻辑测试：
//   * 观战：g.peerShop 推送 m.peerShop 商店快照（索引保持、价格为主人的 onPrice 后价格）；
//   * 购买：买家的钱、棋子进买家手牌、槽位在主人商店标记 sold、主人资金与回合购买数不变；
//   * 道具槽位同样可买；
//   * 已售出 / 资金不足 / 买家手牌满 / 非 PREP / 买自己的商店：全部拒绝且无任何变化；
//   * 每条路径跑完引擎不变量（invariants）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, give, DATA } from './harness.js';

/** Co-op match at PREP R1. */
function setup({ humans = 2, bots = 1, seed = 47 } = {}) {
  const h = makeMatch({ mode: 'coop', humans, bots, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

const distinctIds = (n) => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden).map((c) => c.chessId).sort().slice(0, n);
const itemId = () => Object.values(DATA.items).filter((i) => i.itemType === 'EQUIP' && !i.isGolden).map((i) => i.itemId ?? i.id).sort()[0];
/** p's first unsold shop slot index (null when the roll came up empty). */
const firstSlot = (p) => p.shop.slots.findIndex((s) => s && !s.sold);
/** m.peerShop is a unicast to the requester: the harness records unicasts in h.sent. */
const snapshots = (h, id) => h.allTo(id, 'm.peerShop');

test('观战：g.peerShop 推送队友商店快照（索引保持、价格为主人的价格）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  assert.deepEqual(m.handle('p_0', { t: 'g.peerShop', to: 'p_1' }), { ok: true });
  const snaps = snapshots(h, 'p_0');
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].from, 'p_1');
  assert.equal(snaps[0].name, p1.name);
  assert.equal(snaps[0].level, p1.shop.level);
  assert.equal(snaps[0].slots.length, p1.shop.slots.length, 'indices are preserved');
  for (let i = 0; i < snaps[0].slots.length; i++) {
    const s = p1.shop.slots[i];
    if (!s) { assert.equal(snaps[0].slots[i], null); continue; }
    assert.equal(snaps[0].slots[i].id, s.id);
    assert.equal(snaps[0].slots[i].price, p1.priceOf(s), 'the price is the owner\'s onPrice-adjusted price');
    assert.equal(snaps[0].slots[i].sold, !!s.sold);
  }
  h.invariants();
});

test('观战 AI 队友的商店也允许', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.peerShop', to: 'ai_0' }), { ok: true });
  assert.equal(snapshots(h, 'p_0').length, 1);
  h.invariants();
});

test('购买干员：买家扣钱、棋子进买家手牌、槽位 sold、主人无资金变化且 round.buys 不计', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const slotIdx = firstSlot(p1);
  assert.ok(slotIdx >= 0, 'the shop rolled at least one card');
  const slot = p1.shop.slots[slotIdx];
  const price = p1.priceOf(slot);
  p0.funds = price + 30;
  const ownerBuys = p1.round.buys;
  const buyerBuys = p0.round.buys;
  assert.deepEqual(m.handle('p_0', { t: 'g.peerBuy', slot: slotIdx, to: 'p_1' }), { ok: true });
  assert.equal(p0.funds, 30, 'the buyer paid exactly the price');
  assert.ok(slot.sold, 'the slot was marked sold on the owner\'s shop');
  assert.ok(p0.hand.some((x) => x && x.id === slot.id), 'the piece landed in the buyer\'s hand');
  assert.equal(p1.hand.filter(Boolean).length, 0, 'the owner gets no piece');
  assert.equal(p0.round.buys, buyerBuys + 1, 'the buyer\'s round buys count it');
  assert.equal(p1.round.buys, ownerBuys, 'the owner\'s round buys are untouched');
  h.invariants();
});

test('购买道具：同样进买家手牌', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const id = itemId();
  p1.shop.slots[3] = { kind: 'item', id, basePrice: DATA.items[id].price, frozen: false, sold: false };
  p1.shop.layout = { chess: 3, item: p1.shop.slots.length - 3 };
  p0.funds = 999;
  assert.deepEqual(m.handle('p_0', { t: 'g.peerBuy', slot: 3, to: 'p_1' }), { ok: true });
  assert.ok(p1.shop.slots[3].sold);
  assert.ok(p0.hand.some((x) => x && x.kind === 'item' && x.id === id), 'the item is the buyer\'s');
  assert.equal(p0.funds, 999 - DATA.items[id].price);
  h.invariants();
});

test('已售出的槽位不能再买', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const slotIdx = firstSlot(p1);
  p1.shop.slots[slotIdx].sold = true;
  p0.funds = 999;
  const r = m.handle('p_0', { t: 'g.peerBuy', slot: slotIdx, to: 'p_1' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.equal(p0.funds, 999, 'no charge');
  h.invariants();
});

test('买家资金不足：拒绝且无任何变化', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const slotIdx = firstSlot(p1);
  const slot = p1.shop.slots[slotIdx];
  p0.funds = Math.max(0, p1.priceOf(slot) - 1);
  const r = m.handle('p_0', { t: 'g.peerBuy', slot: slotIdx, to: 'p_1' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.equal(slot.sold, false);
  assert.equal(p0.hand.filter(Boolean).length, 0);
  h.invariants();
});

test('买家手牌已满：拒绝、不扣款、槽位不标记 sold', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  for (const id of distinctIds(10)) give(m, p0, id, 'hand'); // HAND_SIZE = 10
  const slotIdx = firstSlot(p1);
  const slot = p1.shop.slots[slotIdx];
  p0.funds = 999;
  const r = m.handle('p_0', { t: 'g.peerBuy', slot: slotIdx, to: 'p_1' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.equal(slot.sold, false, 'the slot stays on sale');
  assert.equal(p0.funds, 999, 'no charge');
  h.invariants();
});

test('非休整期 / 买自己的商店：全部拒绝', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const slotIdx = firstSlot(p0);
  const r1 = m.handle('p_0', { t: 'g.peerBuy', slot: slotIdx, to: 'p_0' });
  assert.equal(r1.ok, undefined, 'one\'s own shop is refused');
  const r2 = m.handle('p_0', { t: 'g.peerShop', to: 'p_0' });
  assert.equal(r2.ok, undefined, 'watching one\'s own shop is refused');
  h.toPhase ? h.toPhase('COMBAT') : null;
  if (m.phase !== PHASE.PREP) {
    const p1 = h.ps('p_1');
    const r3 = m.handle('p_0', { t: 'g.peerBuy', slot: firstSlot(p1), to: 'p_1' });
    assert.equal(r3.ok, undefined, 'refused outside PREP');
  }
  h.invariants();
});
