// 探针：jar 模式下检查整备区/罐子的道具图标是否解析成功（真实浏览器）。
import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at', CHROME); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }

const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'ji', { prefix: 'ji' });
const log = (...a) => console.log('[ji]', ...a);
const FAIL = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await c.open();
  await c.page.evaluate(() => {
    try {
      localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: 'jar' }));
      const off = { creativemode: true }; // 确保盲盒可用：创造模式互斥会卸掉盲盒
      localStorage.setItem('sp.mods.off', JSON.stringify(off));
    } catch { /* ignore */ }
  });
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('ProbeJI');

  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', '标准模拟');
  await c.click('.create-box button', '开始独立模拟');
  if (await c.click('.jar-sv-modal button', '新开一局', { optional: true, timeout: 8000 })) log('dismissed jar start-save dialog');
  await c.waitFor((s) => !!s.room, 'solo room', 30000);
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  await sleep(800);
  // jar 模式会自动开战；砸几个罐子让 item/operator 进整备区，再读图标
  const smashed = await c.page.evaluate(async () => {
    const net = globalThis.__SP__.net;
    const st = () => globalThis.__SP__.store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter(j => j && !j.smashed);
    const out = [];
    for (let i = 0; i < 10 && jars().length; i++) {
      const j = jars()[0];
      let reqRes = null, reqErr = null;
      try { reqRes = await net.request('g.smashJar', { jarId: j.id }); } catch (e) { reqErr = String(e && e.message || e); }
      // 等服务端回执：jars 列表更新（ smashed 变 true）最多 2 秒
      for (let k = 0; k < 40 && !jars().find(x => x.id === j.id)?.smashed; k++) await new Promise(r => setTimeout(r, 50));
      const now = jars().find(x => x.id === j.id) || j;
      out.push({ id: j.id, smashed: !!now.smashed, kind: now.kind, itemId: now.itemId, enemyKey: now.enemyKey, reqRes, reqErr });
      if (now.kind === 'item' || now.kind === 'operator') break; // 开出内容就停，减少战斗时间压力
    }
    return out;
  });
  log('smashed:', JSON.stringify(smashed, null, 2));
  // 等整备区刷新
  await c.page.waitForFunction(() => {
    const priv = globalThis.__SP__.store.get().match.private;
    const count = (priv?.hand || []).filter(Boolean).length + (priv?.temp || []).filter(Boolean).length + (priv?.board || []).length;
    return count > 0;
  }, { timeout: 5000 }).catch(() => null);
  await sleep(400);
  await c.shot('jar-prep-icons');
  log('screenshot saved');

  // 收集整备区 pieces 和 icon 解析
  const report = await c.page.evaluate(() => {
    const s = globalThis.__SP__.store.get();
    const pub = s.match.public;
    const priv = s.match.private;
    const assets = globalThis.__SP__.assets;
    const data = globalThis.__SP__.data;
    const out = [];
    const rawHand = JSON.parse(JSON.stringify(priv?.hand || []));
    const rawTemp = JSON.parse(JSON.stringify(priv?.temp || []));
    for (const area of ['hand', 'temp', 'board']) {
      const list = priv?.[area] || [];
      for (const e of list) {
        if (!e) continue;
        const p = e.piece || e; // board/hand/temp 的存储格式可能是直接 piece
        if (!p || p.kind !== 'item') continue;
        const rec = data.item(p.id);
        const icon = rec && assets.itemIcon
          ? assets.itemIcon({ trapId: rec.trapId, iconId: rec.iconId })
          : null;
        out.push({ area, uid: e.uid ?? p.uid, id: p.id, kind: p.kind, tier: p.tier, golden: p.golden, iconUrl: icon });
      }
    }
    const jars = priv?.jars || [];
    return {
      mode: pub?.modeId || null, phase: pub?.phase, round: pub?.round,
      privateKeys: Object.keys(priv || {}),
      jarsCount: jars.length,
      jarsFirst10: jars.slice(0, 10).map(j => ({ id: j.id, kind: j.kind, enemyKey: j.enemyKey, itemId: j.itemId, smashed: j.smashed })),
      rawHand: rawHand.slice(0, 6), rawTemp: rawTemp.slice(0, 6),
      pieces: out,
    };
  });
  log('state:', JSON.stringify({ mode: report.mode, phase: report.phase, round: report.round, privateKeys: report.privateKeys }, null, 2));
  log('pieces:', JSON.stringify(report.pieces, null, 2));
  log('jars:', JSON.stringify(report.jarsFirst10, null, 2));

  // 直接检查已砸出的 item 罐的图标解析
  const direct = await c.page.evaluate(() => {
    const s = globalThis.__SP__.store.get();
    const assets = globalThis.__SP__.assets;
    const data = globalThis.__SP__.data;
    const jars = (s.match.private?.jars || []).filter(j => j && j.smashed && j.kind === 'item');
    return jars.slice(0, 10).map(j => {
      const rec = data.item(j.itemId);
      const url = rec && assets.itemIcon ? assets.itemIcon({ trapId: rec.trapId, iconId: rec.iconId }) : null;
      return { itemId: j.itemId, iconId: rec?.iconId, trapId: rec?.trapId, url };
    });
  });
  log('direct item icons:', JSON.stringify(direct, null, 2));
  const missingDirect = direct.filter(d => !d.url);
  if (missingDirect.length) FAIL.push(`罐子 item 图标解析失败：${missingDirect.map(d => d.itemId).join(', ')}`);

  // 检查是否有 item 但 iconUrl 为 null
  const missingIcons = report.pieces.filter(p => p.kind === 'item' && !p.iconUrl);
  if (missingIcons.length) {
    FAIL.push(`以下 item 未解析出图标：${missingIcons.map(p => `${p.area}:${p.id}`).join(', ')}`);
  }

  if (c.problems.length) log('problems:', c.problems.join('\n'));
} catch (e) {
  FAIL.push(String(e?.stack || e));
} finally {
  await c.close?.().catch?.(() => {});
  await srv.stop?.({ hard: true });
}
if (FAIL.length) { console.error(FAIL.join('\n')); process.exit(1); }
log('ALL OK');
