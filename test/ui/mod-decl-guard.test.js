// 插件「加载即崩」防回归：顶层 await import 的解构符号必须有对应的 let/const/var 声明。
//
// 历史事故（同一类坑已经踩了三次）：
//   ESM 是严格模式，给未声明的变量赋值直接抛 ReferenceError —— 而 MOD 是在 window 守卫里
//   `({ X } = await import('/js/ui/xxx.js'))` 这样懒加载的。只要加 import 时忘了在声明行
//   补上 X，插件一被扫描加载就整份崩掉（表现为「插件无法正常加载 / 加插件丢 UI」），
//   而且 `node --check` 语法检查完全发现不了（语法是合法的，是运行时才炸）。
//   先后中招：Modal → Button → RewardOverlay。
//
// 本测试用静态扫描把这一类问题永久拦在 CI 里：任何 `({...} = await import('...'))` 里
// 出现的符号，都必须能在同文件的模块作用域声明里找到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD_DIR = join(ROOT, 'public', 'mod');

// 模块作用域的声明：行首缩进 < 2 空格的 let/const/var（顶层），支持逗号分隔与 a = 1 初值
function declaredNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/^([ \t]{0,1})(?:let|const|var)\s+([^=;\n{]+)/gm)) {
    for (const raw of m[2].split(',')) {
      const name = raw.trim().replace(/\s*=[\s\S]*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

// 所有 `({ a, b: c } = await import('...'))` 形式的懒加载解构
const IMPORT_DESTRUCT = /\(\s*\{([^}]*)\}\s*=\s*await import\(\s*['"]([^'"]+)['"]\s*\)/g;

function undeclaredImports(src) {
  const declared = declaredNames(src);
  const bad = [];
  for (const m of src.matchAll(IMPORT_DESTRUCT)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || part.startsWith('...')) continue;
      // `a: b` / `a: { b }` 取被赋值的目标名；`a = 1` 取 a
      const afterColon = part.includes(':') ? part.slice(part.lastIndexOf(':') + 1) : part;
      const name = afterColon.trim().replace(/\s*=\s*[\s\S]*$/, '').replace(/[{}[\]]/g, '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!declared.has(name)) bad.push({ sym: name, from: m[2] });
    }
  }
  return bad;
}

const mods = readdirSync(MOD_DIR).filter((f) => f.endsWith('.js') && f !== 'README.md');

test('插件：顶层 import 解构的每个符号都有声明（ESM 严格模式漏声明会整份崩）', () => {
  assert.ok(mods.length >= 5, `should scan the whole MOD folder, got ${mods.length}`);
  const problems = [];
  for (const f of mods) {
    const bad = undeclaredImports(readFileSync(join(MOD_DIR, f), 'utf8'));
    for (const b of bad) problems.push(`${f}: ${b.sym} (from ${b.from})`);
  }
  assert.deepEqual(problems, [],
    '这些符号出现在 `({ ... } = await import(...))` 里却没有 let 声明 —— 严格模式会在加载时抛 ReferenceError：\n' +
    problems.join('\n'));
});

test('盲盒：rewardOverlay / shopBar 的复用符号都在声明行里', () => {
  // 三个历史事故点的直接钉死：Modal、Button、RewardOverlay
  const src = readFileSync(join(MOD_DIR, '盲盒模式.js'), 'utf8');
  const declared = declaredNames(src);
  for (const sym of ['Modal', 'Button', 'RewardOverlay', 'RewardCards', 'useTwoTap', 'armKey',
    'ShopBar', 'SoldCard', 'useMemo', 'useState', 'useEffect', 'useRef',
    'TierChip', 'HexBadge', 'Icon', 'Img', 'chessPortraitUrl', 'itemIconUrl', 'enemyIconUrl']) {
    assert.ok(declared.has(sym), `盲盒模式.js must declare ${sym}`);
  }
});

test('插件：懒加载都在 window 守卫里（Node 侧静态导入不会炸）', () => {
  for (const f of mods) {
    const src = readFileSync(join(MOD_DIR, f), 'utf8');
    const guarded = /typeof window\s*!==\s*['"]undefined['"]/.test(src);
    const hasTopImport = IMPORT_DESTRUCT.test(src);
    if (hasTopImport) {
      assert.ok(guarded, `${f} lazy-imports browser modules but has no window guard`);
    }
    IMPORT_DESTRUCT.lastIndex = 0; // 正则带 g，重置避免跨文件状态污染
  }
});
