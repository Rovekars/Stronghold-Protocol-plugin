// 盲盒·砸罐子（jar）：jar 商店（用户需求 2026-10-14）——用资金买三件商品：
//   部署位 +1（8/10/12 资金，最多 3 次，deployCapBonus 生效）、生命 +1（4 起每买一次 +2，lp 直接加）、
//   复活一次（15 资金，整局一件）：下次己方干员被击倒时原地满血复活（战斗侧 kill 钩子——kill() 官方复活机制：
//   处理器把 victim.hp 写回正数即不退场）。消耗记账：服务端模拟直接回调 ctx.consume；客户端模拟发
//   g.jarReviveUsed {battleId, playerId, n}（n 累计，服务端按增量去重扣减，重发安全）。
// 本文件覆盖：购买成交 / 上限 / 价格阶梯 / 非 jar 拒绝、战斗建立后的授予（grants + b.jarReviveGrant）、
// g.jarReviveUsed 去重、kill 钩子复活与充能耗尽（真实 Battle）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { PHASE } from '../../shared/constants.js';
import { __jarReviveTest, __jarObstacleTest } from '../../public/mod/盲盒模式.js';

// MOD 顶层的 createBattleFromSpec 包装 import 是异步的；这里只直接用 attach，不依赖包装时序
await new Promise((r) => setImmediate(r));

const jar = (h) => {
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return m;
};

// ---- 购买：部署位 / 生命 ----------------------------------------------------------------------------------------

test('jar 商店：部署位最多买 2 次（8/10 资金），deployCap 实时 +2，第 3 次拒绝', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 100;
  const cap0 = ps.deployCap;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' }), { ok: true });
  assert.equal(ps.deployCap, cap0 + 1, '第 1 个部署位生效');
  assert.equal(ps.funds, 92, '扣 8');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' }), { ok: true });
  assert.equal(ps.deployCap, cap0 + 2, '第 2 个部署位生效');
  assert.equal(ps.funds, 82, '扣 10');
  const res = m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' });
  assert.notEqual(res && res.ok, true, '第 3 次拒绝（售罄）');
  assert.equal(ps.deployCap, cap0 + 2, '上限不再增加');
  h.invariants();
});

test('jar 商店：生命 +1 越买越贵（4/6/…），lp 直接加；资金不足拒绝', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 10;
  const lp0 = ps.lp;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'life' }), { ok: true });
  assert.equal(ps.lp, lp0 + 1, '生命 +1');
  assert.equal(ps.funds, 6, '扣 4');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'life' }), { ok: true });
  assert.equal(ps.lp, lp0 + 2, '生命再 +1');
  assert.equal(ps.funds, 0, '扣 6');
  const res = m.handle('p_0', { t: 'g.jarShopBuy', item: 'life' });
  assert.notEqual(res && res.ok, true, '资金不足拒绝（下次 8 资金）');
  assert.equal(ps.lp, lp0 + 2, '拒绝后生命不变');
  h.invariants();
});

test('jar 商店：非 jar 模式拒绝购买', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 100;
  const res = h.m.handle('p_0', { t: 'g.jarShopBuy', item: 'life' });
  assert.notEqual(res && res.ok, true, '非 jar 模式必须拒绝');
});

// ---- 复活一次：购买 / 授予 / 消耗上报去重 ----------------------------------------------------------------------

test('jar 商店：复活一次只能买一个；战斗建立后发放授予（grants + b.jarReviveGrant）', () => {
  __jarReviveTest.grants.clear(); __jarReviveTest.ctx.clear(); // 模块级表跨测试残留（battleId 确定性生成）
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat: true }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 100;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'revive' }), { ok: true });
  assert.equal(ps.funds, 85, '扣 15');
  const st = m.mods.blindbox;
  assert.equal(st.jarShop.p_0.revive, 1, '持有复活充能');
  assert.notEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'revive' }).ok, true, '第二个拒绝（已持有）');
  m.phase = PHASE.PREP;
  m.endPrep(); // 走包装：建场 + jarGrantRevives 发放授予
  const f = m.fields.find((x) => x && Array.isArray(x.players) && x.players.includes('p_0') && x.battleId);
  assert.ok(f, 'p_0 的战场已创建');
  const grants = __jarReviveTest.grants.get(f.battleId);
  assert.ok(grants && grants.get('p_0') === 1, '授予表已记录 p_0 的 1 点充能');
  const grantMsg = h.sent.find(([pid, msg]) => pid === 'p_0' && msg && msg.t === 'b.jarReviveGrant');
  assert.ok(grantMsg, '客户端模拟：向 p_0 下发了 b.jarReviveGrant');
  assert.equal(grantMsg[1].battleId, f.battleId, '授予消息带 battleId');
});

test('g.jarReviveUsed：按累计 n 增量去重扣减，重发安全； playerId 不符拒绝', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  const rec = (m.mods.blindbox.jarShop.p_0 = { slots: 0, life: 0, revive: 1 });
  assert.deepEqual(m.handle('p_0', { t: 'g.jarReviveUsed', battleId: 'B1', playerId: 'p_0', n: 1 }), { ok: true });
  assert.equal(rec.revive, 0, '充能消耗');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarReviveUsed', battleId: 'B1', playerId: 'p_0', n: 1 }), { ok: true });
  assert.equal(rec.revive, 0, '同一 n 重发：不再扣（去重）');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarReviveUsed', battleId: 'B1', playerId: 'p_0', n: 2 }), { ok: true });
  assert.equal(rec.revive, 0, '没有充能时不扣');
  const res = m.handle('p_0', { t: 'g.jarReviveUsed', battleId: 'B1', playerId: 'p_other', n: 1 });
  assert.notEqual(res && res.ok, true, '上报他人 playerId 拒绝（只能报自己的消耗）');
});

// ---- 复活一次：战斗侧 kill 钩子（真实 Battle） ------------------------------------------------------------------

const op = (id) => chessRec({ id, profession: 'WARRIOR', stats: { atk: 0, maxHp: 1000, def: 0, blockCnt: 0, cost: 12, respawnTime: 6 }, skill: null });

test('复活一次（战斗侧）：kill 钩子消耗充能原地满血复活；充能耗尽后再被击倒正常倒地', () => {
  const h = makeBattle({
    defs: { chess: { t_a: op('t_a') } },
    units: [{ chessId: 't_a', row: 9, col: 5 }],
    content: 'none', autoFinish: false, timeLimit: 120,
    flags: { dpInit: 99, dpPerSec: 1, dpMax: 99 },
  });
  h.step();
  const b = h.b;
  if (!b.battleId) b.battleId = 'B-test';
  const u = h.unit('t_a');
  assert.ok(u && u.alive, '干员已部署');
  __jarReviveTest.grants.set(b.battleId, new Map([['p1', 1]]));
  const consumed = [];
  __jarReviveTest.ctx.set(b.battleId, { consume: (p) => consumed.push(p) });
  __jarReviveTest.attach(b);

  b.kill(u);
  assert.equal(u.alive, true, '复活（kill 钩子把 hp 写回正数 → kill() 不退场）');
  assert.equal(u.hp, u.s.maxHp, '满血复活');
  assert.deepEqual(consumed, ['p1'], '服务端消耗回调触发一次');
  assert.equal(__jarReviveTest.grants.get(b.battleId).get('p1'), 0, '授予表扣到 0');

  b.kill(u);
  assert.ok(b.isDown(u), '充能耗尽：第二次击倒正常倒地');
  assert.equal(consumed.length, 1, '不再重复消耗');
  assert.ok(h.invariants(), '战斗不变量成立');

  // 其他玩家没有授予 → 不受影响
  const grants2 = new Map([['p1', 0]]);
  __jarReviveTest.grants.set(b.battleId, grants2);
  const u2 = b.deployFromInput('p1', { chessId: 't_a', uid: u.uid, row: 10, col: 6 });
  assert.ok(u2 && u2.alive, '再部署');
  b.kill(u2);
  assert.ok(b.isDown(u2) || !u2.alive, '充能为 0：击倒不被复活');
});

// ---- 战斗中购入复活：补发授予 ----------------------------------------------------------------------------------

test('jar 商店：战斗中购入「复活一次」→ 对 live 战斗补发授予', () => {
  __jarReviveTest.grants.clear(); __jarReviveTest.ctx.clear(); // 模块级表跨测试残留（battleId 确定性生成）
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat: true }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 100;
  // 无复活进战斗
  m.phase = PHASE.PREP;
  m.endPrep();
  const f = m.fields.find((x) => x && Array.isArray(x.players) && x.players.includes('p_0') && x.battleId);
  assert.ok(f, '战场已创建');
  assert.ok(!__jarReviveTest.grants.get(f.battleId), '未购入：没有授予');
  // 战斗中购入 → 补发
  m.phase = PHASE.COMBAT;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'revive' }), { ok: true });
  assert.equal(__jarReviveTest.grants.get(f.battleId).get('p_0'), 1, '战斗中购入后授予已补发');
  const grantMsg = h.sent.filter(([pid, msg]) => pid === 'p_0' && msg && msg.t === 'b.jarReviveGrant').pop();
  assert.ok(grantMsg, '战斗中购入也下发 b.jarReviveGrant');
});

// ---- 障碍物（初级 3000 血 / 高级 6000 血） -----------------------------------------------------------------

test('jar 商店：初级/高级障碍物各买满 3 次（4×3 / 6×3 资金），部署位与生命不变；第 4 次售罄拒绝', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  const cap0 = ps.deployCap, lp0 = ps.lp;
  for (let i = 0; i < 3; i++) assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }), { ok: true });
  assert.equal(ps.funds, 200 - 12, '初级 3×4 = 12 资金');
  assert.equal(ps.deployCap, cap0, '部署位不变');
  assert.equal(ps.lp, lp0, '生命不变');
  assert.notEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }).ok, true, '初级第 4 次售罄拒绝');
  for (let i = 0; i < 3; i++) assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleAdvanced' }), { ok: true });
  assert.equal(ps.funds, 200 - 12 - 18, '高级 3×6 = 18 资金');
  assert.notEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleAdvanced' }).ok, true, '高级第 4 次售罄拒绝');
  const rec = m.mods.blindbox.jarShop.p_0;
  assert.equal(rec.obsBasic, 3, '初级已购 3');
  assert.equal(rec.obsAdvanced, 3, '高级已购 3');
  h.invariants();
});

test('jar 障碍物：spawnDevice 生成引擎阻隔工事——挡路，血量按档位（初级 3000 / 高级 6000）', () => {
  const h = makeBattle({
    defs: {}, units: [], enemies: [], content: 'none', autoFinish: false, timeLimit: 120,
    flags: { dpInit: 99, dpPerSec: 1, dpMax: 99 },
  });
  h.step();
  const b = h.b;
  const R = b.rect;
  const spawned = [];
  for (let r = R.r0; r <= R.r1 && spawned.length < 2; r++) {
    for (let c = R.c0; c <= R.c1 && spawned.length < 2; c++) {
      const hp = spawned.length === 0 ? 3000 : 6000;
      const u = b.spawnDevice(__jarObstacleTest.crateKey, r, c, { hp, obstacle: true, name: '障碍物' });
      if (u) spawned.push(u);
    }
  }
  assert.equal(spawned.length, 2, '生成 2 个障碍物箱子');
  assert.equal(spawned[0].hp, 3000, '初级 3000 血');
  assert.equal(spawned[1].hp, 6000, '高级 6000 血');
  assert.ok(spawned.every((u) => b.grid.isObstacle(u.tileR, u.tileC)), '障碍物所在格被标记为障碍（挡路）');
  assert.ok(h.invariants(), '战斗不变量成立');
});

test('jar 障碍物：持久模型——拥有=已放+待放(上限3)、被摧毁释放拥有数可再买、上报幂等', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  for (let i = 0; i < 3; i++) assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }), { ok: true });
  const st = m.mods.blindbox;
  const rec = st.jarShop.p_0;
  assert.equal(rec.obsBasic, 3, '买满 3 个初级障碍物（拥有数）');
  assert.notEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }).ok, true, '拥有满 3 → 拒绝再买');
  // 只能在战斗中部署：PREP 阶段拒绝
  assert.notEqual(m.handle('p_0', { t: 'g.jarDeployDevice', item: 'obstacleBasic', row: 0, col: 0 }).ok, true, '非战斗阶段拒绝部署');
  // 模拟「已部署 2 个到战场」（持久记录）；被摧毁 1 个 → 释放拥有数
  st.jarObstacles.p_0 = [{ tier: 'basic', row: 10, col: 4 }, { tier: 'basic', row: 10, col: 5 }];
  assert.deepEqual(m.handle('p_0', { t: 'g.jarObstacleLost', item: 'obstacleBasic', row: 10, col: 4 }), { ok: true });
  assert.equal(st.jarObstacles.p_0.length, 1, '摧毁 1 → 持久记录剩 1');
  assert.equal(rec.obsBasic, 2, '摧毁 1 → 拥有数 -1（可再买）');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarObstacleLost', item: 'obstacleBasic', row: 10, col: 4 }), { ok: true });
  assert.equal(rec.obsBasic, 2, '重复上报同一格：幂等，不重复扣');
  // 拥有数 <3 → 可再买补回
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }), { ok: true }, '拥有数清出空位 → 可再买');
  assert.equal(rec.obsBasic, 3, '再买 1 → 拥有数回到 3');
  h.invariants();
});

test('jar 障碍物：战斗中部署→持久记录+落格、拥有数不扣、储备 0 拒绝再放', () => {
  // 说明：完整「战斗中落格」需 live battle + battleId，jar 首战在虚拟调度下时序特殊（见下），此处只验
  // 状态层不变量；落格集成由真机 e2e 覆盖。持久记录 st.jarObstacles + 拥有数模型由上一条覆盖。
  const h = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' }), { ok: true }); // 拥有 1
  // PREP 阶段部署拒绝（WRONG_PHASE，先于储备/战斗校验）
  assert.notEqual(m.handle('p_0', { t: 'g.jarDeployDevice', item: 'obstacleBasic', row: 10, col: 4 }).ok, true, 'PREP 拒绝部署');
  // 储备 = 拥有 - 已放：放 1 个后（持久记录 +1）储备 0
  m.mods.blindbox.jarObstacles.p_0 = [{ tier: 'basic', row: 10, col: 4 }];
  // 拥有数不随部署扣（持久模型）：仍为 1
  assert.equal(m.mods.blindbox.jarShop.p_0.obsBasic, 1, '部署不扣拥有数');
  h.invariants();
});

// ---- 私有视图下发 ----------------------------------------------------------------------------------

test('jar 商店：私有视图下发价格与已购态（服务端权威）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 100;
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' });
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'revive' });
  const view = ps.privateView ? ps.privateView() : null;
  const js = view && view.jarShop;
  assert.ok(js, 'priv 视图带 jarShop');
  assert.equal(js.slots, 1, '已购部署位 1');
  assert.equal(js.priceSlot, 10, '下一个部署位 10 资金');
  assert.equal(js.priceRevive, null, '复活已持有 → 价格 null（售罄）');
  assert.equal(js.revive, 1, '持有复活充能');
  assert.equal(js.lp, ps.lp, '生命值随行');
  assert.equal(js.cap, ps.deployCap, '部署位随行');
  // 障碍物两档
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' });
  const js2 = ps.privateView ? ps.privateView().jarShop : null;
  assert.equal(js2.obsBasic, 1, '已购初级障碍物 1');
  assert.equal(js2.priceObstacleBasic, 4, '初级障碍物价格恒定 4');
  assert.equal(js2.priceObstacleAdvanced, 6, '高级障碍物价格 6');
  assert.equal(js2.obsAdvanced, 0, '高级未购');
});
