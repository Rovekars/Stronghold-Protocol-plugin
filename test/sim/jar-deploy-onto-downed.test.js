// 盲盒·砸罐子：战斗中把一名干员部署到「被击倒（未主动撤离）干员」占着的格子——战斗侧 downOn 必须拦截。
// 这是用户 BUG「把待部署区干员拖到被击倒干员身上，结果那名干员变成了被击倒的那名」的根因：
// 战斗单位部署（_deploy）会被 downOn 拒绝，但棋子侧 _moveChessToBoard 没查 downOn，导致棋子落到该格却无战斗单位、被击倒干员倒地身位仍占着。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

const op = (id, stats = {}) => chessRec({ id, profession: 'WARRIOR', stats: { atk: 0, maxHp: 1000, def: 0, blockCnt: 0, cost: 12, respawnTime: 6, ...stats }, skill: null });

function jarBattle() {
  const h = makeBattle({
    defs: { chess: { t_a: op('t_a'), t_b: op('t_b') } },
    units: [{ chessId: 't_a', row: 9, col: 5 }, { chessId: 't_b', row: 9, col: 6 }],
    content: 'none', autoFinish: false, timeLimit: 120,
    flags: { dpInit: 99, dpPerSec: 1, dpMax: 99 },
  });
  h.step();
  h.b.getPlayer('p1').dp = 99;
  return h;
}

test('战斗侧：被击倒（未撤离）干员占着的格子，deployFromInput 必须返回 null（downOn 拦截）', () => {
  const h = jarBattle();
  const b = h.b;
  const a = h.unit('t_a');
  const aRow = a.tileR, aCol = a.tileC;
  assert.ok(a && a.alive, 'A 已部署存活');
  // 击倒 A（不撤离）：保留倒地身位 body
  b.kill(a);
  assert.ok(b.isDown(a), 'A 处于 isDown（倒地）');
  assert.equal(b.downOn(aRow, aCol), a, 'downOn 命中 A 的倒地身位');

  // 把 B 部署到 A 倒地的同一格：战斗侧必须拒绝（downOn 拦截）。
  // 注意：deployFromInput 在 _deploy 失败时会把单位对象先塞进 allyUnits 再置 removed（无害的残留），
  // 关键契约是「返回 null 且场上没有该 uid 的存活单位」。
  const dep = b.deployFromInput('p1', { chessId: 't_b', uid: 7777, row: aRow, col: aCol, dir: 'RIGHT', items: [] });
  assert.equal(dep, null, 'deployFromInput 落到被击倒干员占着的格子应返回 null（downOn 拦截）');
  assert.equal(b.allyUnits.find((u) => u.uid === 7777 && u.alive), undefined, '该格不应出现 B 的存活战斗单位');

  // 对照：部署到 A 旁边空格（9,7）应成功——证明拦截只针对倒地身位，不影响正常部署
  const ok = b.deployFromInput('p1', { chessId: 't_b', uid: 7778, row: 9, col: 7, dir: 'RIGHT', items: [] });
  assert.ok(ok, '部署到空格应成功');
  assert.equal(ok.tileR, 9); assert.equal(ok.tileC, 7);
  assert.ok(h.invariants(), '战斗不变量成立');
});

test('战斗侧：主动撤离（retreatDown，benched）后该格不再拦截——可被他人部署', () => {
  const h = jarBattle();
  const b = h.b;
  const a = h.unit('t_a');
  const aRow = a.tileR, aCol = a.tileC;
  b.kill(a);
  assert.ok(b.isDown(a), 'A 倒地');
  assert.equal(b.retreatToBench('p1', a.uid), true, '主动撤离成功');
  assert.equal(a.removed, true, 'A 已从战场移除（benched）');
  assert.ok(!b.isDown(a), 'A 不再处于场上倒地');
  assert.equal(b.downOn(aRow, aCol), null, '撤离后该格不再有倒地身位');
  // 撤离后该格可正常部署（倒计时在整备区走，格子上没身位了）
  const dep = b.deployFromInput('p1', { chessId: 't_b', uid: 7788, row: aRow, col: aCol, dir: 'RIGHT', items: [] });
  assert.ok(dep, '撤离后该格可部署');
  assert.equal(dep.tileR, aRow); assert.equal(dep.tileC, aCol);
  assert.ok(h.invariants(), '战斗不变量成立');
});
