// 插件加载器重复激活清理（main.js activatePlugin）的文件级防回退测试：
// 历史 bug —— unregisterShopOverrides 被导入却从未调用、overlays 从不按 modId 清理；
// 一旦触发重复激活（loadPlugins 再次运行 / 未来的重载入口），商店覆盖与全局浮层会堆叠
// （ShopOverrideHost 取 list[0]，陈旧覆盖会永久压住新覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(ROOT, 'public/js/main.js'), 'utf8');

test('加载器：activatePlugin 在 setup 前按 modId 清理全部注册点', () => {
  // 每个注册点都必须在 activatePlugin 里被 unregister（防重复激活堆叠）
  for (const fn of ['unregisterSettingsEntries', 'unregisterCustomEmotes', 'unregisterLoadoutActions',
    'unregisterDetailActions', 'unregisterLobbyEntries', 'unregisterOverlays', 'unregisterShopOverrides']) {
    assert.ok(src.includes(`${fn}(meta.id)`), `activatePlugin must call ${fn}(meta.id)`);
  }
});

test('加载器：unregisterShopOverrides 不得只是被导入而从未调用', () => {
  // import 语句不带括号，`unregisterShopOverrides(meta.id)` 的调用在 activatePlugin 里（test 1 已断言）
  const calls = src.match(/unregisterShopOverrides\s*\(/g) || [];
  assert.ok(calls.length >= 1, `expected at least one call, got ${calls.length}`);
  assert.match(src, /unregisterShopOverrides\(meta\.id\)/);
});

test('加载器：unregisterOverlays 必须按 { id, C } 的 id 匹配并通知重渲染', () => {
  assert.match(src, /function unregisterOverlays\(modId\)/);
  assert.match(src, /pluginOverlays\[i\]\.id === modId/);
  assert.match(src, /if \(removed\) notifyOverlays\(\)/);
  // overlays 以 { id, C } 入队（裸 push 会让 off[o.id] 与清理都失效）
  assert.match(src, /pluginOverlays\.push\(\{ id: meta\.id, C: Component \}\)/);
});
