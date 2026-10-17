// 复现脚本：盲盒商店模式 → 进 PREP → 检查商店是否真的变成盲盒（价格 = 调度中心等级）
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const MODE = process.env.BB_MODE || 'shop';
const ROOM = process.env.BB_ROOM || 'solo'; // solo = 独立模拟；coop = 同盟模拟（1 人开局，对齐用户实测路径）
const FAIL = []; // 断言失败收集：非空则进程退出码 1
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'repro', { prefix: 'repro' });
const log = (...a) => console.log('[repro]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await c.open();
  await c.page.evaluate((m) => localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: m })), MODE);
  log('pref:', await c.page.evaluate(() => localStorage.getItem('sp.blindbox.pref')));
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('杜宾');
  if (ROOM === 'coop') {
    await c.click('.mode-card', '同盟模拟');
    await c.click('.diff-card', process.env.BB_DIFF || '绝境模拟');
    await c.click('.create-box button', '创建同盟');
    await c.waitFor((s) => !!s.room?.code, 'coop room', 30000);
    log('coop room reached');
  } else {
    await c.click('.mode-card', '独立模拟');
    await c.click('.diff-card', process.env.BB_DIFF || '绝境模拟');
    await c.click('.create-box button', '开始独立模拟');
    await c.waitFor((s) => !!s.room, 'solo room', 30000);
    log('room reached');
  }
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  const s0 = await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  log('reached', s0.phase, 'round', s0.round);
  await sleep(1200);
  const info = await c.page.evaluate(() => {
    const st = globalThis.__SP__.store.get();
    const priv = st.match.private || {};
    const slots = priv.shop?.slots || [];
    return {
      level: priv.shop?.level ?? null,
      slotPrices: slots.map((s) => (s && s.price != null ? s.price : null)),
      slotNames: slots.map((s) => (s && (s.card?.name || s.name)) ?? null),
      blindCards: document.querySelectorAll('.scard--blind').length,
      allCards: document.querySelectorAll('.scard').length,
      jarEls: document.querySelectorAll('.scard--jar').length,
      shopText: (document.querySelector('.shopbar')?.textContent || '').slice(0, 240),
      overlays: (document.querySelector('.shopbar')?.className) || null,
    };
  });
  log('PREP SNAPSHOT:', JSON.stringify(info, null, 2));
  await c.shot('repro-shop');
  if (MODE === 'jar') {
    const before = await c.page.evaluate(() => {
      const priv = globalThis.__SP__.store.get().match.private || {};
      const f = document.querySelector('.jarfield');
      const r = f && f.getBoundingClientRect();
      return {
        jarCount: (priv.jars || []).length,
        jarGrid: priv.jarGrid || null,
        field: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null,
        viewport: { w: innerWidth, h: innerHeight },
        // 商店栏里不能有商店卡：只剩 lvcard + funds
        shopCards: document.querySelectorAll('.shopbar .scard:not(.scard--jar)').length,
        lvcard: document.querySelectorAll('.shopbar .lvcard').length,
        funds: document.querySelectorAll('.shopbar .funds').length,
        shopText: (document.querySelector('.shopbar')?.textContent || '').slice(0, 240),
        jarCell: (() => {
          const b = document.querySelector('.scard--jar');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const s = b.querySelector('span');
          const sr = s && s.getBoundingClientRect();
          return {
            btn: { w: Math.round(r.width), h: Math.round(r.height) },
            body: sr ? { w: Math.round(sr.width), h: Math.round(sr.height), dx: Math.round((sr.left + sr.width / 2) - (r.left + r.width / 2)) } : null,
          };
        })(),
        // 罐子是否真的贴在战场不同格子上（而不是叠在 0,0）
        jarPositions: [...document.querySelectorAll('.jar-slot')].map((n) => {
          const r = n.getBoundingClientRect();
          return `${Math.round(r.left)}x${Math.round(r.top)}@${Math.round(r.width)}`;
        }).sort(),
        readyVisible: !!document.querySelector('.readybtn') && (() => {
          const b = document.querySelector('.readybtn').getBoundingClientRect();
          const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!(el && el.closest('.readybtn'));
        })(),
      };
    });
    log('JAR FIELD SNAPSHOT:', JSON.stringify(before, null, 2));
    if (before.jarCell && before.jarCell.body) FAIL.push('罐身上还有残留覆盖物（应只有花瓶贴图）');
    // 收起按钮已删：工具栏里不允许出现「收起/展开战场罐子」
    const barText = await c.page.evaluate(() => (document.querySelector('.shopbar')?.textContent || ''));
    if (/收起战场罐子|展开战场罐子/.test(barText)) FAIL.push('罐子阵不该再有收起/展开按钮');

    // —— 无休整期（新流程）：PREP 只闪一瞬（罐子生成 → ~600ms 后自动开战），全程战斗中砸罐 / 部署 / 穿装 ——
    // ① 自动开战 + 5 秒入场缓冲
    const auto = await c.page.evaluate(async () => {
      const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = () => globalThis.__SP__.store.get();
      const t0 = Date.now();
      for (let i = 0; i < 60 && st().match.public.phase !== 'COMBAT'; i++) await sleepL(100);
      const phase = st().match.public.phase;
      const jars = (st().match.private?.jars || []);
      const bid = (st().match.battle || {}).battleId || null;
      const fid = (st().match.field || {}).fieldId || (st().match.battle || {}).fieldId || null;
      const spawnedFoes = () => {
        const r = globalThis.__SP_RUNNER__;
        const list = r && typeof r.fieldUnits === 'function' && fid ? (r.fieldUnits(fid) || []) : [];
        return list.filter((u) => u && u.side === 'enemy').length;
      };
      const enemiesEarly = spawnedFoes(); // 战斗刚开始：不应有任何敌人（波次敌人已禁用）
      const earlyT = Date.now() - t0;
      await sleepL(6500);
      return { phase, earlyT, jarCount: jars.length, bid, enemiesEarly, enemiesAfterBuffer: spawnedFoes() };
    });
    log('AUTO COMBAT:', JSON.stringify(auto));
    await c.shot('repro-jar-auto-combat');
    if (auto.phase !== 'COMBAT') FAIL.push(`PREP 没有自动转入战斗（phase=${auto.phase}）——无休整期流程失效`);
    if (auto.jarCount < 5) FAIL.push(`罐子没生成（只有 ${auto.jarCount} 个）`);
    if (auto.enemiesEarly > 0) FAIL.push(`未砸罐就出现敌人（${auto.enemiesEarly} 个）——jar 模式所有怪只能来自罐子`);
    if (auto.enemiesAfterBuffer > 0) FAIL.push(`未砸罐 6.5 秒后仍有波次敌人（${auto.enemiesAfterBuffer} 个）——本波敌人应全部禁用`);

    // ①b 敌人只能来自罐子、砸开后 5 真实秒（10 战斗秒）才出：连砸 4 个罐（客户端看不到罐子种类），
    // 记录敌人首次出现时刻；触发罐 = 首次出现前 ≥4s 的最后一个砸罐（敌人 5 秒后才走出，更晚的砸罐来不及）。
    // 未命中（敌人罐 ~40%）再补一批，两批全 Miss（~1.7%）只记 NOTE——探针步骤还会补砸。
    const fromJar = await c.page.evaluate(async () => {
      const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
      const st = () => globalThis.__SP__.store.get();
      const net = globalThis.__SP__.net;
      const fid = (st().match.field || {}).fieldId || (st().match.battle || {}).fieldId || null;
      const r = globalThis.__SP_RUNNER__;
      const foes = () => {
        const list = r && typeof r.fieldUnits === 'function' && fid ? (r.fieldUnits(fid) || []) : [];
        return list.filter((u) => u && u.side === 'enemy').length;
      };
      const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
      const t0 = Date.now();
      const smashes = [];
      let firstFoesAt = null;
      for (let batch = 0; batch < 2 && firstFoesAt === null; batch++) {
        const js = jars();
        for (let i = 0; i < 4 && i < js.length; i++) {
          try { await net.request('g.smashJar', { jarId: js[i].id }); smashes.push(Date.now() - t0); } catch { /* ignore */ }
          await sleepL(500);
        }
        for (let k = 0; k < 16 && firstFoesAt === null; k++) { // 每批后观察 6.4s（覆盖 5 秒出场缓冲）
          await sleepL(400);
          if (foes() > 0) firstFoesAt = Date.now() - t0;
        }
      }
      let trigger = null;
      if (firstFoesAt !== null) {
        for (const s of smashes) if (s <= firstFoesAt - 4000) trigger = s; // 最后一个 ≤ 首次出现-4s 的砸罐
      }
      return { smashed: smashes.length, firstFoesAt, trigger, delay: trigger !== null ? firstFoesAt - trigger : null };
    });
    log('ENEMY FROM JAR:', JSON.stringify(fromJar));
    if (fromJar.firstFoesAt === null) log(`NOTE: 砸了 ${fromJar.smashed} 罐没触发敌人罐（小概率），延迟断言跳过——探针步骤会补砸`);
    else if (fromJar.trigger === null) FAIL.push(`敌人出现得离砸罐太近（${fromJar.firstFoesAt}ms）——5 秒出场缓冲失效`);
    else if (fromJar.delay < 4000) FAIL.push(`敌人出现得太快（砸罐后 ${fromJar.delay}ms）——5 秒出场缓冲失效`);
    else if (fromJar.delay > 13000) FAIL.push(`敌人出现得太慢（砸罐后 ${fromJar.delay}ms）——出场缓冲异常`);

    // ② 战斗中砸罐拿干员+道具（全程 COMBAT，无隐藏运行、无红点标记层）
    const gather = await c.page.evaluate(async () => {
      const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
      const net = globalThis.__SP__.net;
      const st = () => globalThis.__SP__.store.get();
      const jars = () => (st().match.private?.jars || []).filter((j) => j && !j.smashed);
      const handPieces = (kind) => {
        const priv = st().match.private || {};
        return [...(priv.temp || []), ...(priv.hand || [])].filter((p) => p && p.kind === kind);
      };
      let smashed = 0;
      for (let i = 0; i < 25 && jars().length > 1; i++) {
        // 至少砸 3 罐再考虑提前收工：开局手里往往已有干员+道具，否则一次都不砸就 break，
        // 既没验证「战斗中砸罐」、smashed=0 还会被下面的断言误判成失败。
        if (smashed >= 3 && handPieces('chess').length && handPieces('item').length) break;
        try { await net.request('g.smashJar', { jarId: jars()[0].id }); smashed++; } catch { /* ignore */ }
        await sleepL(500);
      }
      return { smashed, chess: handPieces('chess').length, items: handPieces('item').length, left: jars().length, phase: st().match.public.phase };
    });
    log('MID-COMBAT GATHER:', JSON.stringify(gather));
    if (gather.phase !== 'COMBAT') FAIL.push(`砸罐过程中 phase 变成了 ${gather.phase}（应全程战斗）`);
    if (!gather.smashed) FAIL.push('战斗中一个罐都没砸开');
    if (gather.chess === 0) log('NOTE: 没砸到干员罐（概率），跳过部署/穿装验证');

    // 诊断：记录战斗期所有 spawn 事件（id/defId/spine）
    await c.page.evaluate(() => {
      const r = globalThis.__SP_RUNNER__;
      if (r && !r.__spawnLog) {
        r.__spawnLog = [];
        r.on('ev', (m) => { if (m && Array.isArray(m.ev)) for (const e of m.ev) if (e && e[0] === 'spawn') r.__spawnLog.push({ id: e[1] && e[1].id, defId: e[1] && e[1].defId, spine: e[1] && e[1].spine }); });
      }
    });
    // ③ 战斗中部署干员 + 即时穿装（g.move 落格注入 → g.jarEquip 战斗内生效）
    const mc = await c.page.evaluate(async () => {
      const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
      const net = globalThis.__SP__.net;
      const st = () => globalThis.__SP__.store.get();
      const jars = () => (st().match.private?.jars || []).filter((j) => j && !j.smashed);
      const handPieces = (kind) => {
        const priv = st().match.private || {};
        return [...(priv.temp || []), ...(priv.hand || [])].filter((p) => p && p.kind === kind);
      };
      const runner = globalThis.__SP_RUNNER__;
      const bid = (st().match.battle || {}).battleId || null;
      const allyOf = (uid) => {
        const e = bid && runner && runner._entries ? runner._entries.get(bid) : null;
        return e && e.battle && Array.isArray(e.battle.allyUnits) ? e.battle.allyUnits.find((x) => x && x.uid === uid) || null : null;
      };
      const out = {};
      const piece = handPieces('chess')[0] || null;
      if (!piece) return { noChess: true };
      const jarTiles = new Set(jars().map((j) => `${j.row},${j.col}`));
      const errors = [];
      for (let r = 9; r <= 12 && !out.deployed; r++) {
        for (let c2 = 2; c2 <= 10 && !out.deployed; c2++) {
          if (jarTiles.has(`${r},${c2}`)) continue;
          try { await net.request('g.move', { uid: piece.uid, to: { area: 'board', row: r, col: c2 } }); } catch (e) { errors.push(`${r},${c2}:${e.message || e}`); continue; }
          await sleepL(500);
          if ((st().match.private.board || []).filter(Boolean).some((b) => b && b.uid === piece.uid)) out.deployed = true;
        }
      }
      await sleepL(600);
      out.uid = piece.uid;
      out.allyInjected = !!allyOf(piece.uid);
      out.errors = errors.slice(0, 4);
      const handItems = handPieces('item');
      if (!handItems.length) { out.noItem = true; return out; }
      // 优先找纯属性装备（EQUIP 且非 consume_on_equip / 无 onEquip 特效）→ 应穿装成功；
      // 只有特效道具时 → 反向断言「已部署目标被按设计拒绝」。
      const plain = handItems.find((p) => {
        const r = globalThis.__SP__.data.lookup('items', p.id);
        return r && r.itemType === 'EQUIP' && !(typeof r.kind === 'string' && r.kind.startsWith('consume_on_equip'));
      });
      const item = plain || handItems[0];
      out.specialOnly = !plain;
      // 穿装诊断：装备记录、所在区、目标已穿件数
      const irec = globalThis.__SP__.data.lookup('items', item.id);
      const priv0 = st().match.private || {};
      const locDesc = [...(priv0.hand || [])].some((p) => p && p.uid === item.uid) ? 'hand'
        : [...(priv0.temp || [])].some((p) => p && p.uid === item.uid) ? 'temp' : 'other';
      out.diag = { itemId: item.id, itemType: irec ? irec.itemType : null, kind: irec ? irec.kind ?? null : null, loc: locDesc, targetItems: ((priv0.board || []).filter(Boolean).find((b) => b && b.uid === piece.uid) || {}).items?.length ?? null };
      try { await net.request('g.jarEquip', { itemUid: item.uid, targetUid: piece.uid }); out.equipped = true; }
      catch (e) { out.equipError = e.message || String(e); }
      await sleepL(800);
      const au = allyOf(piece.uid);
      out.unitItems = au && Array.isArray(au.items) ? [...au.items] : null;
      const bp = (st().match.private.board || []).filter(Boolean).find((b) => b && b.uid === piece.uid);
      out.pieceItems = bp && Array.isArray(bp.items) ? bp.items.map((x) => x && x.id) : null;
      return out;
    });
    log('MID-COMBAT DEPLOY+EQUIP:', JSON.stringify(mc));
    await c.shot('repro-jar-mid-combat-deploy');
    if (!mc.noChess) {
      if (!mc.deployed) FAIL.push(`战斗中部署干员失败${mc.errors && mc.errors.length ? '：' + mc.errors.join(' / ') : ''}`);
      else if (!mc.allyInjected) FAIL.push('干员落格但没注入战斗（battle.allyUnits 缺该 uid）');
      if (mc.noItem) log('NOTE: 没砸到道具罐（概率），跳过穿装验证');
      else if (mc.specialOnly && !mc.equipped) log('NOTE: 只有特效道具——已部署目标被按设计拒绝（保护逻辑生效）✓');
      else if (!mc.equipped) FAIL.push(`战斗中穿装失败：${mc.equipError || '未知'}`);
      else if (!mc.unitItems || !mc.unitItems.length) FAIL.push('穿装请求成功但战斗单位没有装备（b.jarEquip 链路断）');
      else if (!mc.pieceItems || !mc.pieceItems.length) FAIL.push('战斗单位有装备但私有视图棋子没有（记账不同步）');
    }
      // ③b 钻石占位诊断：sim 里的敌人（fieldMeta.units，带 spine）vs 渲染层 infos/views（_unknown = 钻石）
      await sleep(1500);
      // 攻击动画健康度：jar 模式下敌人只来自罐子——先保证场上有敌人（没有就砸罐，敌人 5 秒后出场），
      // 再轮询最多 ~50s 等干员普攻（敌人从出生点走到部署线需要时间），读每个视图的 actor 攻击剪辑与 lastAtk。
      const atk = await c.page.evaluate(async () => {
        const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
        const st = () => globalThis.__SP__.store.get();
        const net = globalThis.__SP__.net;
        const r = globalThis.__SP_RUNNER__;
        const fid = (st().match.field || {}).fieldId || (st().match.battle || {}).fieldId || null;
        const foes = () => {
          const list = r && typeof r.fieldUnits === 'function' && fid ? (r.fieldUnits(fid) || []) : [];
          return list.filter((u) => u && u.side === 'enemy' && u.alive !== false).length;
        };
        const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
        const probe = () => {
          const v = globalThis.__SP_VIEW__;
          const d = v && v.raw && typeof v.raw.debugUnits === 'function' ? v.raw.debugUnits() : null;
          if (!d) return { error: 'no debugUnits' };
          const allies = d.infos.filter((i) => i.side !== 'enemy').map((i) => i.id);
          const probed = d.views.filter((x) => allies.includes(x.id));
          const isDevice = (x) => { const inf = d.infos.find((i) => i.id === x.id); return (inf && inf.kind === 'device') || (typeof x.spine === 'string' && x.spine.startsWith('trap_')); };
          const ops = probed.filter((x) => !isDevice(x));
          return {
            allies: probed,
            attacked: ops.filter((x) => x.hasActor && x.lastAtk !== null && x.lastAtk >= 0).length,
            noActor: ops.filter((x) => !x.hasActor).map((x) => x.id),
            clipMissing: ops.filter((x) => x.hasActor && x.atkRoles && x.atkLoopLoaded === false).map((x) => x.id),
          };
        };
        const combatPhase = () => st().match.public.phase === 'COMBAT';
        // 一轮 45 真实秒可能在中途结束（SETTLE→PREP→自动开战）：等下一轮战斗继续（干员部署跨回合保留）
        const waitCombat = async () => { for (let i = 0; i < 900 && !combatPhase(); i++) await sleepL(100); };
        // 场上没有敌人就砸罐（最多 4 个：每个等 8s 看是否出敌人）
        for (let i = 0; i < 4 && foes() === 0; i++) {
          if (!combatPhase()) await waitCombat();
          const js = jars();
          if (!js.length) break;
          try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ }
          for (let k = 0; k < 16 && foes() === 0; k++) await sleepL(500);
        }
        // 轮询等一次普攻；中途敌人死光/漏光就再砸一个保持压力
        let last = null;
        for (let i = 0; i < 30; i++) {
          if (!combatPhase()) { await waitCombat(); continue; }
          last = probe();
          if (last && last.attacked > 0) break;
          if (i % 5 === 4 && foes() === 0) {
            const js = jars();
            if (js.length) { try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ } }
          }
          await sleepL(2000);
        }
        return last || probe();
      });
      log('ATTACK ANIM PROBE:', JSON.stringify(atk));
      if (atk.allies && atk.allies.length) {
        if (atk.attacked === 0) FAIL.push('轮询期间没有任何干员触发攻击（lastAtk 全为空）');
        if (atk.noActor.length) FAIL.push(`干员 spine actor 未加载（钻石/无动画）: ${atk.noActor.join(', ')}`);
        if (atk.clipMissing.length) FAIL.push(`攻击剪辑缺失（模型在但不播动画）: ${atk.clipMissing.join(', ')}`);
      }
      const diag = await c.page.evaluate(() => {
        const r = globalThis.__SP_RUNNER__;
        const v = globalThis.__SP_VIEW__;
        const bid = (globalThis.__SP__.store.get().match.battle || {}).battleId;
        const e = bid && r && r._entries ? r._entries.get(bid) : null;
        let simUnits = [];
        try { simUnits = (e && e.battle ? e.battle.fieldMeta().units : []).map((u) => ({ id: u.id, side: u.side, spine: u.spine ?? null })); } catch { /* ignore */ }
        const vmeta = { has: !!v, kind: v ? (v.kind ?? 'engine?') : null, hasDebug: !!(v && v.raw && typeof v.raw.debugUnits === 'function') };
        const d = v && v.raw && typeof v.raw.debugUnits === 'function' ? v.raw.debugUnits() : null;
        const unknownViews = d ? d.views.filter((x) => x.unknown) : [];
        const missing = simUnits.filter((s) => !d || !d.infos.some((i) => i.id === s.id));
        return {
          bid, simCount: simUnits.length, simUnits, view: vmeta,
          viewFieldId: d ? d.fieldId : null, viewMode: d ? d.mode : null,
          infoCount: d ? d.infos.length : -1,
          infosNoSpine: d ? d.infos.filter((i) => i.side === 'enemy' && !i.spine) : [],
          unknownViews, missingInfos: missing,
          spawnLog: (r && r.__spawnLog) || [],
          storeField: (() => { const f = globalThis.__SP__.store.get().match.field; return f ? { fieldId: f.fieldId, units: Array.isArray(f.units) ? f.units.length : null, battleId: f.battleId ?? null } : null; })(),
        };
      });
      log('DIAMOND DIAG:', JSON.stringify(diag, null, 1));

      // ③c 战斗中刷新页面（对齐用户实测：server.log 里有 server takeover (left)）→ 重连回归后渲染是否完好
      if (process.env.BB_RELOAD) {
        const phaseNow = await c.page.evaluate(() => globalThis.__SP__.store.get().match.public.phase);
        log('RELOADING mid-combat, phase =', phaseNow);
        await c.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(6000); // 恢复会话 + 重新进场（server takeover → 服务端代跑 → 客户端 replica）
        const diag2 = await c.page.evaluate(() => {
          const r = globalThis.__SP_RUNNER__;
          const v = globalThis.__SP_VIEW__;
          const bid = (globalThis.__SP__.store.get().match.battle || {}).battleId;
          const e = bid && r && r._entries ? r._entries.get(bid) : null;
          let simUnits = [];
          try { simUnits = (e && e.battle ? e.battle.fieldMeta().units : []).map((u) => ({ id: u.id, side: u.side, spine: u.spine ?? null })); } catch { /* ignore */ }
          const d = v && v.raw && typeof v.raw.debugUnits === 'function' ? v.raw.debugUnits() : null;
          const mode = d ? d.mode : null;
          const unknownViews = d ? d.views.filter((x) => x.unknown) : [];
          const missing = simUnits.filter((s) => !d || !d.infos.some((i) => i.id === s.id));
          return {
            phase: globalThis.__SP__.store.get().match.public.phase,
            bid, simCount: simUnits.length,
            hasView: !!v, viewKind: v ? v.kind : null, viewMode: mode, viewFieldId: d ? d.fieldId : null,
            infoCount: d ? d.infos.length : -1,
            infosNoSpine: d ? d.infos.filter((i) => i.side === 'enemy' && !i.spine) : [],
            unknownViews, missingInfos: missing,
            entries: r && r._entries ? [...r._entries.keys()] : [],
          };
        });
        log('DIAMOND DIAG AFTER RELOAD:', JSON.stringify(diag2, null, 1));
        await c.shot('repro-jar-after-reload');
        if (!diag2.viewMode || diag2.viewMode !== 'battle') FAIL.push(`刷新重连后视图未回到战斗（mode=${diag2.viewMode}）`);
        if (diag2.missingInfos.length) FAIL.push(`刷新重连后 ${diag2.missingInfos.length} 个单位没有 info（钻石占位）`);
        if (diag2.unknownViews.length) FAIL.push(`刷新重连后 ${diag2.unknownViews.length} 个 _unknown 占位视图`);
      }
      // ④ 战斗中罐子阵常驻（边防守边砸的载体）——一轮可能已结束，先等下一轮战斗
      const mid = await c.page.evaluate(async () => {
        const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 900 && globalThis.__SP__.store.get().match.public.phase !== 'COMBAT'; i++) await sleepL(100);
        const jars = globalThis.__SP__.store.get().match.private?.jars || [];
        return { smashed: jars.filter((j) => j.smashed).length, phase: globalThis.__SP__.store.get().match.public.phase, field: !!document.querySelector('.jarfield') };
      });
      log('JARFIELD LATE-COMBAT:', JSON.stringify(mid));
      if (!mid.field) FAIL.push('战斗后段罐子阵消失了（应常驻）');
      if (mid.phase !== 'COMBAT') FAIL.push(`战斗后段 phase=${mid.phase}（应仍是 COMBAT）`);
  }
  // 手动再发一次 g.blindBoxSet：区分「客户端没自动应用」还是「应用了但渲染链没接管」
  const manual = await c.page.evaluate(async (m) => {
    try { await globalThis.__SP__.net.request('g.blindBoxSet', { mode: m }); } catch (e) { return 'request failed: ' + e.message; }
    await new Promise((r) => setTimeout(r, 1500));
    const st = globalThis.__SP__.store.get();
    const priv = st.match.private || {};
    return {
      level: priv.shop?.level ?? null,
      slotPrices: (priv.shop?.slots || []).map((s) => (s && s.price != null ? s.price : null)),
      blindCards: document.querySelectorAll('.scard--blind').length,
      shopText: (document.querySelector('.shopbar')?.textContent || '').slice(0, 200),
    };
  }, MODE);
  log('AFTER MANUAL g.blindBoxSet:', JSON.stringify(manual, null, 2));
  log('PROBLEMS:', JSON.stringify(c.problems.slice(0, 12), null, 1));
  log('SERVER LOGS (tail):', JSON.stringify(srv.logs.filter((l) => /mods|blind|error/i.test(l)).slice(-12), null, 1));
} catch (e) {
  log('ERROR:', e?.message || e);
  try { await c.shot('repro-fail'); } catch {}
  log('PROBLEMS:', JSON.stringify(c.problems.slice(0, 12)));
} finally {
  if (FAIL.length) {
    log('FAILED EXPECTATIONS:', JSON.stringify(FAIL, null, 1));
    process.exitCode = 1;
  } else {
    log('ALL EXPECTATIONS MET');
  }
  await c.close();
  await srv.stop();
}
