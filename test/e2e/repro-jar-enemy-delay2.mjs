import { startRealServer, Client } from './client.mjs';
import { existsSync } from 'node:fs';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome'); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'repro', { prefix: 'repro' });
const log = (...a) => console.log('[repro]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await c.open();
  await c.page.evaluate(() => {
    localStorage.setItem('sp.blindbox.pref', JSON.stringify({ mode: 'jar' }));
    localStorage.setItem('sp.mods.off', JSON.stringify({ creativemode: true }));
  });
  await c.page.keyboard.press('Escape').catch(() => {});
  await c.enter('杜宾');
  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', '绝境模拟');
  await c.click('.create-box button', '开始独立模拟');
  if (await c.click('.jar-sv-modal button', '新开一局', { optional: true, timeout: 8000 })) log('dismissed jar start-save dialog');
  await c.waitFor((s) => !!s.room, 'solo room', 30000);
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  const s0 = await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 1) || (s.phase === 'SP_DRAFT' && s.round >= 1), 'prep', 90000);
  log(`reached ${s0.phase} solo, round`, s0.round);
  await sleep(1500);
  const info = await c.page.evaluate(() => {
    const st = globalThis.__SP__.store.get();
    return {
      phase: st.match.public.phase,
      jars: ((st.match.private || {}).jars || []).length,
      mode: (globalThis.__SP__.mods || []).find(m => m.id === 'blindbox')?.off ? 'off' : 'on',
    };
  });
  log('info:', JSON.stringify(info));
  // try smash one jar
  const smashRes = await c.page.evaluate(async () => {
    const st = () => globalThis.__SP__.store.get();
    const jars = () => ((st().match.private || {}).jars || []).filter(j => j && !j.smashed);
    const j = jars()[0];
    if (!j) return { err: 'no jars' };
    try {
      const r = await globalThis.__SP__.net.request('g.smashJar', { jarId: j.id });
      for (let k = 0; k < 30 && !jars().find(x => x.id === j.id)?.smashed; k++) await new Promise(r => setTimeout(r, 100));
      return { id: j.id, res: r, smashedAfter: jars().find(x => x.id === j.id)?.smashed, kind: jars().find(x => x.id === j.id)?.kind };
    } catch (e) { return { id: j.id, err: String(e) }; }
  });
  log('smash:', JSON.stringify(smashRes));
  await c.shot('jar-smash-test');
} catch (e) { log('ERROR:', e?.message || e); }
finally { await c.close(); await srv.stop(); }
