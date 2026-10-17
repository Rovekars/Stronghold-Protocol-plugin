// 技能自动 MOD 的战斗侧测试：battle input 的 `noAutoSkill` 让该单位的 manual 技能不再自动释放——
// 但仍照常攒技力、保持就绪，特性 / 天赋 / 模组 / 数值 / 普攻全部照旧（只有「自动开技能」被关掉）。
//   * unit.noAutoSkill → SkillRuntime.noAuto = true → 三种自动施放路径（update / onAboutToAttack / onDamaged）被抑制；
//   * 对照：同样布阵、同样敌人，开启自动的一方会释放，关闭的一方整场 0 次；
//   * 关闭不影响基础数值与 kit（天赋 / 特性 / 普攻照常）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';

const dummy = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e8, atk: 0, speed: 0, ...o });
const CHESS = 'chess_char_1_01_a'; // 芬 (术师)：默认触发、manual 技能，会反复自动释放

/** One field: the operator at (10,3), a slow dummy in its range, 90 s of combat. */
function run(noAuto) {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: CHESS, row: 10, col: 3, ...(noAuto ? { noAutoSkill: true } : null) }],
    timeLimit: 120, autoFinish: false,
  });
  h.step();
  const u = h.unit(CHESS);
  h.spawn('enemy_dummy', { pos: [10, 5] });
  h.run(90);
  return { h, u };
}

test('unit.noAutoSkill → manual 技能不再自动释放，但照常攒技力、普攻照旧', () => {
  const on = run(false);
  const off = run(true);

  assert.equal(!!off.u.skill.noAuto, true, 'switched off: the runtime is flagged noAuto');
  assert.equal(!!on.u.skill.noAuto, false, 'switched on: vanilla behaviour');

  // the skill still exists and charges SP (it is suppressed, not removed)
  assert.equal(off.u.skill.noSkill, false, 'the skill spec is intact (not a no-skill runtime)');
  assert.ok(off.u.spMax > 0, 'SP capacity is unchanged');
  assert.ok(off.u.skill.sp > 0, 'it still charges SP over time');

  assert.ok(on.u.skill.activations > 0, `the control casts (${on.u.skill.activations})`);
  assert.equal(off.u.skill.activations, 0, 'switched off: the manual skill never auto-casts');

  checkInvariants(on.h.b);
  checkInvariants(off.h.b);
});

test('关闭只关自动施放：基础数值、特性与天赋、普攻照常', () => {
  const on = run(false).u;
  const off = run(true).u;
  assert.equal(off.base.maxHp, on.base.maxHp);
  assert.equal(off.base.atk, on.base.atk);
  assert.deepEqual(off.rangeGrid, on.rangeGrid, 'the attack range is unchanged');
  assert.ok(off.kit && Object.keys(off.kit).length, 'its kit (trait / talents) is installed as usual');
  assert.ok(off.profile, 'its profession profile resolves');
  assert.ok(off.stats.attacks > 0, 'it still attacks normally');
  assert.ok(off.stats.dmg > 0, '…and deals its normal attack damage');
});
