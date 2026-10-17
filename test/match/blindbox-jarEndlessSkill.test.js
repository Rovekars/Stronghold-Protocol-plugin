// 盲盒·砸罐子（jar）：永续技能（"持续时间无限"，引擎 kind 'toggle'）不因回合更换被重置。
// jar 模式每一波都是一场新战斗（battleInput → Battle），默认会把技能重置成关着：玩家上一回合开的永续技能白开。
// 本文件覆盖 jar 侧的接线（引擎侧在 test/sim/jar-endless-skill.test.js）：
//   ① jar 下按上一场战斗结果给「还活着且永续技能仍在生效」的干员打 carryState.skillEndless；
//   ② 非 jar 模式不带（官方规则：回合更换重置）；
//   ③ 阵亡 / 没开技能的干员不带；
//   ④ 客户端战果校验白名单放行 skillEndless（否则客户端模拟下这条延续会被抹掉）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeMatch, give, legalTileFor } from './harness.js';
import { chessOfTier } from './harness.js';
import { Battle } from '../../server/sim/Battle.js';
import { GEO } from '../../shared/constants.js';

await new Promise((r) => setImmediate(r)); // MOD 顶层的 createBattleFromSpec 包装 import 是异步的

const modSrc = readFileSync(new URL('../../public/mod/盲盒模式.js', import.meta.url), 'utf8');
const fieldsSrc = readFileSync(new URL('../../server/match/fields.js', import.meta.url), 'utf8');
const deploySrc = readFileSync(new URL('../../server/sim/battle/deploy.js', import.meta.url), 'utf8');

/** jar 对局 + 场上一名干员。 */
function jarMatch(mode = 'jar') {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode }), { ok: true });
  h.toPrep(1);
  const ps = h.ps('p_0');
  const id = chessOfTier(1)[0];
  const tile = legalTileFor(m, ps, id);
  const piece = give(m, ps, id, 'board', tile);
  ps.recompute();
  return { h, m, ps, piece };
}

/** 伪造上一场战斗的结果（unitsEnd 是引擎 _buildResult 的形状）。 */
function fakeLastResult(m, pid, unitsEnd) {
  m.lastResults.set(pid, { killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0, damageDealt: 0, unitsEnd, unitStats: [] });
}

test('jar：上一场结束时仍开着的永续技能 → 下一场战斗带 carryState.skillEndless', () => {
  const { m, ps, piece } = jarMatch('jar');
  fakeLastResult(m, 'p_0', [{ uid: piece.uid, defId: piece.id, hpPct: 1, sp: 0, skillActive: true, skillEndless: true, alive: true }]);
  const inp = ps.battleInput({ side: 'L', colOffset: 0 });
  const u = inp.units.find((x) => x.uid === piece.uid);
  assert.ok(u, '干员在战斗输入里');
  assert.equal(u.carryState && u.carryState.skillEndless, true, 'jar 下永续技能被带上');
});

test('jar：没开技能 / 已阵亡的干员不带延续', () => {
  const { m, ps, piece } = jarMatch('jar');
  // ① 没开永续技能（skillEndless false，哪怕 skillActive）
  fakeLastResult(m, 'p_0', [{ uid: piece.uid, defId: piece.id, hpPct: 1, sp: 0, skillActive: false, skillEndless: false, alive: true }]);
  let inp = ps.battleInput({ side: 'L', colOffset: 0 });
  assert.equal(inp.units.find((x) => x.uid === piece.uid).carryState, undefined, '没开永续技能不带 carry');
  // ② 开着但已阵亡
  fakeLastResult(m, 'p_0', [{ uid: piece.uid, defId: piece.id, hpPct: 0, sp: 0, skillActive: false, skillEndless: true, alive: false }]);
  inp = ps.battleInput({ side: 'L', colOffset: 0 });
  assert.equal(inp.units.find((x) => x.uid === piece.uid).carryState, undefined, '阵亡的干员不带 carry');
});

test('非 jar 模式照常重置（不带 skillEndless）', () => {
  const { m, ps, piece } = jarMatch('off');
  fakeLastResult(m, 'p_0', [{ uid: piece.uid, defId: piece.id, hpPct: 1, sp: 0, skillActive: true, skillEndless: true, alive: true }]);
  const inp = ps.battleInput({ side: 'L', colOffset: 0 });
  assert.equal(inp.units.find((x) => x.uid === piece.uid).carryState, undefined, '官方模式不带：回合更换照常重置技能');
});

test('接线：jar 包 ps.battleInput，引擎按 carryState.skillEndless 免费续开', () => {
  assert.match(modSrc, /const origBattleInput = ps\.battleInput;/, 'jar 包住 battleInput');
  assert.match(modSrc, /if \(stj\.mode !== 'jar'/, '只在 jar 模式生效');
  assert.match(modSrc, /if \(u && u\.alive && u\.skillEndless && Number\.isInteger\(u\.uid\)\) on\.add\(u\.uid\)/, '只认活着且永续仍在生效的');
  assert.match(modSrc, /u\.carryState = \{ \.\.\.[\s\S]{0,80}skillEndless: true \}/, '写入 carryState.skillEndless');
  assert.match(deploySrc, /if \(cs && cs\.skillEndless && u\.alive && sk && !sk\.noSkill && sk\.kind === 'toggle' && !sk\.active\)/, '引擎：只有永续技能续开');
  assert.match(deploySrc, /sk\.activate\('carry', \{ free: true \}\)/, '免费续开（技力上一场已付）');
});

test('客户端模拟上报战果时 skillEndless 不被校验抹掉', () => {
  assert.match(fieldsSrc, /skillEndless: !!u\.skillEndless/, 'unitsEnd 白名单带 skillEndless');
});

// ---- 真实数据：乌尔比安（玩家默认选技能2「瞬发」，技能1「必须维系的界限」才是永续）----
// 验证用户关心的具体场景：多技能干员「切换为永续的那个技能」后，jar 跨回合延续是否仍然生效。
//   · 默认（技能2，瞬发）：第一波单位技能 kind 不是 toggle → 无 carry，第二波照常重置（正确：没用永续技能）
//   · 切到技能1（永续）：第一波单位技能 kind === 'toggle' 且开着 → 第二波 carry 把它续开（用户问的就是这个）
test('真实干员（乌尔比安）：切到永续技能后，jar 跨回合延续生效；默认非永续技能则不延续', () => {
  const URIEL = 'chess_char_5_05_a';
  const QUIET = { info() {}, debug() {}, warn() {}, error() {} };
  const mk = (m, round, inp) => new Battle({
    data: m.ds, content: m.battleContent, logger: QUIET,
    seed: round, kind: 'normal', modeId: m.modeId, round, stageId: m.stageId,
    rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players: [inp], spawns: [], routes: [],
    sharedBoss: null, flags: { ...m.gd.dp }, fieldId: 'n:p_0',
  });

  // ---- 默认：技能2（瞬发），不切永续 ----
  {
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
    const m0 = h.m;
    assert.deepEqual(m0.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
    h.toPrep(1);
    const ps0 = h.ps('p_0');
    const tile0 = legalTileFor(m0, ps0, URIEL);
    const piece0 = give(m0, ps0, URIEL, 'board', tile0);
    ps0.recompute();
    const b1 = mk(m0, 1, ps0.battleInput({ side: 'L', colOffset: 0 }));
    b1.start();
    const u1 = b1.allyUnits.find((x) => x.uid === piece0.uid);
    assert.ok(u1, '乌尔比安在场');
    assert.notEqual(u1.skill.kind, 'toggle', '默认技能2是瞬发（非永续）');
    assert.ok(u1.skill.activate('manual', { free: true }), '手动开一次默认技能');
    b1.forceEnd('timeout');
    const end0 = b1.result().perPlayer.p_0.unitsEnd.find((x) => x.uid === piece0.uid);
    assert.equal(end0.skillEndless, false, '默认非永续技能：战斗结果不上报 skillEndless');
    // 第二波（回合更换）
    const b2 = mk(m0, 2, ps0.battleInput({ side: 'L', colOffset: 0 }));
    b2.start();
    const u2 = b2.allyUnits.find((x) => x.uid === piece0.uid);
    assert.notEqual(u2.skill.kind, 'toggle', '第二波部署的仍是默认瞬发技（不是永续）');
    assert.equal(u2.skill.active, false, '默认非永续：第二波照常重置（carry 不触发）');
  }

  // ---- 切到技能1（永续「必须维系的界限」）----
  {
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
    const m = h.m;
    assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
    h.toPrep(1);
    const ps = h.ps('p_0');
    // 玩家在棋子上「切换为永续的那个技能」
    assert.equal(ps.setLoadout({ [URIEL]: { skill: 1 } }), true, '切到技能1（永续）成功');
    const tile = legalTileFor(m, ps, URIEL);
    const piece = give(m, ps, URIEL, 'board', tile);
    ps.recompute();

    // 第 1 波：真实战斗 → 开永续技能 → 打完
    const b1 = mk(m, 1, ps.battleInput({ side: 'L', colOffset: 0 }));
    b1.start();
    const u1 = b1.allyUnits.find((x) => x.uid === piece.uid);
    assert.ok(u1, '乌尔比安在场');
    assert.equal(u1.skill.kind, 'toggle', '切到技能1后，部署的单位技能是永续');
    assert.ok(u1.skill.activate('manual', { free: true }), '开启永续技能');
    assert.equal(u1.skill.active, true);
    b1.forceEnd('timeout');
    const end = b1.result().perPlayer.p_0.unitsEnd.find((x) => x.uid === piece.uid);
    assert.equal(end.skillEndless, true, '战斗结果上报：永续技能仍在生效');
    m.lastResults.set('p_0', b1.result().perPlayer.p_0);

    // 第 2 波：回合更换 → carry 应把永续技能续开
    const b2 = mk(m, 2, ps.battleInput({ side: 'L', colOffset: 0 }));
    b2.start();
    const u2 = b2.allyUnits.find((x) => x.uid === piece.uid);
    assert.equal(u2.skill.kind, 'toggle', '第二波部署的仍是切到的那个永续技能');
    assert.equal(u2.skill.active, true, 'jarr：回合更换后永续技能仍然开着（carry 生效）');
  }
});

// ---- 真实数据：史尔特尔 S3 黄昏（数据里唯一的「持续时间无限」技能，kit kind 'toggle'）----
// 跑两波 jar 战斗：第一波把永续技能开起来并打完，第二波开场时它应该还开着（而不是被回合更换重置）。
test('真实干员（史尔特尔·黄昏）：jar 下跨回合保持开启；关掉 jar 则照常重置', () => {
  const SURTR = 'chess_char_5_07_a';
  for (const mode of ['jar', 'off']) {
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 47, fake: true }).start();
    const m = h.m;
    assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode }), { ok: true });
    h.toPrep(1);
    const ps = h.ps('p_0');
    const tile = legalTileFor(m, ps, SURTR);
    const piece = give(m, ps, SURTR, 'board', tile);
    ps.recompute();

    // 第 1 波：真实战斗 → 手动开技能 → 打完并结算
    const QUIET = { info() {}, debug() {}, warn() {}, error() {} };
    const mk = (round, inp) => new Battle({
      data: m.ds, content: m.battleContent, logger: QUIET,
      seed: round, kind: 'normal', modeId: m.modeId, round, stageId: m.stageId,
      rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players: [inp], spawns: [], routes: [],
      sharedBoss: null, flags: { ...m.gd.dp }, fieldId: 'n:p_0',
    });
    const b1 = mk(1, ps.battleInput({ side: 'L', colOffset: 0 }));
    b1.start();
    const u1 = b1.allyUnits.find((x) => x.uid === piece.uid);
    assert.ok(u1, '史尔特尔在场');
    assert.equal(u1.skill.kind, 'toggle', 'S3 黄昏是永续技能');
    assert.ok(u1.skill.activate('manual', { free: true }), '开启永续技能');
    assert.equal(u1.skill.active, true);
    b1.forceEnd('timeout');
    const res = b1.result();
    const end = res.perPlayer.p_0.unitsEnd.find((x) => x.uid === piece.uid);
    assert.equal(end.skillEndless, true, '战斗结果上报：永续技能仍在生效');
    m.lastResults.set('p_0', res.perPlayer.p_0); // 引擎在 _finishCombat 里做的同一件事

    // 第 2 波：新战斗（回合更换）
    const b2 = mk(2, ps.battleInput({ side: 'L', colOffset: 0 }));
    b2.start();
    const u2 = b2.allyUnits.find((x) => x.uid === piece.uid);
    if (mode === 'jar') {
      assert.equal(u2.skill.active, true, 'jar：回合更换后永续技能仍然开着');
      assert.equal(u2.skill.kind, 'toggle');
    } else {
      assert.equal(u2.skill.active, false, '官方模式：回合更换照常把技能重置成关着');
    }
  }
});
