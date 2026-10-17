import { startRealServer, Client, sleep } from './client.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome'); process.exit(2); }
async function pptr() { return (await import('puppeteer-core')).default; }
const srv = await startRealServer();
const c = new Client(await pptr(), srv.base, 'db', { prefix: 'db' });
try {
  await c.open('?autostart=1');
  await sleep(2000);
  await c.page.screenshot({ path: path.resolve('test/e2e/out/jar-dbg1.png') });
  const info = await c.page.evaluate(() => ({
    bodyText: document.body.innerText.slice(0, 400),
    buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 20),
    inputs: [...document.querySelectorAll('input')].map(i => ({ placeholder: i.placeholder, name: i.name, value: i.value })),
  }));
  console.log(JSON.stringify(info, null, 2));
} finally { await c.close?.().catch?.(() => {}); await srv.stop({ hard: true }); }
