// 技能自动 MOD (public/mod/技能自动施放.js + server/match/player/skilltoggle.js + server/sim/battle/players.js)
// 的服务端逻辑测试：
//   * 协议白名单：g.setSkillAuto { on: boolean } 的合法 / 非法形状；
//   * g.setSkillAuto：写入本玩家的 noAutoSkill 开关、m.private.skillAuto 回显、反复切换；
//   * battleInput：开关开启时，该玩家所有干员单位带 unit.noAutoSkill = true，关闭时不带；
//   * 只影响设置它的玩家。
// 每条路径跑完引擎不变量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, DATA } from './harness.js';
import { validateC2S } from '../../shared/protocol.js';
import { legalTiles, placeClass } from '../../server/match/board.js';

/** Co-op match at PREP R1. */
function setup({ seed = 7 } = {}) {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 0, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

/** Give `chessId` to `ps` on the first free tile it may legally stand on. */
function placeOnBoard(m, ps, chessId) {
  const rec = m.gd.chess(chessId);
  const tiles = legalTiles(ps.deployMap(), placeClass(ps, rec));
  const free = tiles.find(([r, c]) => !ps.board.has(`${r},${c}`));
  assert.ok(free, `no free tile for ${chessId}`);
  return give(m, ps, chessId, 'board', free);
}

const normalIds = () => Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden && !c.isDiy).map((c) => c.chessId).sort();
/** The flag the server shows this player back (m.private). */
const privateAuto = (ps) => !!(ps.privateView().skillAuto);
const noAutoIn = (input, chessId) => !!(input.units || []).find((u) => u.chessId === chessId && u.noAutoSkill === true);

test('协议白名单：validateC2S 接受合法形状、拒绝非法形状', () => {
  assert.equal(validateC2S({ t: 'g.setSkillAuto', on: true }), null);
  assert.equal(validateC2S({ t: 'g.setSkillAuto', on: false }), null);
  assert.ok(validateC2S({ t: 'g.setSkillAuto', on: 1 }), 'not a boolean');
  assert.ok(validateC2S({ t: 'g.setSkillAuto', on: 'yes' }), 'not a boolean');
  assert.ok(validateC2S({ t: 'g.setSkillAuto' }), 'missing on');
  assert.ok(validateC2S({ t: 'g.setSkillAuto', on: null }), 'null is not a boolean');
});

test('g.setSkillAuto：写入开关，m.private.skillAuto 回显，可反复切换', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  assert.equal(p0.noAutoSkill, false, 'off by default');
  assert.equal(privateAuto(p0), false);

  assert.equal(m.handle('p_0', { t: 'g.setSkillAuto', on: true }).ok, true);
  assert.equal(p0.noAutoSkill, true, 'the flag is set');
  assert.equal(privateAuto(p0), true, 'the private view echoes what was applied');

  assert.equal(m.handle('p_0', { t: 'g.setSkillAuto', on: false }).ok, true);
  assert.equal(p0.noAutoSkill, false, 'toggled back off');
  assert.equal(privateAuto(p0), false);
  h.invariants();
});

test('battleInput：开关开启时该玩家所有干员带 unit.noAutoSkill，关闭时不带', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const base = normalIds()[0];
  const gold = Object.values(DATA.chess).find((c) => c.isGolden && c.baseId === base)?.chessId || null;
  assert.ok(gold, 'the operator has an elite variant');
  placeOnBoard(m, p0, base);
  if (gold) placeOnBoard(m, p0, gold);
  const other = normalIds()[1];
  placeOnBoard(m, p0, other);

  const before = p0.battleInput();
  assert.equal(noAutoIn(before, base), false, 'on by default');
  assert.equal(noAutoIn(before, gold), false);
  assert.equal(noAutoIn(before, other), false);

  assert.equal(m.handle('p_0', { t: 'g.setSkillAuto', on: true }).ok, true);
  const after = p0.battleInput();
  assert.equal(noAutoIn(after, base), true, 'the normal variant is flagged');
  assert.equal(noAutoIn(after, gold), true, '…and so is its elite (one flag covers both)');
  assert.equal(noAutoIn(after, other), true, 'every operator the player fields is covered');

  assert.equal(m.handle('p_0', { t: 'g.setSkillAuto', on: false }).ok, true);
  assert.equal(noAutoIn(p0.battleInput(), base), false, 'switching off clears it');
  h.invariants();
});

test('battleInput：只影响设置它的玩家', () => {
  const h = setup();
  const m = h.m;
  const p0 = h.ps('p_0');
  const p1 = h.ps('p_1');
  const base = normalIds()[0];
  placeOnBoard(m, p0, base);
  placeOnBoard(m, p1, base);
  assert.equal(m.handle('p_0', { t: 'g.setSkillAuto', on: true }).ok, true);
  assert.equal(noAutoIn(p0.battleInput(), base), true);
  assert.equal(noAutoIn(p1.battleInput(), base), false, 'the teammate keeps auto-casting');
  assert.equal(p1.noAutoSkill, false);
  h.invariants();
});
