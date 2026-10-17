// 赠送道具/干员 MOD (public/mod/赠送与求购.js + server/match/player/gift.js) 的服务端逻辑测试：
//   * 人类→AI：AI 无客户端，服务器立即自动接收（转账 + m.giftResolved accepted:true）；
//   * 每回合限一次（发起即消耗，AI 与人类路径一致；下一回合重置）；
//   * 人类→人类：offer / 接收 / 拒绝 / 二次赠送被拒；
//   * 对方整备区（手牌）已满时无法赠送；
//   * 每条路径跑完引擎不变量（invariants）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, DATA } from './harness.js';

/** Co-op match at PREP R1. */
function setup({ humans = 1, bots = 1, seed = 41 } = {}) {
  const h = makeMatch({ mode: 'coop', humans, bots, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

const anyChessId = () => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden).map((c) => c.chessId).sort()[0];
/** n distinct visible normal chess ids (a hand full of the SAME chess would trip the merge invariant). */
const distinctIds = (n) => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden).map((c) => c.chessId).sort().slice(0, n);
/** giftResolved is broadcast: the harness records broadcasts in h.bc (unicasts in h.sent). */
const resolutions = (h) => h.bc.filter((x) => x.t === 'm.giftResolved');

test('人类 → AI：立即自动接收，棋子转移，广播 m.giftResolved accepted:true', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), ai = h.ps('ai_0');
  const piece = give(m, p0, anyChessId(), 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'ai_0' }), { ok: true });
  assert.equal(p0.find(piece.uid), null, 'left the sender');
  assert.ok(ai.find(piece.uid), 'the AI holds it now');
  assert.equal(p0.round.gifts, 1, 'once-per-round consumed');
  const resolved = resolutions(h);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].accepted, true);
  assert.equal(resolved[0].name, DATA.chess[piece.id].name);
  assert.equal(h.allTo('ai_0', 'm.giftOffer').length, 0, 'a bot is never asked');
  h.invariants();
});

test('每回合限一次：同一回合第二笔被拒（AI 与人类路径都一样），下一回合重置', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const a = give(m, p0, anyChessId(), 'hand');
  const b = give(m, p0, anyChessId(), 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: a.uid, to: 'ai_0' }), { ok: true });
  const second = m.handle('p_0', { t: 'g.gift', uid: b.uid, to: 'ai_0' });
  assert.equal(second.ok, undefined, 'rejected');
  h.toPrep(2);
  assert.equal(p0.round.gifts, 0, 'reset at the round start');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: b.uid, to: 'ai_0' }), { ok: true });
  h.invariants();
});

test('人类 → 人类：offer 推送、接收转账、同回合二次赠送被拒', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const piece = give(m, p0, anyChessId(), 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'p_1' }), { ok: true });
  assert.ok(p0.find(piece.uid), 'NOT detached on offer (kept until accept)');
  const offers = h.allTo('p_1', 'm.giftOffer');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].uid, piece.uid);
  const second = m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'p_1' });
  assert.equal(second.ok, undefined, 'the sender already gifted this round');
  assert.deepEqual(m.handle('p_1', { t: 'g.giftReply', accept: true }), { ok: true });
  assert.equal(p0.find(piece.uid), null);
  assert.ok(p1.find(piece.uid), 'transferred on accept');
  h.invariants();
});

test('人类 → 人类：拒绝后棋子留在赠送者处，可回退', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const piece = give(m, p0, anyChessId(), 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'p_1' }), { ok: true });
  assert.deepEqual(m.handle('p_1', { t: 'g.giftReply', accept: false }), { ok: true });
  assert.ok(p0.find(piece.uid), 'stays with the sender');
  assert.equal(p1.find(piece.uid), null);
  const resolved = resolutions(h);
  assert.equal(resolved[resolved.length - 1].accepted, false);
  h.invariants();
});

test('对方整备区已满：无法赠送（人类路径，offer 也不创建）', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  for (const id of distinctIds(10)) give(m, p1, id, 'hand'); // HAND_SIZE = 10
  const piece = give(m, p0, anyChessId(), 'hand');
  const r = m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'p_1' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.equal(p0.round.gifts, 0, 'the once-per-round is not consumed on a failed gift');
  assert.equal(h.allTo('p_1', 'm.giftOffer').length, 0, 'no offer was created');
  h.invariants();
});

test('AI 整备区已满：同样拒绝且不消耗次数', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), ai = h.ps('ai_0');
  for (const id of distinctIds(10)) give(m, ai, id, 'hand');
  const piece = give(m, p0, anyChessId(), 'hand');
  const r = m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'ai_0' });
  assert.equal(r.ok, undefined, 'rejected');
  assert.ok(p0.find(piece.uid), 'kept by the sender');
  assert.equal(p0.round.gifts, 0);
  h.invariants();
});

// the immediate-merge rule (invariants.js "merges are immediate") applies to gifted copies too: a gift that completes
// a set must merge exactly like acquireChess (fuzz 2026-10-09: a bot that accepted a third copy by gift kept 3 normals)
const mergeableChess = (m) => {
  for (const c of Object.values(DATA.chess)) {
    if (!c.visible || c.isGolden) continue;
    const need = m.gd.mergeCount(c.chessId);
    if (need > 1 && m.gd.goldenIdOf(c.chessId)) return c.chessId;
  }
  throw new Error('no mergeable chess in DATA');
};

test('人类 → AI：收礼凑齐第三份 → 立即合并成精锐（不是 3 份普通副本）', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0'), ai = h.ps('ai_0');
  const id = mergeableChess(m);
  give(m, ai, id, 'hand');
  give(m, ai, id, 'hand');
  const piece = give(m, p0, id, 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'ai_0' }), { ok: true });
  const base = m.gd.baseIdOf(id);
  const golden = m.gd.goldenIdOf(base);
  let normals = 0, elites = 0;
  for (const loc of ai.temp.concat(ai.hand)) if (loc && loc.kind === 'chess') {
    if (!m.gd.isGolden(loc.id) && m.gd.baseIdOf(loc.id) === base) normals++;
    if (loc.id === golden) elites++;
  }
  assert.equal(normals, 0, `the third copy merged (no normal ${base} left)`);
  assert.equal(elites, 1, `the elite ${golden} is in the AI's hand/temp`);
  h.invariants();
});

test('人类 → 人类：accept 时凑齐第三份 → 收件方立即合并', () => {
  const h = setup({ humans: 2, bots: 0 });
  const m = h.m;
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const id = mergeableChess(m);
  give(m, p1, id, 'hand');
  give(m, p1, id, 'hand');
  const piece = give(m, p0, id, 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.gift', uid: piece.uid, to: 'p_1' }), { ok: true });
  assert.deepEqual(m.handle('p_1', { t: 'g.giftReply', accept: true }), { ok: true });
  const base = m.gd.baseIdOf(id);
  const golden = m.gd.goldenIdOf(base);
  let normals = 0, elites = 0;
  for (const loc of p1.temp.concat(p1.hand)) if (loc && loc.kind === 'chess') {
    if (!m.gd.isGolden(loc.id) && m.gd.baseIdOf(loc.id) === base) normals++;
    if (loc.id === golden) elites++;
  }
  assert.equal(normals, 0, `the third copy merged (no normal ${base} left)`);
  assert.equal(elites, 1, `the elite ${golden} is in p_1's hand/temp`);
  h.invariants();
});
