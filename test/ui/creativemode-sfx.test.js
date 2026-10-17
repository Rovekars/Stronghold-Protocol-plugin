// 创造模式 插件音效接线（用户反馈 2026-10-10：商店按钮点击要有音效，用本体音效）：
//   * 商店大按钮 onClick 先 audio.sfx('click', { volume: 0.4 })（与本体按钮同一套，../js/audio.js 导出）再开面板；
//   * 绝对路径导入（MOD 可能以 Blob URL 加载，本体模块一律 '/js/…'）；
//   * 其余交互不被回退：面板开关 setOpen(true)、版本号 ≥ 1.3.1。
// 创造模式插件带 '/js/…' 绝对路径导入，无法在 node 里直接 import —— 断言走文件内容（operatorskin 测试同款）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(path.join(ROOT, 'public/mod/创造模式.js'), 'utf8');

test('创造模式：商店按钮点击播本体 click 音效（audio.sfx）再开面板', () => {
  assert.match(src, /import \{ audio \} from '\.\.\/js\/audio\.js';/, 'the mod imports the original audio module (relative, like the other mod imports)');
  assert.match(src, /class="brackets" onClick=\$\{\(\) => \{ audio\.sfx\('click', \{ volume: 0\.4 \}\); setOpen\(true\); \}/,
    'the SHOP button plays the click sfx, then opens the catalog');
});

test('创造模式：商店面板关闭按钮保持完整 button 标签（防回退：h.push is not a function）', () => {
  // 关闭按钮必须保留 <button type="button" 开始标签，不能只替换 onClick 而吞掉标签名。
  assert.match(src, /<button type="button"[^>]*\s+onClick=\$\{\(\) => \{ audio\.sfx\('back', \{ volume: 0\.5 \}\); onClose\(\); \}\}/,
    'CatalogPanel header close button keeps its <button type="button" opening tag and plays back sfx');
});

test('创造模式：版本 ≥ 1.3.2（无限资金开关）', () => {
  const v = src.match(/version: '(\d+)\.(\d+)\.(\d+)'/);
  assert.ok(v, 'a semver version exists');
  const [a, b, c] = v.slice(1).map(Number);
  assert.ok(a === 1 && (b > 3 || (b === 3 && c >= 2)), `version ${v[0]} is at least 1.3.2`);
});

test('创造模式：大厅卡片含独立「无限资金」开关', () => {
  assert.match(src, /无限资金/, 'the lobby card renders the 无限资金 toggle label');
  // 该开关与「创造模式」相互独立：pref 同时持久化 on / cap / infiniteFunds
  assert.match(src, /infiniteFunds:\s*!!\(v && v\.infiniteFunds\)/, 'loadPref restores infiniteFunds from localStorage');
});

test('创造模式：进入模拟把 infiniteFunds 一并上报 g.creativeSet', () => {
  assert.match(src, /g\.creativeSet',\s*\{\s*[^}]*infiniteFunds:\s*pref\.infiniteFunds/, 'match-start apply sends infiniteFunds to the server');
});

test('创造模式：m.creativeState 携带 infiniteFunds 并写入共享状态', () => {
  assert.match(src, /setCreative\(\{[^}]*infiniteFunds:\s*!!m\.infiniteFunds/, 'the m.creativeState handler reads infiniteFunds into the shared state');
});

test('创造模式：目录面板接收 infiniteFunds 并展示 ∞ 资金徽标', () => {
  assert.match(src, /infiniteFunds=\$\{\s*cr\.infiniteFunds\s*\}/, 'CatalogPanel receives the infiniteFunds prop from the shop override');
  assert.match(src, /∞ 资金/, 'the ∞ 资金 badge is rendered when infinite funds is on');
});
