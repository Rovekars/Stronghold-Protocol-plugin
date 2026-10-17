// 求购（队友代购）MOD (public/mod/赠送与求购.js 求购页 + server/match/player/buyreq.js) 的服务端逻辑测试：
//   * 人类→AI：AI 资金够则立即代付购买（棋子进请求者手牌，AI 扣钱，槽位 sold）；
//   * AI 资金不够：拒绝且无任何变化；
//   * 人类→人类：offer 推送 → 接收（代付转账）/ 拒绝；
//   * 中途刷新商店（槽位商品已更换）：接收时代购取消，不扣款；
//   * 同一请求者同时只能有一笔 pending；请求者手牌满时发起即拒；
//   * 每条路径跑完引擎不变量（invariants）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, DATA } from './harness.js';

/** Co-op match at PREP R1. */
function setup({ humans = 1, bots = 1, seed = 43 } = {}) {
  const h = makeMatch({ mode: 'coop', humans, bots, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

const distinctIds = (n) => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden).map((c) => c.chessId).sort().slice(0, n);
/** buyReqResolved is broadcast: the harness records broadcasts in h.bc (unicasts in h.sent). */
const resolutions = (h) => h.bc.filter((x) => x.t === 'm.buyReqResolved');
/** p's first unsold shop slot index (null when the roll came up empty). */
const firstSlot = (p) => p.shop.slots.findIndex((s) => s && !s.sold);

test('人类 → AI：AI 资金足够时立即代付，棋子进请求者手牌，槽位 sold', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), ai = h.ps('ai_0');
  const slotIdx = firstSlot(p0);
  assert.ok(slotIdx >= 0, 'the shop rolled at least one card');
  const slot = p0.shop.slots[slotIdx];
  const price = p0.priceOf(slot);
  const before = ai.funds;
  ai.funds = price + 50;
  assert.deepEqual(m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'ai_0' }), { ok: true });
  assert.ok(slot.sold, 'the slot was purchased');
  assert.equal(ai.funds, 50, 'the AI paid exactly the price');
  assert.ok(p0.hand.some((x) => x && x.id === slot.id), 'the piece landed in the requester hand');
  assert.equal(h.allTo('ai_0', 'm.buyReqOffer').length, 0, 'a bot is never asked');
  const resolved = resolutions(h);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].accepted, true);
  assert.equal(resolved[0].price, price);
  h.invariants();
});

test('人类 → AI：AI 资金不足 → 拒绝且无变化', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), ai = h.ps('ai_0');
  const slotIdx = firstSlot(p0);
  const slot = p0.shop.slots[slotIdx];
  ai.funds = Math.max(0, p0.priceOf(slot) - 1);
  p0.funds = 0;
  const r = m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'ai_0' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.equal(slot.sold, false);
  assert.equal(p0.hand.filter(Boolean).length, 0);
  assert.equal(resolutions(h).length, 0);
  h.invariants();
});

test('人类 → 人类：offer 推送 → 接收：代付者扣钱、请求者获得棋子', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const slotIdx = firstSlot(p0);
  const slot = p0.shop.slots[slotIdx];
  const price = p0.priceOf(slot);
  p0.funds = 0; // the whole point: the requester cannot afford it
  p1.funds = price + 10;
  assert.deepEqual(m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_1' }), { ok: true });
  const offers = h.allTo('p_1', 'm.buyReqOffer');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].price, price);
  assert.equal(slot.sold, false, 'nothing was charged on offer');
  assert.deepEqual(m.handle('p_1', { t: 'g.buyReqReply', accept: true }), { ok: true });
  assert.equal(p1.funds, 10, 'the payer covered the price');
  assert.equal(p0.funds, 0, 'the requester paid nothing');
  assert.ok(slot.sold);
  assert.ok(p0.hand.some((x) => x && x.id === slot.id), 'the piece is the requester\'s');
  assert.equal(p1.hand.filter(Boolean).length, 0, 'the payer gets no piece');
  const resolved = resolutions(h);
  assert.equal(resolved[resolved.length - 1].accepted, true);
  h.invariants();
});

test('人类 → 人类：拒绝后无任何变化，pending 清空可再次请求', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const slotIdx = firstSlot(p0);
  const slot = p0.shop.slots[slotIdx];
  p0.funds = 0;
  p1.funds = 999;
  assert.deepEqual(m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_1' }), { ok: true });
  assert.deepEqual(m.handle('p_1', { t: 'g.buyReqReply', accept: false }), { ok: true });
  assert.equal(slot.sold, false);
  assert.equal(p0.hand.filter(Boolean).length, 0);
  assert.equal(resolutions(h)[resolutions(h).length - 1].accepted, false);
  assert.deepEqual(m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_1' }), { ok: true }, 'the cleared pending allows a new request');
  h.invariants();
});

test('中途商品更换（槽位已变）：接收时代购取消，不扣款', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const slotIdx = firstSlot(p0);
  const slot = p0.shop.slots[slotIdx];
  p0.funds = 0;
  p1.funds = 999;
  assert.deepEqual(m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_1' }), { ok: true });
  // a refresh rerolls the slot (a coincidental re-roll of the same card is legitimately still acceptable, so force an
  // unambiguous change: the card is gone)
  p0.refresh();
  p0.shop.slots[slotIdx] = null;
  const r = m.handle('p_1', { t: 'g.buyReqReply', accept: true });
  assert.equal(r.ok, undefined, 'the accept is refused');
  assert.equal(p1.funds, 999, 'the payer was not charged');
  const resolved = resolutions(h);
  assert.equal(resolved[resolved.length - 1].accepted, false, 'the resolution is still broadcast');
  h.invariants();
});

test('并发限制：同一请求者已有 pending 时再次请求被拒', () => {
  const h = setup({ humans: 3, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0');
  const slotIdx = firstSlot(p0);
  p0.funds = 0;
  assert.deepEqual(m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_1' }), { ok: true });
  const r = m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_2' });
  assert.equal(r.ok, undefined, 'one pending request at a time');
  assert.equal(h.allTo('p_2', 'm.buyReqOffer').length, 0);
  h.invariants();
});

test('请求者手牌已满：发起即拒（offer 也不创建）', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  for (const id of distinctIds(10)) give(m, p0, id, 'hand'); // HAND_SIZE = 10
  p0.funds = 0;
  const slotIdx = firstSlot(p0);
  const r = m.handle('p_0', { t: 'g.buyReq', slot: slotIdx, to: 'p_1' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.equal(h.allTo('p_1', 'm.buyReqOffer').length, 0, 'no offer was created');
  h.invariants();
});
