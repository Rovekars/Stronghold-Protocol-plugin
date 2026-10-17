// 永续技能（"持续时间无限" ⇒ kind 'toggle'）跨战斗延续：
//   ① 引擎：carryState.skillEndless 让上一场结束时仍在生效的永续技能在新战斗里直接开着（免费，不再吃技力）；
//   ② 引擎：战斗结果 unitsEnd 上报 skillEndless（只有永续技能为 true，普通持续技能不算）；
//   ③ 接线：盲盒·砸罐子（jar）在 battleInput 里按上场结果注入该 carry（其余模式不带）。
// 需求：jar 模式每一波都是一场新战斗，回合更换默认把技能重置成关着 —— 玩家开的永续技能不该因此白开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

/** 一个「持续时间无限」的永续技能干员（generic.js genericKind: sk.kind 直接决定 kind）。 */
const endlessOp = (o = {}) => chessRec({
  id: 't_endless',
  profession: 'WARRIOR',
  stats: { atk: 100, maxHp: 5000, blockCnt: 2 },
  skill: { kind: 'toggle', duration: -1, spType: 'INCREASE_WITH_TIME', spCost: 5, initSp: 0, maxChargeTime: 1, trigger: { rule: 'NEVER' }, ...o.skill },
  ...o,
});
/** 同一个干员的普通持续技能版（duration > 0）—— 不参与永续延续。 */
const timedOp = (o = {}) => chessRec({
  id: 't_timed',
  profession: 'WARRIOR',
  stats: { atk: 100, maxHp: 5000, blockCnt: 2 },
  skill: { kind: 'duration', duration: 10, spType: 'INCREASE_WITH_TIME', spCost: 5, initSp: 0, maxChargeTime: 1, trigger: { rule: 'NEVER' }, ...o.skill },
  ...o,
});

const battle = (units) => makeBattle({
  // 默认 content（generic kit）才会把记录的 skill.kind 装成技能：content 'none' 下干员没有技能
  defs: { chess: { t_endless: endlessOp(), t_timed: timedOp() } },
  players: [{ playerId: 'A', seat: 0, side: 'L', colOffset: 0, units }],
  enemies: [],
});

test('永续技能：carryState.skillEndless 让它在新战斗里直接开着（不再吃技力）', () => {
  const h = battle([
    { uid: 11, chessId: 't_endless', row: 9, col: 4, carryState: { skillEndless: true } },
    { uid: 12, chessId: 't_endless', row: 9, col: 5 }, // 对照组：没有 carry
  ]);
  h.step();
  const carried = h.b.allyUnits.find((u) => u.uid === 11);
  const plain = h.b.allyUnits.find((u) => u.uid === 12);
  assert.equal(carried.skill.kind, 'toggle', '夹具确实是永续技能');
  assert.equal(carried.skill.active, true, '带 carry 的永续技能一进场就是开着的');
  assert.ok(carried.skill.timeLeft === Infinity || !Number.isFinite(carried.skill.timeLeft), '永续：没有倒计时（不会自己结束）');
  assert.equal(plain.skill.active, false, '没有 carry 的干员照常从关着开始');
  assert.equal(plain.skill.activations, 0, '没有 carry 的干员技能一次都没开过');
  assert.equal(plain.skill.kind, 'toggle');
});

test('永续技能：延续不消耗技力（上一场已经付过）', () => {
  const h = battle([{ uid: 11, chessId: 't_endless', row: 9, col: 4, carryState: { skillEndless: true } }]);
  h.step();
  const u = h.b.allyUnits.find((x) => x.uid === 11);
  assert.equal(u.skill.active, true);
  assert.equal(u.skill.sp, 0, '免费激活：技力没有被记成充能后再扣');
  assert.equal(u.skill.charges, 0);
});

test('永续技能：普通持续技能不吃这条 carry（只有 toggle 才续）', () => {
  const h = battle([{ uid: 21, chessId: 't_timed', row: 9, col: 4, carryState: { skillEndless: true } }]);
  h.step();
  const u = h.b.allyUnits.find((x) => x.uid === 21);
  assert.equal(u.skill.kind, 'duration');
  assert.equal(u.skill.active, false, '持续技能不跨战斗延续（回合更换照常重置）');
});

test('战斗结果：unitsEnd 只给仍在生效的永续技能报 skillEndless', () => {
  const h = battle([
    { uid: 11, chessId: 't_endless', row: 9, col: 4 },
    { uid: 21, chessId: 't_timed', row: 9, col: 5 },
  ]);
  h.step();
  const endless = h.b.allyUnits.find((u) => u.uid === 11);
  const timed = h.b.allyUnits.find((u) => u.uid === 21);
  assert.equal(endless.skill.active, false);
  assert.equal(timed.skill.active, false);
  assert.ok(endless.skill.activate('manual', { free: true }), '手动开一次永续技能');
  assert.ok(timed.skill.activate('manual', { free: true }), '手动开一次持续技能');
  h.b.forceEnd('timeout');
  const end = h.result().perPlayer.A.unitsEnd;
  const e1 = end.find((u) => u.uid === 11);
  const e2 = end.find((u) => u.uid === 21);
  assert.equal(e1.skillEndless, true, '仍在生效的永续技能上报 skillEndless');
  assert.equal(e1.skillActive, true);
  assert.equal(e2.skillEndless, false, '持续技能不是永续');
  assert.equal(e2.skillActive, true);
});

test('战斗结果：没开技能 / 已阵亡的干员不上报 skillEndless', () => {
  const h = battle([
    { uid: 11, chessId: 't_endless', row: 9, col: 4 },
    { uid: 12, chessId: 't_endless', row: 9, col: 5 },
  ]);
  h.step();
  const on = h.b.allyUnits.find((u) => u.uid === 11);
  const off = h.b.allyUnits.find((u) => u.uid === 12);
  assert.ok(on.skill.activate('manual', { free: true }));
  h.b.kill(off);
  h.b.forceEnd('timeout');
  const end = h.result().perPlayer.A.unitsEnd;
  assert.equal(end.find((u) => u.uid === 11).skillEndless, true, '开着的永续技能');
  assert.equal(end.find((u) => u.uid === 12).skillEndless, false, '没开的就是 false');
  assert.equal(end.find((u) => u.uid === 12).alive, false, '阵亡的干员 alive=false（jar 侧据此不续）');
});
