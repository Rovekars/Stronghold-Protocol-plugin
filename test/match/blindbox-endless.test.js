// 盲盒·砸罐子 无尽模式（每 10 回合换地形 + 第 10 回合随机小型首领 + 无限推进）的服务端逻辑测试。
// 对应 public/mod/盲盒模式.js 的 jar 无尽改造：#59 无限推进 / #60 每 10 回合整张地图轮换 / #61 第 10 回合随机小型首领。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';

const bbState = (m) => m.mods.blindbox;
const JAR_MINI_BOSS_HP_MUL = 14; // 必须与 public/mod/盲盒模式.js 的 JAR_MINI_BOSS_HP_MUL 保持一致

function setupJar({ clientCombat = false } = {}) {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat }).start();
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h;
}

test('无尽：开启 jar 后 gd.bossRound/hiddenRound 被实例遮蔽为「永不触发」（轮次无限推进，且离开后还原）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
  const m = h.m;
  assert.equal(typeof m.gd.bossRound, 'number', '开启前 bossRound 是数字（默认最终强袭回合）');
  assert.equal(typeof m.gd.hiddenRound, 'number', '开启前 hiddenRound 是数字');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  assert.equal(m.gd.bossRound, 1e9, 'jar 把 bossRound 遮蔽为 1e9 → 永不触发最终强袭');
  assert.equal(m.gd.hiddenRound, null, 'jar 把 hiddenRound 遮蔽为 null → 永不触发隐藏核心');
  // 离开 jar 还原 getter（m.gd 是每局独立实例，不影响其他对局）
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'off' }), { ok: true });
  assert.equal(typeof m.gd.bossRound, 'number', '离开 jar 还原 bossRound getter');
  assert.equal(typeof m.gd.hiddenRound, 'number', '离开 jar 还原 hiddenRound getter');
});

test('无尽：每 10 回合整张地图（stage）轮换', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // 进入 PREP R1：startRound(1) 触发 jarRotateStage → stageList 初始化
  const st = bbState(m);
  assert.ok(st.stageList.length >= 1, '存在可轮换地形列表');
  const n = st.stageList.length;
  const i0 = st.stageIdx;
  m.startRound(1);  assert.equal(st.stageIdx, i0, 'R1 不轮换');
  m.startRound(10); assert.equal(st.stageIdx, i0, 'R10 不轮换（仍属第 1 个 10 回合区块）');
  m.startRound(11);
  assert.equal(st.stageIdx, (i0 + 1) % n, 'R11 进入新区块 → 轮换 +1');
  assert.equal(m.stageId, st.stageList[(i0 + 1) % n], 'R11 m.stageId 与轮换后的索引一致');
  m.startRound(20); assert.equal(st.stageIdx, (i0 + 1) % n, 'R20 与 R11 同块（不二次轮换）');
  m.startRound(21);
  assert.equal(st.stageIdx, (i0 + 2) % n, 'R21 再次轮换 +1');
  assert.equal(m.stageId, st.stageList[(i0 + 2) % n], 'R21 m.stageId 与轮换后的索引一致');
  // 地形确实随之切换（列表 >1 时相邻区块 stageId 应不同）
  if (n > 1) {
    assert.notEqual(st.stageList[(i0 + 1) % n], st.stageList[i0], '轮换后 stageId 改变');
  }
});

test('无尽：第 10 回合注入随机行走精英当小型首领（高血量、会动）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true, clientCombat: true }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // 进入 PREP R1，m.wave 就绪（含 routes）
  m.round = 10;
  m.phase = PHASE.PREP;
  m.endPrep(); // 走包装：startCombat 建场 + jarSpawnMiniBoss（round 10）
  const st = bbState(m);
  assert.ok(st.lastMiniBoss, 'lastMiniBoss 记录本回合抽到的精英 key');
  const f = m.fields.find((x) => x && Array.isArray(x.players) && x.players.includes('p_0'));
  assert.ok(f, 'p_0 的战场已创建');
  assert.ok(f.spec && Array.isArray(f.spec.spawns), 'client combat 战场带 spec.spawns');
  const spawn = f.spec.spawns.find((s) => s.tag === 'jar-miniboss');
  assert.ok(spawn, 'jar-miniboss 已注入战场 spec');
  assert.equal(spawn.enemyKey, st.lastMiniBoss, '注入的敌人 = 抽到的 key');
  assert.equal(spawn.count, 1, '小型首领单只');
  assert.equal(spawn.mods && spawn.mods.hpMul, JAR_MINI_BOSS_HP_MUL, '血量倍率 = JAR_MINI_BOSS_HP_MUL');
  const def = m.gd.enemy(spawn.enemyKey);
  assert.ok(def, '敌人 key 合法');
  assert.equal(def.stats.motion, 'WALK', '小型首领会走（非站桩）');
  assert.equal(def.rank, 'ELITE', '小型首领为精英量级');
  // #62 立绘横幅：服务端向每位人类玩家广播 m.jarMiniBoss（携带 key / name / round），客户端据此弹原生立绘横幅
  const miniMsg = h.sent.filter(([pid, msg]) => pid === 'p_0' && msg && msg.t === 'm.jarMiniBoss')[0];
  assert.ok(miniMsg, '向 p_0 广播了 m.jarMiniBoss 立绘横幅信号');
  assert.equal(miniMsg[1].key, st.lastMiniBoss, '广播的 key = 本轮抽到的精英 key');
  assert.equal(miniMsg[1].name, def.name, '广播的 name = 敌人名字（客户端横幅标题）');
  assert.equal(miniMsg[1].round, 10, '广播的 round = 10');
});

const JAR_MINI_BOSS_LEAK_LP = 5; // 必须与 public/mod/盲盒模式.js 的 JAR_MINI_BOSS_LEAK_LP 保持一致
const baseResult = (enemyKey, tag) => ({
  leaked: [{ enemyKey, tag, counted: true, lpr: 1 }],
  perfect: false, coins: 0, layerGains: {}, killed: 0, damageDealt: 0, healingDone: 0,
});

test('无尽：小型首领漏怪进点扣除 5 点生命（普通漏怪仍扣 1）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // 进入 PREP R1：jarRotateStage 初始化 stageList（同时注册 settle 包装）
  const ps = m.players.get('p_0');
  const cap = m.gd.lpCapPerRound;
  const miniKey = bbState(m).lastMiniBoss || 'enemy_1006_shield';

  // 1) 仅小型首领漏怪 → 扣 5 LP（cap≥5 时精确扣 5）
  const lpA = ps.lp;
  m.lastResults = new Map([['p_0', baseResult(miniKey, 'jar-miniboss')]]);
  m.settle(null, null);
  assert.equal(lpA - ps.lp, Math.min(cap, JAR_MINI_BOSS_LEAK_LP), '1 只小型首领漏怪 → 扣 5 LP（受 cap 约束）');

  // 2) 仅普通漏怪 → 仍扣 1 LP（确认扩写只针对 jar-miniboss，不是全局 ×5）
  const lpB = ps.lp;
  m.lastResults = new Map([['p_0', baseResult('enemy_norm', 'bounty')]]);
  m.settle(null, null);
  assert.equal(lpB - ps.lp, Math.min(cap, 1), '1 只普通漏怪 → 仍扣 1 LP');

  // 3) 1 普通 + 1 小型首领 → 扣 1 + 5 = 6（cap≥6 时）
  const lpC = ps.lp;
  m.lastResults = new Map([['p_0', {
    leaked: [baseResult('enemy_norm', 'bounty').leaked[0], baseResult(miniKey, 'jar-miniboss').leaked[0]],
    perfect: false, coins: 0, layerGains: {}, killed: 0, damageDealt: 0, healingDone: 0,
  }]]);
  m.settle(null, null);
  assert.equal(lpC - ps.lp, Math.min(cap, 1 + JAR_MINI_BOSS_LEAK_LP), '1 普通 + 1 小型首领 → 扣 1 + 5 = 6 LP');
});
