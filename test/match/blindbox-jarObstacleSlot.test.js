// 盲盒·砸罐子（jar）障碍物 BUG 回归：
//   ① 罐子会出现在障碍物上 —— generateJars 现在把「已持久部署的障碍物格」也视为占格，罐子不再刷在障碍物上；
//      例外：冻结读档恢复那一波（st.jarPendingSmash 待消费）不剔除，保证存档原样还原、已砸开数量精确恢复。
//   ② 障碍物要在待部署区「独占一个格子」——把最左侧 K 个整备格划给未部署障碍物（K=未部署数），
//      该清单随私有视图下发（jarShop.reservedSlots），客户端据此把障碍物投影到这些格、铺满格底板，
//      使障碍物与道具不共享同一格（道具按右→左填充，天然先占右侧）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { __jarReservedTest } from '../../public/mod/盲盒模式.js';

// MOD 顶层 createBattleFromSpec 包装 import 是异步的；直接调用不依赖包装时序
await new Promise((r) => setImmediate(r));

const jar = (h) => {
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};

const st0 = (h) => h.m.mods.blindbox;

// ---- BUG ①：罐子不刷在障碍物上 ---------------------------------------------------------------------------

test('罐子不刷在已部署障碍物上（读档恢复波除外）：剔除障碍格，恢复波保留原布局', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1); // enterPrep → generateJars
  const st = m.mods.blindbox;
  const jars0 = st.jars.p_0;
  assert.ok(jars0.length > 0, '首波有罐子');
  // 取一个当前有罐子的格，把它设为已部署障碍物
  const target = jars0[0];
  st.jarObstacles.p_0 = [{ tier: 'basic', row: target.row, col: target.col }];
  // 重新生成（非读档恢复）：该格应被剔除，罐子不再落在障碍物上
  st.generate();
  const jars1 = st.jars.p_0;
  assert.ok(!jars1.some((j) => j.row === target.row && j.col === target.col), '罐子不再刷在障碍物所在格');
  assert.equal(jars1.length, jars0.length - 1, '剔除的正好是障碍那一格');
  // 读档恢复波（st.jarPendingSmash 待消费）：保留原布局（存档里罐子可能正落在障碍格上）
  st.jarPendingSmash.p_0 = new Set([`${target.row},${target.col}`]);
  st.generate();
  const jars2 = st.jars.p_0;
  assert.ok(jars2.some((j) => j.row === target.row && j.col === target.col), '读档恢复波保留原布局（含障碍格上的罐）');
  assert.equal(jars2.length, jars0.length, '读档恢复波罐数与原布局一致');
  h.invariants();
});

// ---- BUG ②：障碍物在待部署区独占一个格子 -------------------------------------------------------------------

test('障碍物划用待部署区最左侧 K 格（K=未部署数），私有视图下发 reservedSlots', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  // 未购 → 无独占格
  assert.deepEqual(__jarReservedTest.reservedSlots(m, ps), [], '未购障碍物：无独占格');
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }); // 未部署初级 1
  assert.deepEqual(__jarReservedTest.reservedSlots(m, ps), [0], '未部署 1 → 划用最左 1 格');
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleAdvanced' }); // 未部署高级 1
  assert.deepEqual(__jarReservedTest.reservedSlots(m, ps), [0, 1], '未部署 2 → 划用最左 2 格');
  // 部署 1 个（持久记录 +1）→ 未部署减 1 → 独占格回到 1
  st0(h).jarObstacles.p_0 = [{ tier: 'basic', row: 9, col: 5 }];
  assert.deepEqual(__jarReservedTest.reservedSlots(m, ps), [0], '部署 1 个后未部署 -1 → 独占格回到 1');
  // 私有视图下发 reservedSlots（客户端据此把障碍物投影到独占格）
  const js = ps.privateView().jarShop;
  assert.deepEqual(js.reservedSlots, [0], '私有视图 jarShop.reservedSlots 同步');
  h.invariants();
});
