// 盲盒·砸罐子（jar）：敌人强度分档 + 按回合渐进解锁的敌池（用户 2026-10-15：
// 「一开始就出灵幛和奇美拉这种玩家根本打不过，希望调整强度并且让怪的种类更多样」）。
// 口径：tier = maxHp/1000 + atk/120 分 0杂兵/1老练/2精英/3首领级；R1-2 仅杂兵 / R3-5 放开老练 / R6+ 加入精英；
// 来源为全敌人库（249 种）而非 solo 模式波次模板的 7 种——种类随回合极大丰富，前期不出打不过的精英。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier } from './harness.js';
import { __jarEnemyTest } from '../../public/mod/盲盒模式.js';

await new Promise((r) => setImmediate(r));

test('jar 敌池：强度分档口径（全量敌人按 score 归档——站桩 moveSpeed 0 永不入罐）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 3 }).start();
  const m = h.m;
  const tier = (k) => __jarEnemyTest.tier(m, k);
  assert.equal(tier('enemy_1007_slime'), 0, '源石虫 = 杂兵');
  assert.equal(tier('enemy_1422_lrsldr'), 1, '萨卡兹枯朽前锋 = 老练');
  assert.equal(tier('enemy_1427_lrnazg'), 2, '「灵幛」= 精英');
  assert.equal(tier('enemy_1425_lrcmra'), 2, '孽罪奇美拉 = 精英');
  // 会走的 BOSS 按 score 归档（用户 2026-10-15：除了不动的都可以加入）
  assert.equal(tier('enemy_1502_crowns'), 1, '弑君者（6000 血）= 老练');
  assert.equal(tier('enemy_1500_skulsr'), 2, '碎骨（10500 血 / 1000 攻，score 18.8）= 精英');
  assert.equal(tier('enemy_1509_mousek'), 2, '鼠王（22000 血）= 精英');
  assert.equal(tier('enemy_1511_mdrock'), 3, '泥岩（45000 血）= 大首领');
  assert.equal(tier('enemy_2008_flking'), 3, '「墓碑」（60000 血）= 大首领');
  // 站桩（在原地不会走动，moveSpeed 0）永不入罐（用户 2026-10-16：除站桩外全量加入）
  assert.equal(tier('enemy_10091_hlsttu'), 4, '圣徒像（站桩雕像）= 永不入罐');
  assert.equal(tier('enemy_10028_vtswd'), 4, '未装配刀片（悬停炮台，速度 0）= 永不入罐');
  // 飞行怪也算「会动」，按 score 归档（2026-10-16 全量口径，不再因 FLY 排除）
  assert.equal(tier('enemy_9014_acstma'), 3, '「斩胄之剑」（24 万血飞行）= 大首领档');
  assert.equal(tier('enemy_9015_acstmb'), 3, '「破胄之锤」（25 万血飞行）= 大首领档');
  // 百万级超模不再永久排除：归入大首领档（R10+ 一次一只）
  assert.equal(tier('enemy_9020_actrpc'), 3, '「碎铳之簧」（250 万血）= 大首领档');
  assert.equal(tier('enemy_9033_acdeer'), 3, '「萨米的意志」（24 万血）= 大首领档');
});

test('jar 敌池：完全不会攻击的敌人（atk 0）永不入罐（用户 2026-10-17）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 3 }).start();
  const m = h.m;
  const tier = (k) => __jarEnemyTest.tier(m, k);
  // 已知基础 atk 为 0 的被动 / 辅助类敌人（无人机 / 铁砧 / 文玩瑞印 / 落石 / 护障…）
  const passive = ['enemy_1105_tyokai', 'enemy_1106_byokai', 'enemy_1146_defspd',
    'enemy_1196_msfyin', 'enemy_1343_ltrock', 'enemy_1355_mrfly'];
  for (const k of passive) {
    const e = m.gd.enemy(k);
    assert.ok(e && e.stats, `${k} 存在于敌人库`);
    assert.equal(Number(e.stats.atk), 0, `${k} 基础 atk 为 0（完全不会攻击）`);
    assert.equal(tier(k), 4, `${k} 永不入罐（tier 4）`);
  }
  // 任意回合的敌池都不含 atk 0 的敌人（R1-30 全扫描，含同盟阈值差异）
  for (let r = 1; r <= 30; r++) {
    m.round = r;
    for (const k of __jarEnemyTest.pool(m)) {
      const e = m.gd.enemy(k);
      assert.ok(e && e.stats && Number(e.stats.atk) > 0, `R${r} 敌池中的 ${k} 必须会攻击（atk > 0）`);
    }
  }
});


test('jar 敌池：按回合渐进解锁——R1-2 仅杂兵，R3-5 放开老练，R6+ 加入精英；首领级永不入池', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 3 }).start();
  const m = h.m;
  const poolAt = (r) => { m.round = r; return __jarEnemyTest.pool(m); };
  const p1 = poolAt(1);
  assert.ok(p1.length >= 20, `R1 池子应有充足杂兵种类（实际 ${p1.length}）`);
  for (const k of p1) assert.equal(__jarEnemyTest.tier(m, k), 0, 'R1-2 只能出杂兵');
  assert.ok(!p1.includes('enemy_1427_lrnazg') && !p1.includes('enemy_1425_lrcmra'), 'R1 没有灵幛/奇美拉');
  for (const k of poolAt(2)) assert.equal(__jarEnemyTest.tier(m, k), 0, 'R2 仍仅杂兵');
  const p3 = poolAt(3);
  assert.ok(p3.length > p1.length, 'R3 种类比 R1 多');
  for (const k of p3) assert.ok(__jarEnemyTest.tier(m, k) <= 1, 'R3-4 上限老练');
  assert.ok(!p3.includes('enemy_1427_lrnazg'), 'R3 仍没有灵幛');
  const p5 = poolAt(5);
  assert.ok(p5.length > p3.length, 'R5 种类继续增长');
  for (const k of p5) assert.ok(__jarEnemyTest.tier(m, k) <= 2, 'R5+ 上限精英');
  assert.ok(p5.includes('enemy_1427_lrnazg'), 'R5 起灵幛就可能进罐（第 5 回合出强怪）');
  // 大首领 tier3：R10 起解锁（与小型首领同步），R9 及之前不得出现
  const p10 = poolAt(10);
  for (const k of p10) assert.ok(__jarEnemyTest.tier(m, k) <= 3, 'R10+ 上限大首领');
  assert.ok(p10.includes('enemy_1511_mdrock'), 'R10 起泥岩可能进罐');
  assert.ok(p10.includes('enemy_1502_crowns'), 'R10 起弑君者可能进罐');
  for (const r of [1, 3, 6, 9]) {
    const p = poolAt(r);
    for (const k of p) assert.ok(__jarEnemyTest.tier(m, k) <= 2, `R${r} 无大首领`);
    assert.ok(!p.includes('enemy_1511_mdrock'), `R${r} 无泥岩`);
  }
  // 站桩敌人在任何回合都不入罐（数据层保留本体波次需要的站桩怪，但 jar 池永不放）
  for (const r of [1, 3, 6, 12, 30]) {
    const p = poolAt(r);
    assert.ok(!p.includes('enemy_10091_hlsttu'), `R${r} 无站桩「圣徒像」`);
    assert.ok(!p.includes('enemy_10028_vtswd'), `R${r} 无悬停炮台「未装配刀片」`);
  }
  // 飞行怪与百万级超模已归入大首领档：R9 及之前不出现，R10+ 可出现
  for (const r of [1, 3, 6, 9]) {
    const p = poolAt(r);
    assert.ok(!p.includes('enemy_9014_acstma'), `R${r} 无「斩胄之剑」（大首领 R10+）`);
    assert.ok(!p.includes('enemy_9020_actrpc'), `R${r} 无「碎铳之簧」（大首领 R10+）`);
  }
  const p10all = poolAt(10);
  for (const k of p10all) assert.ok(__jarEnemyTest.tier(m, k) <= 3, 'R10+ 上限大首领');
  // mode.inactiveEnemyKeys 的敌人被排除
  const inact = m.gd.inactiveEnemies;
  if (inact && inact.size) {
    const one = [...inact][0];
    for (const r of [1, 6, 20]) assert.ok(!poolAt(r).includes(one), 'inactive 敌人被排除');
  }
});

test('jar 敌池：无 Spine 模型的敌人被过滤，避免进场后变成菱形占位（素材丢失观感）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 3 }).start();
  const m = h.m;
  // assets.json 中无 spine / spineAliasOf / spineLocal 条目的敌人应判定为无模型
  // （刺胄之弹 enemy_9016_acstmr 旧版无模型；素材全量抓取后可能被补上/别名，故只断言有模型的关键样本）
  assert.equal(__jarEnemyTest.hasSpine(m, 'enemy_1007_slime'), true, '源石虫有 Spine 模型');
  assert.equal(__jarEnemyTest.hasSpine(m, 'enemy_1427_lrnazg'), true, '灵幛有 Spine 模型');
  // 敌人池里的每个敌人都必须有模型（R1-30 全回合）
  for (let r = 1; r <= 30; r++) {
    m.round = r;
    for (const k of __jarEnemyTest.pool(m)) {
      assert.equal(__jarEnemyTest.hasSpine(m, k), true, `R${r} 敌池中的 ${k} 必须有 Spine 模型`);
    }
  }
  // 未知 key 直接判无模型，避免空指针
  assert.equal(__jarEnemyTest.hasSpine(m, 'enemy_does_not_exist'), false, '未知敌人无模型');
});

test('jar 敌池：R1 实际生成的罐中敌人全部是杂兵且种类多样（端到端）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 21 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // enterPrep 的 phase hook 已 generateJars
  const st = m.mods.blindbox;
  const jars = (st.jars.p_0 || []).filter((j) => j.kind === 'enemy');
  assert.ok(jars.length >= 5, '有敌人罐');
  for (const j of jars) assert.equal(__jarEnemyTest.tier(m, j.enemyKey), 0, `R1 罐中敌人 ${j.enemyKey} 应为杂兵`);
  // 旧实现只用模式模板的 3 种敌人；现在 R1 就有几十种杂兵轮换
  assert.ok(new Set(jars.map((j) => j.enemyKey)).size >= 5, 'R1 敌人种类多样');
  h.invariants();
});

test('jar 换地形：站在新地图非法格的干员强制消除（销毁，不撤回整备区）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 23 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // R1：jarRotateStage 初始化 stageList
  const st = m.mods.blindbox;
  assert.ok(Array.isArray(st.stageList) && st.stageList.length >= 2, '至少两张可轮换地图');
  const ps = h.ps('p_0');
  const curId = m.stageId;
  const nextId = st.stageList[(st.stageIdx + 1) % st.stageList.length];
  assert.notEqual(nextId, curId, '下一张是不同的图');
  // 找一个「当前图合法、下一张图不合法」的格子（换地形后该干员必须离场）
  const dmA = m.deployMapFor(ps);
  h.setStage(nextId);
  const dmB = m.deployMapFor(ps);
  h.setStage(curId);
  let cell = null;
  for (const k of dmA.keys()) if (!dmB.has(k)) { cell = k; break; }
  assert.ok(cell, '两张图存在部署格差异（换图必然有人离场）');
  const [r, c] = cell.split(',').map(Number);
  const chessId = chessOfTier(1)[0];
  give(m, ps, chessId, 'board', [r, c]);
  const uid = [...ps.board.values()].find((p) => p.kind === 'chess').uid;
  const handBefore = ps.hand.filter(Boolean).length;
  // 换到下一张图（setStage 已 invalidateDeployMap → recompute 触发 jar 版 _evictIllegal）
  h.setStage(nextId);
  ps.recompute();
  assert.equal([...ps.board.values()].some((p) => p.uid === uid), false, '非法格干员已离场');
  assert.equal(ps.hand.some((p) => p && p.uid === uid), false, '不撤回整备区（手牌）');
  assert.equal(ps.temp.some((p) => p && p.uid === uid), false, '不撤回临时区');
  assert.equal(ps.hand.filter(Boolean).length, handBefore, '整备区干员数不变（没有悄悄回流）');
  h.invariants();
});

test('jar 罐子权重：后期降低干员比例（R5 前 40% → R6-10 30% → R11+ 18%）', () => {  const h = makeMatch({ mode: 'solo', humans: 1, seed: 31 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // m.wave 就绪（generateJars 需要）
  const st = m.mods.blindbox;
  const opRatio = (round, n = 60) => {
    m.round = round;
    let op = 0, all = 0;
    for (let s = 0; s < n; s++) {
      st.generate();
      for (const j of st.jars.p_0 || []) { all++; if (j.kind === 'operator') op++; }
    }
    return all ? op / all : 0;
  };
  const early = opRatio(3);
  const mid = opRatio(7);
  const late = opRatio(15);
  assert.ok(all0(early, 0.40), `R3 干员比例约 40%（${early.toFixed(3)}）`);
  assert.ok(all0(mid, 0.30), `R7 干员比例约 30%（${mid.toFixed(3)}）`);
  assert.ok(all0(late, 0.18), `R15 干员比例约 18%（${late.toFixed(3)}）`);
  assert.ok(mid < early && late < mid, '干员比例随回合递减（后期让位敌人/道具）');
  function all0(v, target) { return Math.abs(v - target) < 0.06; }
});

test('jar 敌池：同盟（coop）精英 R4 起解锁且轮转池精英双份（单机 R4 仍无精英）', () => {
  // 同盟：R4 池里已有精英（tier 2），且每个精英 key 在轮转池中出现 2 次（频率约 2 倍）
  const hc = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 33 }).start();
  const mc = hc.m;
  mc.round = 4;
  const pc = __jarEnemyTest.pool(mc);
  assert.ok(pc.some((k) => __jarEnemyTest.tier(mc, k) === 2), '同盟 R4 池里有精英');
  const firstElite = pc.find((k) => __jarEnemyTest.tier(mc, k) === 2);
  assert.equal(pc.filter((k) => k === firstElite).length, 2, '精英在轮转池中双份（更容易抽到）');
  // 同盟 R3 仍无精英（只提前一回合档，不一步到位）
  mc.round = 3;
  for (const k of __jarEnemyTest.pool(mc)) assert.ok(__jarEnemyTest.tier(mc, k) <= 1, '同盟 R3 上限老练');
  // 对照：单机 R4 上限老练（精英仍 R5 起）
  const hs = makeMatch({ mode: 'solo', humans: 1, seed: 33 }).start();
  const ms = hs.m;
  ms.round = 4;
  for (const k of __jarEnemyTest.pool(ms)) assert.ok(__jarEnemyTest.tier(ms, k) <= 1, '单机 R4 上限老练');
});
