// 盲盒·砸罐子（jar）：被击倒干员的「主动撤离到待部署区」（用户需求 2026-10-13）。
// 旧行为 retreatDown 把 respawnAt 置 Infinity → 干员永久消失（用户报告「无法主动撤回」：撤了就没了）。
// 新行为：进整备区后保留再部署倒计时（respawnAt 原样），不自动落回场上（removed 跳过 _checkRedeploys），
// 倒计时走完后由玩家从整备区手动再部署（deployFromInput 新建单位，旧单位留作 benched 记录）。
// 另覆盖：再部署后同一干员再次被击倒仍能撤离（allyUnits.find 须跳过旧的 removed 单位）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

const op = (id, stats = {}) => chessRec({ id, profession: 'WARRIOR', stats: { atk: 0, maxHp: 1000, def: 0, blockCnt: 0, cost: 12, respawnTime: 6, ...stats }, skill: null });
const downOf = (h, id) => (h.snapshot().down || []).find((d) => d[0] === id) || null;

function jarBattle() {
  const h = makeBattle({
    defs: { chess: { t_a: op('t_a') } },
    units: [{ chessId: 't_a', row: 9, col: 5 }],
    content: 'none', autoFinish: false, timeLimit: 120,
    flags: { dpInit: 99, dpPerSec: 1, dpMax: 99 },
  });
  h.step();
  h.b.getPlayer('p1').dp = 99; // DP 不构成约束：专测倒计时 / 自动再部署逻辑
  return h;
}

test('主动撤离被击倒干员：倒计时保留，进整备区后不自动回到场上，倒计时走完可手动再部署', () => {
  const h = jarBattle();
  const b = h.b;
  const u = h.unit('t_a');
  assert.ok(u && u.alive, '干员已部署');

  b.kill(u);
  assert.ok(b.isDown(u), '被击倒（isDown）');
  assert.ok(Number.isFinite(u.respawnAt), '有再部署倒计时');
  assert.ok(downOf(h, u.id), '快照 down 携带它');

  assert.equal(b.retreatToBench('p1', u.uid), true, 'retreatToBench 成功');
  assert.equal(u.removed, true, '已从战场移除（不再倒地占格）');
  assert.equal(u.benched, true, '标记 benched（整备区倒计时）');
  assert.equal(u.body, null, '倒地占格已释放');
  assert.ok(!b.isDown(u), '不再是场上倒地单位');
  assert.equal(downOf(h, u.id), null, '快照 down 不再携带它');

  // 倒计时保留：不被 retreatDown 抹成 Infinity
  assert.ok(Number.isFinite(u.respawnAt) && u.respawnAt > b.time, 'respawnAt 保留（倒计时继续走）');

  // 倒计时走完后：即使 DP 充足也不自动落回场上（由玩家从整备区手动再部署）
  u.respawnAt = b.time + 1; // 缩短等待（测机制而非该干员的再部署时长）
  h.run(2);
  assert.equal(u.alive, false, '倒计时结束后没有被自动部署回场上');
  assert.equal(u.removed, true, '仍保持 removed（等待玩家手动再部署）');

  // 生产路径手动再部署：deployFromInput 新建同 uid 单位
  const u2 = b.deployFromInput('p1', { chessId: 't_a', uid: u.uid, row: 10, col: 6 });
  assert.ok(u2, '再部署成功');
  assert.equal(u2.uid, u.uid, '同 uid（同一棋子）');
  assert.notEqual(u2.id, u.id, '新战斗单位 id');
  assert.equal(u2.alive, true, '再部署后存活');
  assert.ok(h.invariants(), '战斗不变量成立');
});

test('再部署后再次被击倒，仍能主动撤离（allyUnits 查找跳过旧的 removed 单位）', () => {
  const h = jarBattle();
  const b = h.b;
  const u = h.unit('t_a');
  b.kill(u);
  assert.equal(b.retreatToBench('p1', u.uid), true, '第一次撤离');
  u.respawnAt = b.time + 1;
  h.run(2);
  const u2 = b.deployFromInput('p1', { chessId: 't_a', uid: u.uid, row: 10, col: 6 });
  assert.ok(u2 && u2.alive, '再部署成功');

  b.kill(u2);
  assert.ok(b.isDown(u2), '第二次被击倒');
  assert.equal(b.retreatToBench('p1', u.uid), true, '第二次撤离成功（不会命中旧的 removed 单位而失败）');
  assert.equal(u2.removed, true, '当前单位已撤离');
  assert.equal(u2.benched, true, '当前单位标记 benched');
  assert.ok(h.invariants(), '战斗不变量成立');
});

test('存活干员的主动撤离仍是永久撤下（原行为不变，不误标 benched）', () => {
  const h = jarBattle();
  const b = h.b;
  const u = h.unit('t_a');
  assert.ok(u.alive);
  assert.equal(b.retreatToBench('p1', u.uid), true, '存活撤离成功');
  assert.equal(u.removed, true, '永久移除');
  assert.notEqual(u.benched, true, '不标 benched（不参与再部署倒计时门禁）');
  assert.ok(h.invariants(), '战斗不变量成立');
});
