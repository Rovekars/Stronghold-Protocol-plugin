// 定向验证：用户要求 ①b —— jar 模式下敌人只能来自罐子，且「砸完那个罐子后等待五秒才出」。
// 与 repro-blindbox-shop.mjs 的概率式探测不同：这里监听 m.jarSmashed 拿到每个罐子的真实种类，
// 只在砸中 enemy 罐时测量「砸开 → 敌人真的出现在场上」的真实延迟（战斗 2 倍速：10 战斗秒 = 5 真实秒）。
// 同时记录 b.jarSpawn 载荷（spawns[0].time 应为 10）与两个独立的敌人数来源，用来排查 coop 下
// fieldUnits(fid) 是否假阴性（solo 已验证可用，coop 连轮探测不到敌人罐需排除探针本身失灵）。
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const ROOM = process.env.BB_ROOM || 'solo'; // solo = 独立模拟；coop = 同盟模拟
const FAIL = [];
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'repro', { prefix: 'repro' });
const log = (...a) => console.log('[repro]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await c.open();
  await c.page.evaluate(() => localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: 'jar' })));
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('杜宾');
  if (ROOM === 'coop') {
    await c.click('.mode-card', '同盟模拟');
    await c.click('.diff-card', process.env.BB_DIFF || '绝境模拟');
    await c.click('.create-box button', '创建同盟');
    if (await c.click('.jar-sv-modal button', '新开一局', { optional: true, timeout: 8000 })) log('dismissed jar start-save dialog');
    await c.waitFor((s) => !!s.room?.code, 'coop room', 30000);
  } else {
    await c.click('.mode-card', '独立模拟');
    await c.click('.diff-card', process.env.BB_DIFF || '绝境模拟');
    await c.click('.create-box button', '开始独立模拟');
    // jar 模式在大厅建房前会先弹「选择存档」页（lobby.js 10-15 起），必须选「新开一局」才会真正建房。
    // 该弹窗 closeOnBackdrop=false，不点掉就会一直停在 LOBBY → waitFor(room) 必超时。
    if (await c.click('.jar-sv-modal button', '新开一局', { optional: true, timeout: 8000 })) log('dismissed jar start-save dialog');
    await c.waitFor((s) => !!s.room, 'solo room', 30000);
  }
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  const s0 = await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  log(`reached ${s0.phase} (${ROOM}), round`, s0.round);

  // 等自动开战 + 装监听器（m.jarSmashed 拿罐子种类、b.jarSpawn 拿注入载荷）
  const auto = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = () => globalThis.__SP__.store.get();
    for (let i = 0; i < 80 && st().match.public.phase !== 'COMBAT'; i++) await sleepL(100);
    globalThis.__JARLOG__ = { smashed: [], spawns: [] };
    const net = globalThis.__SP__.net;
    if (net && typeof net.on === 'function') {
      net.on('m.jarSmashed', (m) => {
        const L = globalThis.__JARLOG__;
        L.smashed.push({ id: m && m.id, kind: m && m.kind, enemyKey: m && m.enemyKey, count: m && m.count, t: Date.now() });
      });
      net.on('b.jarSpawn', (m) => {
        const L = globalThis.__JARLOG__;
        L.spawns.push({ t: Date.now(), list: (m && m.spawns) ? m.spawns.map((s) => ({ enemyKey: s.enemyKey, count: s.count, time: s.time, tag: s.tag })) : null });
      });
    }
    return { phase: st().match.public.phase, jars: ((st().match.private || {}).jars || []).length };
  });
  log('AUTO COMBAT:', JSON.stringify(auto));
  if (auto.phase !== 'COMBAT') { FAIL.push('没有自动开战'); throw new Error('no combat'); }

  // 逐个砸罐：砸中 enemy 罐 → 测量「砸开 → 敌人出现在场上」的真实延迟
  const probe = await c.page.evaluate(async () => {
    const sleepL = (ms) => new Promise((r) => setTimeout(r, ms));
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const L = () => globalThis.__JARLOG__;
    const jars = () => ((st().match.private || {}).jars || []).filter((j) => j && !j.smashed);
    const fid = (st().match.field || {}).fieldId || (st().match.battle || {}).fieldId || null;
    const r = globalThis.__SP_RUNNER__;
    // 两个独立的敌人数来源：① runner.fieldUnits(fid)（MOD 视角）② 本地 Battle.enemies（模拟内核视角）
    const foesA = () => {
      const list = r && typeof r.fieldUnits === 'function' && fid ? (r.fieldUnits(fid) || []) : [];
      return list.filter((u) => u && u.side === 'enemy').length;
    };
    const foesB = () => {
      const bid = (st().match.battle || {}).battleId || null;
      const e = bid && r && r._entries ? r._entries.get(bid) : null;
      return e && e.battle && Array.isArray(e.battle.enemies) ? e.battle.enemies.filter((x) => x && x.alive).length : null;
    };
    const kinds = [];
    let hit = null;
    for (let i = 0; i < 30 && !hit; i++) {
      const js = jars();
      if (!js.length) break;
      const before = L().smashed.length;
      try { await net.request('g.smashJar', { jarId: js[0].id }); } catch { /* ignore */ }
      for (let k = 0; k < 20 && L().smashed.length === before; k++) await sleepL(60); // 等 m.jarSmashed 回执
      const rec = L().smashed[L().smashed.length - 1];
      if (!rec || rec.id !== js[0].id) { await sleepL(200); continue; }
      kinds.push(rec.kind);
      if (rec.kind !== 'enemy') { await sleepL(250); continue; }
      // 砸中敌人罐：轮询敌人出现（最多 20 秒，覆盖 5 秒缓冲 + 余量）
      const tSmash = rec.t;
      let tA = null;
      let tB = null;
      for (let k = 0; k < 200; k++) {
        if (tA === null && foesA() > 0) tA = Date.now();
        if (tB === null && (foesB() || 0) > 0) tB = Date.now();
        if (tA !== null && tB !== null) break;
        await sleepL(100);
      }
      hit = { jarId: rec.id, enemyKey: rec.enemyKey, count: rec.count, delayA: tA ? tA - tSmash : null, delayB: tB ? tB - tSmash : null, tSmash };
    }
    const spawnList = L().spawns.map((s) => s.list);
    return {
      smashed: L().smashed.length, kinds, hit,
      jarSpawnTimes: spawnList.map((l) => (l && l[0] ? l[0].time : null)),
      jarSpawnKeys: spawnList.map((l) => (l && l[0] ? l[0].enemyKey : null)),
      jarsLeft: jars().length,
      foesNowA: foesA(), foesNowB: foesB(), fid,
      phase: st().match.public.phase,
    };
  });
  log('ENEMY DELAY PROBE:', JSON.stringify(probe, null, 1));
  await c.shot(`repro-jar-enemy-delay-${ROOM}`);

  if (probe.phase !== 'COMBAT') FAIL.push(`砸罐过程中 phase 变成 ${probe.phase}（应全程战斗）`);
  if (!probe.kinds.length) FAIL.push('一个罐子都没砸开（g.smashJar 无回执）');
  if (!probe.hit) {
    FAIL.push(`砸了 ${probe.smashed} 罐（种类：${probe.kinds.join(',') || '无'}）没砸到敌人罐——无法验证出场延迟`);
  } else {
    // 战斗恒 2 倍速：10 战斗秒 = 5 真实秒。允许 4~13 秒（内核步进 / 消息往返 / 出生点走出耗时）
    const dA = probe.hit.delayA;
    const dB = probe.hit.delayB;
    log(`DELAY: fieldUnits=${dA}ms  battle.enemies=${dB}ms`);
    if (dA === null && dB === null) FAIL.push(`敌人罐（${probe.hit.enemyKey}）砸开后 20 秒内敌人都没出现——注入失效`);
    else if (dA !== null && (dA < 4000 || dA > 13000)) FAIL.push(`敌人出场太快/太慢（fieldUnits ${dA}ms）——5 秒缓冲失效`);
    else if (dA === null && dB !== null && (dB < 4000 || dB > 13000)) FAIL.push(`敌人出场太快/太慢（battle ${dB}ms）——5 秒缓冲失效`);
    if (dA === null && dB !== null) log('NOTE: fieldUnits(fid) 没看到敌人，battle.enemies 看到了——MOD 视角探针在', ROOM, '下失灵（仅提示）');
    const t10 = probe.jarSpawnTimes.filter((t) => t === 10).length;
    if (!probe.jarSpawnTimes.length) FAIL.push('没收到 b.jarSpawn（客户端模拟下应下发注入消息）');
    else if (!t10) FAIL.push(`b.jarSpawn 的 spawns[0].time 应为 10（5 真实秒），实际：${JSON.stringify(probe.jarSpawnTimes)}`);
  }
} catch (e) {
  log('ERROR:', e?.message || e);
  try { await c.shot('repro-jar-enemy-delay-fail'); } catch {}
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
