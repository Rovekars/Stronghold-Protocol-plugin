// 盲盒·砸罐子（jar）：多档存档/读档（用户需求 2026-10-14）——服务端快照应用。
// 存：回合/资金/生命/调度中心等级/jarShop(部署位·生命·复活·障碍物库存)/干员阵容(整备区+场上+临时)。
// 读：g.jarLoadSave 暂存 → 下一波 startRound 边界 jarApplyLoad 恢复（不跳回合，避开 jar 600ms 休整期竞态）。
// 本文件覆盖：快照应用恢复标量 + jarShop + 重建干员阵容，且引擎不变量成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor } from './harness.js';
import { __jarSaveTest } from '../../public/mod/盲盒模式.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return m;
};

// 从 ps 当前状态构造快照 roster（与服务端 jarApplyLoad 期望的形状一致）
const snapRoster = (ps) => {
  const out = [];
  for (const [k, p] of ps.board) {
    if (p.kind !== 'chess') continue;
    const [r, c] = k.split(',').map(Number);
    out.push({ kind: 'chess', id: p.id, area: 'board', row: r, col: c, dir: p.dir, items: (p.items || []).map((i) => i.id) });
  }
  for (const p of ps.hand) if (p && p.kind === 'chess') out.push({ kind: 'chess', id: p.id, area: 'hand', items: (p.items || []).map((i) => i.id) });
  for (const p of ps.temp) if (p && p.kind === 'chess') out.push({ kind: 'chess', id: p.id, area: 'temp', items: (p.items || []).map((i) => i.id) });
  for (const p of ps.hand) if (p && p.kind === 'item') out.push({ kind: 'item', id: p.id, area: 'hand' });
  for (const p of ps.temp) if (p && p.kind === 'item') out.push({ kind: 'item', id: p.id, area: 'temp' });
  return out;
};

test('jar 存档：应用快照恢复资金/生命/部署位/jarShop/干员阵容，引擎不变量成立', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  const c1 = chessOfTier(1)[0];
  const c2 = chessOfTier(1)[1] || chessOfTier(1)[0];
  const c3 = chessOfTier(2)[0];
  const t1 = legalTileFor(m, ps, c1);
  assert.ok(t1, '能找到合法部署格');
  // 初始状态：1 场上 + 2 手牌；资金/生命；买部署位 + 2 个初级障碍物
  give(m, ps, c1, 'board', t1);
  give(m, ps, c2, 'hand');
  give(m, ps, c3, 'hand');
  ps.funds = 100; ps.lp = 5;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' }), { ok: true });
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' });
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'obstacleBasic' });
  const saved = {
    name: '测试档', round: m.round, stageId: m.stageId, funds: 100, lp: 5, shopLevel: ps.shop.level,
    jarShop: { slots: 1, life: 0, revive: 0, obsBasic: 2, obsAdvanced: 0 },
    roster: snapRoster(ps),
  };
  assert.equal(saved.roster.filter((e) => e.area === 'board').length, 1, '快照含 1 个场上干员');
  assert.equal(saved.roster.filter((e) => e.area === 'hand').length, 2, '快照含 2 个手牌干员');

  // 弄脏状态：清空阵容 + 改标量 + 买生命（改 jarShop/lp）
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
  ps.funds = 0; ps.lp = 1;
  m.handle('p_0', { t: 'g.jarShopBuy', item: 'life' });

  // 应用存档
  __jarSaveTest.apply(m, ps, saved);

  // 断言恢复
  assert.equal(ps.funds, 100, '资金恢复');
  assert.equal(ps.lp, 5, '生命恢复');
  assert.equal(ps.deployCapBonus, 1, '部署位加成恢复');
  const rec = m.mods.blindbox.jarShop.p_0;
  assert.equal(rec.slots, 1, 'jarShop.slots 恢复');
  assert.equal(rec.obsBasic, 2, 'jarShop.obsBasic 恢复');
  assert.equal(rec.life, 0, 'jarShop.life 恢复（覆盖弄脏时买的生命）');
  assert.equal(ps.board.size, 1, '场上 1 干员恢复');
  assert.equal(ps.hand.filter(Boolean).length, 2, '手牌 2 干员恢复');
  h.invariants();
});

test('jar 存档：开局选择页读档（第 1 波休整期）立即生效', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 0; ps.lp = 1;
  const data = { name: '开局档', round: 1, funds: 42, lp: 3, shopLevel: 1, jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 }, roster: [] };
  assert.deepEqual(m.handle('p_0', { t: 'g.jarLoadSave', data }), { ok: true });
  const st = m.mods.blindbox;
  assert.equal(ps.funds, 42, '第 1 波休整期读档：资金立即恢复');
  assert.equal(ps.lp, 3, '第 1 波休整期读档：生命立即恢复');
  assert.ok(!st.pendingLoad || !st.pendingLoad.p_0, '立即生效时不再挂 pendingLoad');
});

test('jar 存档：第 2 波起读档暂存到 pendingLoad（下一波 startRound 生效）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  const fundsBefore = ps.funds;
  m.round = 2; // 非首波：走暂存路径
  const data = { name: '暂存档', funds: 42, lp: 3, shopLevel: 1, jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 }, roster: [] };
  assert.deepEqual(m.handle('p_0', { t: 'g.jarLoadSave', data }), { ok: true });
  const st = m.mods.blindbox;
  assert.ok(st.pendingLoad && st.pendingLoad.p_0, '快照已暂存到 pendingLoad');
  assert.equal(st.pendingLoad.p_0.funds, 42, '暂存内容正确');
  assert.equal(ps.funds, fundsBefore, '暂存时不立即改状态');
});

test('jar 存档：非 jar 模式拒绝读档', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  h.toPrep(1);
  assert.notEqual(h.m.handle('p_0', { t: 'g.jarLoadSave', data: { roster: [] } }).ok, true, '非 jar 拒绝');
});

test('jar 存档：应用快照恢复独立道具（开罐子获得、尚未装到干员身上的装备）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  const it = giveItem(m, ps, 'chess_item_1_01_e_a', 'hand');
  assert.ok(it && it.kind === 'item', '能放一个道具到手牌');
  const saved = {
    name: '道具档', round: m.round, stageId: m.stageId, funds: ps.funds, lp: ps.lp, shopLevel: ps.shop.level,
    jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 }, roster: snapRoster(ps),
  };
  assert.ok(saved.roster.some((e) => e.kind === 'item'), '快照含独立道具');
  // 弄脏：移除手牌里的道具
  for (let i = 0; i < ps.hand.length; i++) if (ps.hand[i] && ps.hand[i].kind === 'item') ps.hand[i] = null;
  ps.recompute();
  __jarSaveTest.apply(m, ps, saved);
  const restored = [...ps.hand, ...ps.temp].filter(Boolean).filter((p) => p.kind === 'item').map((p) => p.id);
  assert.ok(restored.includes('chess_item_1_01_e_a'), '独立道具被恢复');
  h.invariants();
});

test('jar 存档：同地图恢复已部署障碍物位置，换地图只恢复库存数量（不改动地形）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 7 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  const stageId = m.stageId;
  const obs = [{ tier: 'basic', row: 9, col: 3 }, { tier: 'advanced', row: 10, col: 4 }];
  // 同地图：障碍物位置 + 库存数量都恢复
  const savedSame = {
    name: '同图档', round: m.round, stageId, funds: 0, lp: 1, shopLevel: 1,
    jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 2, obsAdvanced: 1 }, obstacles: obs, roster: [],
  };
  __jarSaveTest.apply(m, ps, savedSame);
  const same = m.mods.blindbox.jarObstacles.p_0;
  assert.equal(same.length, 2, '同地图：已部署障碍物位置恢复');
  assert.deepEqual(same[0], { tier: 'basic', row: 9, col: 3 }, '位置精确恢复');
  // 换地图：先把已部署清空，再读一个 stageId 不同的档，确认不把旧障碍重铺进来（避免改地形）
  m.mods.blindbox.jarObstacles.p_0 = [];
  const savedDiff = {
    name: '换图档', round: m.round, stageId: 'OTHER_STAGE_X', funds: 0, lp: 1, shopLevel: 1,
    jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 2, obsAdvanced: 1 }, obstacles: obs, roster: [],
  };
  __jarSaveTest.apply(m, ps, savedDiff);
  const diff = m.mods.blindbox.jarObstacles.p_0;
  assert.equal(diff.length, 0, '换地图：不恢复障碍物位置（避免改地形）');
  const rec = m.mods.blindbox.jarShop.p_0;
  assert.equal(rec.obsBasic, 2, '换地图：障碍物库存数量仍恢复');
});

test('jar 存档：g.jarStartAndLoad 在 LOBBY 阶段被拒（须 room.start 后才能激活 jar）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 5 }); // 未 start：停在 LOBBY
  const r = h.m.handle('p_0', { t: 'g.jarStartAndLoad', data: { roster: [] } });
  assert.ok(r && r.error, `LOBBY 阶段应被拒，实际 ${JSON.stringify(r)}`);
});

test('jar 存档：g.jarStartAndLoad 跳过 briefing/策略选择直接进 round1 休整期并应用读档', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 11 }).start();
  const m = h.m;
  assert.equal(m.phase, 'INFO_CHECK', '建房开战后先停在确认本局信息');
  // 非 jar 模式下一键读档被拒（fuzz / 其他流程不得借道开无尽模式）
  assert.ok(m.handle('p_0', { t: 'g.jarStartAndLoad', data: { roster: [] } }).error, '非 jar 模式拒绝');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true }, '离开 LOBBY 后可激活 jar');
  const data = {
    name: '开局档', round: 1, stageId: m.stageId, funds: 42, lp: 7, shopLevel: 1,
    jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 }, roster: [],
  };
  assert.deepEqual(m.handle('p_0', { t: 'g.jarStartAndLoad', data }), { ok: true });
  // 自动推进：INFO_CHECK → BAND_DRAFT → BATTLE_CHECK → ROUND_START（solo 单人默认策略）
  assert.equal(m.phase, 'ROUND_START', `应直接开始 round1，实际 ${m.phase}`);
  const stateMsg = h.lastBc('m.blindBoxState');
  assert.equal(stateMsg && stateMsg.mode, 'jar', '已广播 jar 模式');
  // 推进到休整期（round1 的读档已在 startRound 边界由 MOD 包装器应用）
  h.run(() => m.phase === 'PREP' && m.round === 1, { maxSteps: 200000 });
  assert.equal(m.phase, 'PREP', '应进入 round1 休整期');
  const ps = h.ps('p_0');
  assert.equal(ps.funds, 42, '读档资金已在 round1 生效');
  assert.equal(ps.lp, 7, '读档生命已在 round1 生效');
  h.invariants();
});

test('jar 存档：冻结关卡——按存档回合开波，同图恢复障碍物 + 本波已砸开罐子', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 13 }).start();
  const m = h.m;
  assert.equal(m.phase, 'INFO_CHECK', '建房开战后先停在确认本局信息');
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); h.toPrep(2); h.toPrep(3); // 逐波推进到 R3 休整期（jar 无休整期，罐子已生成）
  assert.equal(m.round, 3);
  const st = m.mods.blindbox;
  const jarsNow = st.jars.p_0 || [];
  assert.ok(jarsNow.length > 2, '本波罐子已生成');
  const smashed = [
    { row: jarsNow[0].row, col: jarsNow[0].col },
    { row: jarsNow[1].row, col: jarsNow[1].col },
  ];
  const obstacles = [{ tier: 'basic', row: 9, col: 3 }, { tier: 'advanced', row: 10, col: 4 }];
  const data = {
    name: '冻结档', round: 3, stageId: m.stageId, funds: 77, lp: 6, shopLevel: 2,
    jarShop: { slots: 1, life: 0, revive: 0, obsBasic: 1, obsAdvanced: 1 },
    obstacles, jars: smashed, roster: [],
  };
  // 模拟大厅一键读档的暂存形状（__freeze），再经 startRound 包装器开波
  st.pendingLoad.p_0 = { ...data, __freeze: true };
  m.startRound(1); // 包装器应把 round 1 改写成存档的 round 3（冻结关卡）
  assert.equal(m.round, 3, '冻结：按存档回合开波');
  assert.equal(m.stageId, data.stageId, '冻结：地形与存档一致');
  assert.equal(h.ps('p_0').funds, 77, '冻结：资金已恢复');
  assert.equal(h.ps('p_0').lp, 6, '冻结：生命已恢复');
  assert.equal(st.jarObstacles.p_0.length, 2, '冻结：同图恢复已部署障碍物');
  // 推进到该波休整期：enterPrep 的 phase hook 重新生成罐子后，按存档标记已砸开状态
  h.run(() => m.phase === 'PREP' && m.round === 3, { maxSteps: 200000 });
  const jars3 = st.jars.p_0 || [];
  const want = new Set(smashed.map((j) => `${j.row},${j.col}`));
  for (const j of jars3) if (want.has(`${j.row},${j.col}`)) assert.equal(j.smashed, true, '冻结：已砸开罐子恢复为已砸开');
  assert.equal(jars3.filter((j) => j.smashed).length, smashed.length, '冻结：恰好恢复存档时已砸开的数量，其余保持未砸开');
  h.invariants();
});

test('jar 存档：同波次战斗中读档立即生效（冻结当前关卡：罐子砸开状态就地恢复 + 地形恢复）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 17 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); // R1 PREP：罐子生成 → 600ms 后自动开战（jar 无休整期）
  h.run(() => m.phase === 'COMBAT', { maxSteps: 200000 });
  assert.equal(m.phase, 'COMBAT', 'jar 自动开战');
  const st = m.mods.blindbox;
  const jars = st.jars.p_0 || [];
  assert.ok(jars.length > 2, '本波罐子已生成');
  const smashed = [
    { row: jars[0].row, col: jars[0].col },
    { row: jars[1].row, col: jars[1].col },
  ];
  const obstacles = [{ tier: 'basic', row: 9, col: 3 }];
  const data = {
    name: '同波档', round: m.round, stageId: m.stageId, funds: 55, lp: 4, shopLevel: 1,
    jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 1, obsAdvanced: 0 },
    obstacles, jars: smashed, roster: [],
  };
  assert.deepEqual(m.handle('p_0', { t: 'g.jarLoadSave', data }), { ok: true });
  // 同波次读档立即生效（不再等下一波）：标量恢复
  assert.equal(h.ps('p_0').funds, 55, '同波读档立即恢复资金');
  assert.equal(h.ps('p_0').lp, 4, '同波读档立即恢复生命');
  // 罐子砸开状态就地恢复（本波罐子不会重生成）
  const want = new Set(smashed.map((j) => `${j.row},${j.col}`));
  for (const j of (st.jars.p_0 || [])) if (want.has(`${j.row},${j.col}`)) assert.equal(j.smashed, true, '同波读档罐子就地恢复');
  assert.equal((st.jars.p_0 || []).filter((j) => j.smashed).length, smashed.length, '恰好恢复存档时已砸开的数量');
  // 同图恢复已部署障碍物
  assert.equal(st.jarObstacles.p_0.length, 1, '同图恢复已部署障碍物');
  h.invariants();
});

test('jar 存档：冻结读档后「已砸开敌人罐」放出的敌人会重新注入战场（防读档后敌人卡没掉）', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 13 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); h.toPrep(2); h.toPrep(3); // 逐波推进到 R3 休整期（罐子已生成）
  assert.equal(m.round, 3);
  const st = m.mods.blindbox;
  const jarsNow = st.jars.p_0 || [];
  assert.ok(jarsNow.length > 2, '本波罐子已生成');
  const enemyKey = Object.keys(m.gd.raw.enemies || {}).find((k) => { const e = m.gd.enemy(k); return e && e.stats; });
  assert.ok(enemyKey, '能取到有效敌人 key');
  // 存档里把某个已砸开罐子记为「敌人罐」，带 enemyKey/count——模拟「砸开敌人罐 + 覆盖保存」的快照
  const smashed = [{ row: jarsNow[0].row, col: jarsNow[0].col, kind: 'enemy', enemyKey, count: 1 }];
  const data = {
    name: '敌人冻结档', round: 3, stageId: m.stageId, funds: 77, lp: 6, shopLevel: 2,
    jarShop: { slots: 1, life: 0, revive: 0, obsBasic: 1, obsAdvanced: 1 },
    obstacles: [], jars: smashed, roster: [],
  };
  st.pendingLoad.p_0 = { ...data, __freeze: true };
  m.startRound(1); // 包装器按存档回合开波（冻结关卡 R3）
  assert.equal(m.round, 3, '冻结：按存档回合开波');
  h.run(() => m.phase === 'PREP' && m.round === 3, { maxSteps: 200000 });
  h.run(() => m.phase === 'COMBAT', { maxSteps: 200000 });
  const f = (m.fields || []).find((x) => x && x.live && Array.isArray(x.players) && x.players.includes('p_0'));
  assert.ok(f, '读档后本波战斗已建立（live field 存在）');
  // 注入发生在 endPrep（与 jarRespawnObstacles 同时机）：敌人带 tag 'bounty' 进入战场（headless 下落在 battle._pending；
  // 客户端模拟下在 f.spec.spawns）。这里两处都查，覆盖两套战斗后端。
  const pending = (f.battle && Array.isArray(f.battle._pending) ? f.battle._pending : []);
  const specSpawns = (f.spec && Array.isArray(f.spec.spawns) ? f.spec.spawns : []);
  const injected = [...pending, ...specSpawns].filter((s) => s && s.enemyKey === enemyKey && s.tag === 'bounty');
  assert.ok(injected.length >= 1, `冻结读档后罐中敌人被重新注入战场（找到 ${injected.length} 条 ${enemyKey} 注入记录）`);
  // 罐子本身仍被标记为已砸开（冻结关卡：不重复发放内容，只恢复敌人）
  const jars3 = st.jars.p_0 || [];
  const want = `${smashed[0].row},${smashed[0].col}`;
  assert.ok(jars3.some((j) => `${j.row},${j.col}` === want && j.smashed), '冻结：该罐子恢复为已砸开（不重复发放）');
  h.invariants();
});

test('jar 存档：普通（非敌人）罐子读档不触发敌人注入', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 13 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1); h.toPrep(2); h.toPrep(3);
  const st = m.mods.blindbox;
  const jarsNow = st.jars.p_0 || [];
  // 只传 {row,col}（旧快照形状，无 kind）：不应有任何敌人注入
  const smashed = [{ row: jarsNow[0].row, col: jarsNow[0].col }];
  const data = { name: '旧形状档', round: 3, stageId: m.stageId, funds: 1, lp: 1, shopLevel: 1, jarShop: { slots: 0, life: 0, revive: 0, obsBasic: 0, obsAdvanced: 0 }, obstacles: [], jars: smashed, roster: [] };
  st.pendingLoad.p_0 = { ...data, __freeze: true };
  m.startRound(1);
  h.run(() => m.phase === 'PREP' && m.round === 3, { maxSteps: 200000 });
  h.run(() => m.phase === 'COMBAT', { maxSteps: 200000 });
  const f = (m.fields || []).find((x) => x && x.live && Array.isArray(x.players) && x.players.includes('p_0'));
  const pending = (f && f.battle && Array.isArray(f.battle._pending) ? f.battle._pending : []);
  const specSpawns = (f && f.spec && Array.isArray(f.spec.spawns) ? f.spec.spawns : []);
  assert.equal([...pending, ...specSpawns].filter((s) => s && s.tag === 'bounty').length, 0, '旧形状存档（无 kind）不触发敌人注入');
  h.invariants();
});
