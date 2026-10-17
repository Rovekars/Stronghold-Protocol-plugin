// 盲盒·砸罐子（jar）：待部署区被塞满时，「主动撤离」仍要成立（用户 2026-10-13）。
// 现象：jar 全程战斗，掉落把 10 个待部署槽占满 → retreatSlot() 返回 null → 客户端直接弹「整备区已满」，
// 被击倒的干员撤不下来。修复：jar 战斗中允许溢出到「临时手牌区」（原生 stow 的溢出语义），
// 由 MOD 的 ps.move 包装拦截 to.area === 'temp' 处理，并把 _tempDue 推远，避免下一次 endPrep 的
// resolveTemp 把还在倒计时的干员自动卖掉；待部署区一有空位由 _fillHandFromTemp 自动回流。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';
import { PHASE } from '../../shared/constants.js';

const IDS = chessOfTier(1);
let n = 0;
const chessId = () => IDS[n++ % IDS.length];

function jarCombatMatch() {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 11 }).start();
  h.toPrep(1);
  const m = h.m;
  m.mods.blindbox = { mode: 'jar', blindScout: {}, jars: {} };
  m.phase = PHASE.COMBAT;
  return h;
}

/** 把待部署区（hand）塞满，返回最后放入的棋子。 */
function fillHand(m, ps, n = ps.hand.length) {
  let last = null;
  for (let i = 0; i < n; i++) last = give(m, ps, chessId(), 'hand');
  return last;
}

test('整备区已满：jar 战斗中撤离溢出到临时手牌区（不再报 HAND_FULL）', () => {
  const h = jarCombatMatch();
  const m = h.m;
  const ps = h.ps('p_0');
  fillHand(m, ps);
  assert.equal(ps.hand.filter(Boolean).length, ps.hand.length, '待部署区确实满了');
  const tile = legalTileFor(m, ps, chessId());
  assert.ok(tile, '有合法落点');
  const piece = give(m, ps, chessId(), 'board', tile);
  const res = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'temp', idx: 0 } });
  assert.deepEqual(res, { ok: true }, '满仓撤离不再失败');
  assert.equal(ps.board.size, 0, '干员离开了棋盘');
  assert.equal(ps.temp[0] && ps.temp[0].uid, piece.uid, '落进了临时手牌区');
});

test('整备区已满的溢出棋子不会被 endPrep 的 resolveTemp 自动卖掉（倒计时未走完）', () => {
  const h = jarCombatMatch();
  const m = h.m;
  const ps = h.ps('p_0');
  fillHand(m, ps);
  const tile = legalTileFor(m, ps, chessId());
  const piece = give(m, ps, chessId(), 'board', tile);
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'temp', idx: 0 } }), { ok: true });
  // 模拟撤离时的再部署倒计时（battle 侧挂上的 respawnAt）
  piece.respawnAt = 999;
  ps.resolveTemp(); // 原生：到期的临时区干员会被「卖回」
  assert.equal(ps.temp[0] && ps.temp[0].uid, piece.uid, '还在倒计时的干员必须留在临时手牌区，不能被卖掉');
});

test('临时手牌区的干员会在待部署区腾出空位后自动回流', () => {
  const h = jarCombatMatch();
  const m = h.m;
  const ps = h.ps('p_0');
  fillHand(m, ps);
  const tile = legalTileFor(m, ps, chessId());
  const piece = give(m, ps, chessId(), 'board', tile);
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'temp', idx: 0 } }), { ok: true });
  assert.equal(ps.temp[0] && ps.temp[0].uid, piece.uid);
  ps.hand[0] = null; // 腾出一个待部署槽
  ps.recompute();
  assert.equal(ps.temp[0], null, '临时手牌区已清空');
  assert.ok(ps.hand.some((p) => p && p.uid === piece.uid), '干员回流进了待部署区');
});

test('非 jar / 非战斗时 to.area === temp 仍被核心拒绝（不误改原生行为）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 11 }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  const piece = give(m, ps, chessId(), 'board', legalTileFor(m, ps, chessId()));
  const res = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'temp', idx: 0 } });
  assert.notEqual(res && res.ok, true, '原生核心不接受 temp 目标');
  assert.equal(ps.board.size, 1, '棋子仍在棋盘上');
});
