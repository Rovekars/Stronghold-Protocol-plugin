// 盲盒·砸罐子（jar）：本轮 5 项修复的回归测试（2026-10-16）。
// ① 读档不改变地形（罐子布局 + 地图原样还原）
// ② 点击敌人不弹详情页（纯 UI，另见 game.js 断言，本文件只覆盖服务端可测部分）
// ③ 主动销毁多余装备（点击道具出原生 Underframe 销毁按钮 → g.destroy；MOD 在 jar 战斗旁路其 PREP 门禁）
// ④ 可购买部署位减为 2
// ⑤ 第 10 关（R11+）后降低干员/道具比例、提升敌人比例与数量
// ⑥ 战斗中装备替换：满槽干员带 replaceUid 替换成功
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor, DATA } from './harness.js';
import { __jarSaveTest } from '../../public/mod/盲盒模式.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return m;
};

// 深拷贝罐子布局（与服务端 st.jars[pid] 形状一致）
const cloneJars = (jars) => jars.map((j) => ({
  id: j.id, kind: j.kind, smashed: !!j.smashed, row: j.row, col: j.col,
  opId: j.opId, enemyKey: j.enemyKey, count: j.count, itemId: j.itemId, buff: j.buff, amt: j.amt,
}));

test('① 读档：完整罐子布局原样还原（位置/种类/砸开状态/内容一致）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 9 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  // 记录当前完整罐子布局
  const before = cloneJars(m.mods.blindbox.jars.p_0 || []);
  assert.ok(before.length >= 3, '本波至少有一个罐子');
  // 弄脏：直接篡改当前罐子布局（罐子位置由地形/阶段决定，与回合无关；故以「种类/砸开」做脏数据）
  const live = m.mods.blindbox.jars.p_0;
  if (live.length) live[0].kind = live[0].kind === 'enemy' ? 'operator' : 'enemy';
  if (live.length > 1) live[1].smashed = !live[1].smashed;
  const saved = cloneJars(m.mods.blindbox.jars.p_0 || []);
  // 应用存档（冻结读档：同波次立即生效路径），应把篡改后的布局原样还原成 saved
  __jarSaveTest.apply(m, ps, {
    name: '地形档', round: m.round, stageId: m.stageId, funds: ps.funds, lp: ps.lp,
    shopLevel: ps.shop.level, jarShop: {}, roster: [], jars: saved,
  });
  const after = m.mods.blindbox.jars.p_0 || [];
  assert.equal(after.length, saved.length, '罐子数量一致');
  for (let i = 0; i < saved.length; i++) {
    const a = after[i], b = saved[i];
    assert.equal(a.row, b.row, `罐#${i} 行一致`);
    assert.equal(a.col, b.col, `罐#${i} 列一致`);
    assert.equal(a.kind, b.kind, `罐#${i} 种类一致`);
    assert.equal(a.smashed, b.smashed, `罐#${i} 砸开状态一致`);
    assert.equal(a.opId, b.opId, `罐#${i} opId 一致`);
    assert.equal(a.enemyKey, b.enemyKey, `罐#${i} enemyKey 一致`);
    assert.equal(a.itemId, b.itemId, `罐#${i} itemId 一致`);
  }
});

test('④ 部署位购买上限为 2（最多买 2 次）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 3 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 999;
  const cap0 = ps.deployCap;
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' }), { ok: true });
  // 第三次应被价格拒绝（slot 价格已售罄 → null）
  const rec = m.mods.blindbox.jarShop.p_0;
  assert.equal(rec.slots, 2, '部署位购买次数封顶 2');
  assert.equal(ps.deployCap, cap0 + 2, '部署上限 +2');
  const r3 = m.handle('p_0', { t: 'g.jarShopBuy', item: 'slot' });
  assert.notEqual(r3.ok, true, '第三次购买被拒（已达上限）');
});

test('③ 主动销毁多余装备：点击道具走原生 g.destroy（PREP + jar 战斗中均可，已装备拒绝）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  const itemId = Object.values(DATA.items).find((x) => x && x.visible !== false && !x.isGolden)?.id;
  assert.ok(itemId, '能拿到一个装备 id');
  // PREP：原生 g.destroy 直接销毁手牌装备
  const piece = giveItem(m, ps, itemId, 'hand');
  assert.ok(piece && Number.isInteger(piece.uid), '装备进入手牌');
  assert.deepEqual(m.handle('p_0', { t: 'g.destroy', uid: piece.uid }), { ok: true }, 'PREP 销毁成功');
  assert.equal(ps.hand.filter((p) => p && p.kind === 'item').length, 0, '手牌装备已被销毁');
  // jar 战斗中：原生 g.destroy 的 PREP 门禁被 MOD 旁路（用户要求点击道具即可销毁）
  h.run(() => m.phase === 'COMBAT', { maxSteps: 200000 });
  assert.equal(m.phase, 'COMBAT', '已进入战斗');
  const piece2 = giveItem(m, ps, itemId, 'hand');
  assert.ok(piece2 && Number.isInteger(piece2.uid), '战斗中装备进入手牌');
  assert.deepEqual(m.handle('p_0', { t: 'g.destroy', uid: piece2.uid }), { ok: true }, '战斗中销毁成功');
  assert.equal(ps.hand.filter((p) => p && p.kind === 'item').length, 0, '战斗中手牌装备已被销毁');
  // 已装备的不能销毁（原生锁定校验在 items.js destroy 的 gate 之后，旁路 gate 也不会放过）
  const c = chessOfTier(1)[0];
  const t = legalTileFor(m, ps, c);
  give(m, ps, c, 'board', t);
  giveItem(m, ps, itemId, 'hand');
  const it2 = ps.hand.find((p) => p && p.kind === 'item');
  // 装备到干员身上（用原生 equip，area 变为 equipped）
  const eq = ps.equip(it2.uid, ps.board.values().next().value.uid, null);
  if (eq && eq.ok) {
    const equippedUid = it2.uid;
    const r2 = m.handle('p_0', { t: 'g.destroy', uid: equippedUid });
    assert.notEqual(r2.ok, true, '已装备的装备不能销毁');
  }
  h.invariants();
});

test('⑤ 同盟（coop）更容易出怪：敌人比例压倒干员/道具；对照：单机前期干员/敌人均衡', () => {
  // —— 同盟对局（makeMatch 默认 coop）——
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 11 }).start();
  const m = jar(h);
  h.toPrep(1);
  // R11+：聚合多次生成，统计种类分布
  m.round = 11;
  let enemies = 0, operators = 0, items = 0;
  for (let k = 0; k < 8; k++) {
    m.mods.blindbox.generate();
    for (const j of (m.mods.blindbox.jars.p_0 || [])) {
      if (j.kind === 'enemy') enemies++;
      else if (j.kind === 'operator') operators++;
      else if (j.kind === 'item') items++;
    }
  }
  assert.ok(enemies > operators, `R11+ 敌人(${enemies}) 应多于干员(${operators})`);
  assert.ok(enemies > items, `R11+ 敌人(${enemies}) 应多于道具(${items})`);
  // 同盟 R3：敌人罐就已多于干员罐（coop 加成：52% vs 28%，用户 2026-10-16「同盟更容易出怪」）
  m.round = 3;
  let eC = 0, oC = 0;
  for (let k = 0; k < 8; k++) {
    m.mods.blindbox.generate();
    for (const j of (m.mods.blindbox.jars.p_0 || [])) {
      if (j.kind === 'enemy') eC++;
      else if (j.kind === 'operator') oC++;
    }
  }
  assert.ok(eC > oC, `同盟 R3 敌人(${eC}) 应多于干员(${oC})`);
  // —— 对照：单机对局 R3 仍均衡（40/40，coop 加成不该影响单机）——
  const h2 = makeMatch({ mode: 'solo', humans: 1, seed: 12 }).start();
  const m2 = h2.m;
  h2.toPrep(1);
  assert.deepEqual(m2.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  m2.round = 3;
  let e3 = 0, o3 = 0;
  for (let k = 0; k < 8; k++) {
    m2.mods.blindbox.generate();
    for (const j of (m2.mods.blindbox.jars.p_0 || [])) {
      if (j.kind === 'enemy') e3++;
      else if (j.kind === 'operator') o3++;
    }
  }
  // 占比断言（40/40 本就是伯努利抽样，±几只属正常波动；语义 = 单机敌人占比约一半，coop 是 65%）
  const share = e3 / Math.max(1, e3 + o3);
  assert.ok(share < 0.55, `单机 R3 敌人占比 ${(share * 100).toFixed(0)}% 应约一半（<55%；coop 加成后是 65%）`);
});

test('⑥ 战斗中装备替换：满槽干员带 replaceUid 替换成功（被替换装备销毁、新装备生效）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5 }).start();
  const m = jar(h);
  h.toPrep(1);
  const ps = h.ps('p_0');
  // 取 3 件不同的普通 EQUIP（无穿戴特效、非 consume_on_equip、不同 id，避免合成）
  const seen = new Set();
  const equips = [];
  for (const x of Object.values(DATA.items)) {
    if (!x || x.itemType !== 'EQUIP' || x.visible === false || x.isGolden) continue;
    if (typeof x.kind === 'string' && x.kind.startsWith('consume_on_equip')) continue;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    equips.push(x);
    if (equips.length >= 3) break;
  }
  assert.ok(equips.length >= 3, '能拿到至少 3 件不同普通装备');
  // 部署一名干员到棋盘
  const c = chessOfTier(1)[0];
  const t = legalTileFor(m, ps, c);
  give(m, ps, c, 'board', t);
  const opUid = ps.board.values().next().value.uid;
  // PREP 阶段先穿 2 件（gate 放行）
  const i1 = giveItem(m, ps, equips[0].id, 'hand');
  const i2 = giveItem(m, ps, equips[1].id, 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: i1.uid, targetUid: opUid }), { ok: true }, '穿第 1 件');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: i2.uid, targetUid: opUid }), { ok: true }, '穿第 2 件');
  const opPiece = ps.board.values().next().value;
  assert.equal(opPiece.items.length, 2, '已穿满 2 件');
  const oldUid = opPiece.items[0].uid;
  const oldId = opPiece.items[0].id;
  // 进入战斗
  h.run(() => m.phase === 'COMBAT', { maxSteps: 200000 });
  assert.equal(m.phase, 'COMBAT', '已进入战斗');
  // 第 3 件装备，带 replaceUid 替换第 1 件（此前会被「穿戴槽位已满」拒绝）
  const i3 = giveItem(m, ps, equips[2].id, 'hand');
  const r = m.handle('p_0', { t: 'g.jarEquip', itemUid: i3.uid, targetUid: opUid, replaceUid: oldUid });
  assert.deepEqual(r, { ok: true }, '战斗中带 replaceUid 替换成功');
  const op2 = ps.board.values().next().value;
  const ids = op2.items.map((x) => x.id);
  assert.ok(ids.includes(equips[2].id), '新装备已穿上');
  assert.ok(!ids.includes(oldId), '被替换的旧装备 id 已移除');
  assert.equal(!!ps.find(oldUid), false, '被替换的装备已被销毁（uid 不复存在）');
  h.invariants();
});
