// jar 模式战斗中装备替换（2026-10-16）：battle.replaceItem 把 u.items 里的旧装备换成新装备，
// 并 dispose 旧装备的 battle grant（否则旧属性加成残留在战斗单位上）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { itemGrants } from '../../server/sim/content/items/battle.js';

const HAMMER = 'chess_item_1_01_e_a'; // 维式重锤 攻击力+15%
const BLADE = 'chess_item_3_07_e_a';  // 阿戈尔重刃 攻击力+40%
const SHIELD = 'chess_item_1_02_e_a'; // 坚守盾牌 防御力加成

test('battle.replaceItem：替换 u.items + dispose 旧装备 grant', () => {
  const defs = { chess: { s_op: chessRec({ id: 's_op', bonds: [], profession: 'SNIPER', skill: null }) } };
  const h = makeBattle({
    defs,
    units: [{ chessId: 's_op', row: 10, col: 3, uid: 101, items: [HAMMER, BLADE] }],
    autoFinish: false,
  });
  const u = h.unit(101);
  assert.ok(u, '干员单位已部署');
  h.run(1); // 首帧 tick 完成部署（u.alive 置真）
  assert.ok(u.alive, '干员已上场');
  assert.deepEqual([...u.items].sort(), [BLADE, HAMMER].sort(), '初始穿 2 件（部署时 install）');
  // 初始 grant：两件都有
  const g0 = itemGrants(h.battle, u).map((g) => g.id);
  assert.ok(g0.includes(HAMMER) && g0.includes(BLADE), '初始两件装备的 grant 都在');
  // 替换：HAMMER → SHIELD
  const ok = h.battle.replaceItem('p1', 101, SHIELD, HAMMER);
  assert.equal(ok, true, 'replaceItem 生效');
  assert.ok(u.items.includes(SHIELD), '新装备 id 已加入 u.items');
  assert.ok(!u.items.includes(HAMMER), '被替换装备 id 已从 u.items 移除');
  assert.ok(u.items.includes(BLADE), '未替换的装备保留');
  // 旧 grant 已 dispose、新 grant 已装
  const g1 = itemGrants(h.battle, u).map((g) => g.id);
  assert.ok(!g1.includes(HAMMER), '被替换装备的 battle grant 已退装（旧属性不再残留）');
  assert.ok(g1.includes(SHIELD), '新装备的 battle grant 已装上');
  assert.ok(g1.includes(BLADE), '未替换装备的 grant 保留');
  h.invariants();
});

test('battle.replaceItem：不存在的 removeId 只加不删（幂等安全）', () => {
  const defs = { chess: { s_op: chessRec({ id: 's_op', bonds: [], profession: 'SNIPER', skill: null }) } };
  const h = makeBattle({
    defs,
    units: [{ chessId: 's_op', row: 10, col: 3, uid: 102, items: [HAMMER] }],
    autoFinish: false,
  });
  const u = h.unit(102);
  h.run(1);
  assert.ok(u.alive, '干员已上场');
  const ok = h.battle.replaceItem('p1', 102, SHIELD, 'chess_item_9_99_e_a');
  assert.equal(ok, true, 'removeId 不存在时仍然加新装备');
  assert.deepEqual([...u.items].sort(), [HAMMER, SHIELD].sort(), 'items = 原 + 新');
  h.invariants();
});
