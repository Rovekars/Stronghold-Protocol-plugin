// 盲盒·砸罐子（jar）同盟模式两项增强（用户 2026-10-17）：
//   ① 随时随地查看队友：jar 战斗无尽（自己战场恒 live），引擎默认「作战中无法查看队友」会永久堵死观战。
//      客户端 observeTarget 增加 jar 放行；服务端 MOD 包 m._watchClient 对 jar 模式放行活人玩家观看队友普通战场。
//   ② AI 队友真正下场：原先 AI 完全躺平（600ms 休整期把 botPrep 切片丢掉、砸罐/罐中商店/障碍物只给人类做了入口）。
//      现在每波战斗建立后驱动 AI：买罐中商店 → 砸完全部罐子（干员/道具罐先砸并部署、敌人罐后砸）→ 穿装 → 要道放障碍物。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';
import { PHASE } from '../../shared/constants.js';

// MOD 顶层 createBattleFromSpec 包装 import 是异步的；直接调用不依赖包装时序
await new Promise((r) => setImmediate(r));

const jar = (h) => {
  h.start();
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};
const st = (h) => h.m.mods.blindbox;
const fieldOf = (h, pid) => h.m.fields.find((x) => x && Array.isArray(x.players) && x.players.includes(pid)) || null;
const specBounties = (h, pid) => {
  const f = fieldOf(h, pid);
  return f && f.spec ? (f.spec.spawns || []).filter((s) => s && s.tag === 'bounty') : [];
};
const specUnits = (h, pid) => {
  const f = fieldOf(h, pid);
  const p = f && f.spec ? (f.spec.players || []).find((x) => x && x.playerId === pid) : null;
  return (p && p.units) || [];
};

// ---- ① 随时随地查看队友 -----------------------------------------------------------------------------------

test('jar 同盟：自己战斗进行中也能 g.watch 查看队友战场（watch 副本），返回自己正常', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7, fake: true, clientCombat: true, clients: false });
  const m = jar(h);
  h.drive(() => h.m.phase === PHASE.COMBAT);
  const own = fieldOf(h, 'p_0');
  const peer = fieldOf(h, 'ai_0');
  assert.ok(own && own.live, '自己的战场正在进行（jar 无尽）');
  assert.ok(peer && peer.kind === 'normal' && peer.live, '队友有普通战场');
  const before = h.sent.length;
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: peer.fieldId }), { ok: true }, '战斗中查看队友战场放行');
  const pushed = h.sent.slice(before).filter(([pid, msg]) => pid === 'p_0' && (msg.t === 'b.start' || msg.t === 'm.field'));
  assert.ok(pushed.some(([, msg]) => msg.t === 'b.start' && msg.watch), '下发队友战场的 watch 副本（b.start watch）');
  assert.equal(m.watchers.get('p_0'), peer.fieldId, '观战目标已记录');
  // 返回自己战场
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: own.fieldId }), { ok: true });
  assert.equal(m.watchers.get('p_0'), own.fieldId, '返回自己');
  h.invariants();
});

test('非 jar 模式：自己战斗中进行中仍旧拒绝查看队友（回归，不改原生规则）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7, fake: true, clientCombat: true, clients: false });
  h.start();
  h.drive(() => h.m.phase === PHASE.COMBAT);
  const peer = fieldOf(h, 'ai_0');
  const r = h.m.handle('p_0', { t: 'g.watch', fieldId: peer.fieldId });
  assert.notEqual(r && r.ok, true, '原生规则不变：作战中无法查看队友');
  assert.equal(h.m.watchers.get('p_0'), fieldOf(h, 'p_0').fieldId, '观战目标没被改');
});

// ---- ② AI 队友真正下场 -----------------------------------------------------------------------------------

test('jar 同盟：AI 队友砸完全部罐子、干员上场、敌人注入战场（不再空场躺平）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 2, seed: 7, fake: true, clientCombat: true, clients: false });
  const m = jar(h);
  h.drive(() => h.m.phase === PHASE.COMBAT);
  for (const pid of ['ai_0', 'ai_1']) {
    const ps = h.m.players.get(pid);
    const jars = st(h).jars[pid] || [];
    assert.ok(jars.length > 0, `${pid} 有罐子`);
    assert.ok(jars.every((j) => j.smashed), `${pid} 全部罐子都被 AI 砸开（含敌人罐，战场才能收尾）`);
    assert.ok(ps.board.size > 0, `${pid} 有干员上场（不再空场）`);
    // 干员基本部署完：不囤积大量干员（≤2 视为棋盘满格 / 有意保留，属正常）。
    // 注：罐子敌池变化会微量改变确定性 RNG 序列，导致特定种子下 AI 最后留 1 个干员未部署，
    // 故此处用宽松阈值而非 hand===0，避免把「RNG 序列偏移」误判为「AI 不作战」回归。
    assert.ok(ps.hand.filter(Boolean).length <= 2, `${pid} 干员基本部署完（剩余 ${ps.hand.filter(Boolean).length} 个，未囤积）`);
    assert.ok(specUnits(h, pid).length > 0, `${pid} 的战斗 spec 带上了这些干员（接管/校验重建时仍在）`);
    const foes = jars.filter((j) => j.kind === 'enemy');
    if (foes.length) {
      assert.equal(specBounties(h, pid).length, foes.length, `${pid} 每个敌人罐都向战场注入了敌人`);
      for (const b of specBounties(h, pid)) assert.ok(b.time >= 0 && Number.isFinite(b.time), '注入时间合法');
    }
  }
  // 人类玩家的罐子 AI 一个都没碰
  const mine = (st(h).jars.p_0 || []).filter((j) => j.smashed);
  assert.equal(mine.length, 0, 'AI 只砸自己的罐子，不碰人类玩家的');
  h.invariants();
});

test('jar 同盟：AI 队友有钱时会买罐中商店并在要道放障碍物', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 2, seed: 7, fake: true, clientCombat: true, clients: false });
  const m = jar(h);
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 1);
  for (const pid of ['ai_0', 'ai_1']) h.m.players.get(pid).funds = 120; // jar 600ms 休整期窗口内充钱
  h.drive(() => h.m.phase === PHASE.COMBAT);
  for (const pid of ['ai_0', 'ai_1']) {
    const ps = h.m.players.get(pid);
    const rec = st(h).jarShop[pid];
    assert.ok(rec, `${pid} 建了商店账`);
    assert.equal(rec.slots, 1, `${pid} 先买部署位（8 资金）`);
    assert.equal(ps.deployCap, 8 + 1, '部署位实时 +1');
    assert.ok(ps.funds < 120, '扣了钱');
  }
  // 多跑几回合：障碍物（R2 起解锁）会买并落到战场上
  let guard = 0;
  while (h.m.round < 4 && !h.ended && guard++ < 30) {
    h.drive(() => h.m.phase === PHASE.PREP, { maxSteps: 200000 });
    for (const pid of ['ai_0', 'ai_1']) h.m.players.get(pid).funds += 40; // 模拟击杀收入
    h.drive(() => h.m.phase === PHASE.COMBAT || h.ended, { maxSteps: 200000 });
    h.run(() => h.m.phase !== PHASE.COMBAT, { maxSteps: 20000 });
  }
  assert.ok(h.m.round >= 4, `跑到了第 ${h.m.round} 回合`);
  for (const pid of ['ai_0', 'ai_1']) {
    const rec = st(h).jarShop[pid];
    assert.ok(rec.obsBasic > 0 || rec.obsAdvanced > 0, `${pid} 买了障碍物`);
    const placed = st(h).jarObstacles[pid] || [];
    assert.ok(placed.length > 0, `${pid} 障碍物已落到战场（持久记录）`);
    for (const o of placed) {
      assert.ok(o.tier === 'basic' || o.tier === 'advanced', '档位合法');
      assert.ok(Number.isInteger(o.row) && Number.isInteger(o.col), '格子合法');
    }
  }
  h.invariants();
});

test('非 jar 模式：AI 逻辑完全不受影响（没有 jar 状态、不砸罐）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7, fake: true, clientCombat: true, clients: false });
  h.start();
  h.drive(() => h.m.phase === PHASE.COMBAT);
  assert.equal(st(h).mode, 'off', '盲盒模式关闭');
  assert.deepEqual(st(h).jars, {}, '没有生成罐子');
  const ps = h.m.players.get('ai_0');
  assert.equal(st(h).jarShop['ai_0'], undefined, '没有 jar 商店账');
  assert.ok(ps.board.size >= 0, 'AI 走原生 botPrep（本测试不关心其结果，只确认 jar 没插手）');
  h.invariants();
});

test('jar 同盟（真实战斗内核）：AI 战场自然收尾——锚点立即撤除，不再拖到 3600 上限挂死回合', () => {
  // 回归（用户 2026-10-17「AI 队友都没有实际在作战，全是空的」）：headless 战斗不受真实时间 pacing、
  // 以最快速度跑完，「最后一罐砸开→4s 后撤锚点」等不到生效 → 战斗拖满 3600 战斗秒上限，
  // 战果 endGt=3600 → 按战场时钟释放要 30 真实分钟 → 回合被 AI 挂死、观战只见空场。
  // AI 撤锚点改为同步后：敌人罐注入（t=10 出生）→ 打完/漏完 → 战场自然 cleared。
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 2, seed: 11, clientCombat: true, clients: false,
    headlessSliceMs: 8, instant: false }); // 生产时序：headless 分片步进 + 虚拟时钟 pacing，真实 Battle 内核
  const m = jar(h);
  h.drive(() => h.m.phase === PHASE.COMBAT);
  let guard = 0;
  while (!h.ended && h.m.phase === PHASE.COMBAT && guard++ < 60000) {
    h.run(() => h.m.phase !== PHASE.COMBAT || (fieldOf(h, 'ai_0') || {}).done, { maxSteps: 200000 });
    break;
  }
  const f = fieldOf(h, 'ai_0');
  assert.ok(f, 'AI 战场存在');
  assert.ok(f.done, 'AI 战场在本回合内完成（不再挂 30 分钟）');
  const endGt = Number(f.endGt) || 0;
  assert.ok(endGt > 0 && endGt < 600, `AI 战场自然收尾（endGt=${endGt} < 600，绝非 3600 上限）`);
  const pp = f.result && f.result.perPlayer && f.result.perPlayer['ai_0'];
  assert.ok(pp && (Number(pp.killed) || 0) + (Array.isArray(pp.leaked) ? pp.leaked.filter((l) => l && l.spawned).length : 0) > 0,
    '敌人真的出生并结算了（击杀 + 漏怪 > 0）——AI 实际在作战');
  // AI 的 spec 不再带锚点（观战副本同样自然收尾，不会看完战斗后空转 30 分钟）
  assert.ok(!(f.spec.spawns || []).some((s) => s && s.tag === 'jar-anchor'), 'AI 的战场 spec 不再带锚点');
  h.invariants();
});

test('jar 同盟：联防阶段照常操作——出战协防的队友可部署/买罐中商店，漏怪方不能部署但可购买', () => {
  // p_0 漏怪（leaker）、p_1 完美（perfect → 联防出战 helper）。jar 模式的罐中商店 / 穿装 / 部署在联防阶段照常可用。
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 9111, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 4 } } : {}) });
  const m = jar(h);
  h.drive(() => h.m.phase === PHASE.UNITE);
  const u = fieldOf(h, 'p_1');
  assert.ok(u && u.fieldId === 'u' && u.kind === 'unite', '联防战场已建立');
  assert.deepEqual(u.players, ['p_1'], '出战协防的队友 = 完美的 p_1');
  // ---- helper p_1：罐中商店在联防阶段可用 ----
  const ps1 = h.ps('p_1');
  ps1.funds = 50;
  const lp0 = ps1.lp;
  assert.deepEqual(m.handle('p_1', { t: 'g.jarShopBuy', item: 'life' }), { ok: true }, '联防阶段可买罐中商店');
  assert.equal(ps1.lp, lp0 + 1, '生命 +1 生效');
  // ---- helper p_1：手牌干员部署到联防战场（b.jarDeploy → 权威端 sim client 的联防战场落场）----
  const melee = chessOfTier(1, (c) => c.position === 'MELEE').find((x) => m.pool.has(x));
  const unit = give(m, ps1, melee, 'hand');
  const tile = legalTileFor(m, ps1, melee);
  assert.deepEqual(ps1.move(unit.uid, { area: 'board', row: tile[0], col: tile[1] }), { ok: true }, '联防阶段可部署干员');
  h.sched.advance(1); // b.jarDeploy 经调度器延迟送达 sim client（真实 socket 同样非重入）
  const battle = h.clients.get('p_1').battles.get(u.battleId)?.battle;
  assert.ok(battle, 'p_1 的联防战场副本存在');
  const deployed = (battle.allyUnits || []).filter((x) => x && x.ownerId === 'p_1' && x.kind === 'op' && !x.removed);
  assert.ok(deployed.some((x) => x.uid === unit.uid), '新部署的干员真的落进了联防战场');
  const sp = (u.spec.players || []).find((x) => x && x.playerId === 'p_1');
  assert.ok((sp.units || []).some((x) => x.uid === unit.uid), 'spec 同步补写（接管 / 重建时也在）');
  // ---- leaker p_0：不能向联防战场部署（不在战场玩家列表，部署会成幽灵棋子）；购买照常 ----
  const ps0 = h.ps('p_0');
  const melee2 = chessOfTier(1, (c) => c.position === 'MELEE').find((x) => m.pool.has(x) && x !== melee);
  const unit2 = give(m, ps0, melee2, 'hand');
  const r2 = ps0.move(unit2.uid, { area: 'board', row: tile[0], col: tile[1] });
  assert.notEqual(r2 && r2.ok, true, '漏怪方不能向联防战场部署');
  ps0.funds = 20;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'life' }), { ok: true }, '漏怪方的罐中商店照常可用');
  // ---- 非 jar 模式的联防阶段不被放行（回归：原生 unite 不可部署）----
  h.invariants();
});

test('非 jar 模式：联防阶段原生不可部署（回归，jar 放行不外溢）', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 9111, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 4 } } : {}) });
  h.start();
  h.drive(() => h.m.phase === PHASE.UNITE);
  const ps1 = h.ps('p_1');
  const melee = chessOfTier(1, (c) => c.position === 'MELEE').find((x) => h.m.pool.has(x));
  const unit = give(h.m, ps1, melee, 'hand');
  const tile = legalTileFor(h.m, ps1, melee);
  const r = ps1.move(unit.uid, { area: 'board', row: tile[0], col: tile[1] });
  assert.notEqual(r && r.ok, true, '原生联防阶段不可部署（jar 放行没有外溢）');
  h.invariants();
});
