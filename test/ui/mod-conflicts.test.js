// MOD 互斥（创造模式 ↔ 盲盒模式）的契约测试：
//   * 声明侧：两个插件各自用 `conflicts: [...]` 声明对手（本体在插件加载后统一登记）；
//   * 机制侧（真跑 ui/mods.js）：启用一个会自动卸下冲突的另一个，且双向对称；
//     卸下操作不牵连别人；无关的插件不受影响；返回值即被自动卸下的 id（供界面 toast）；
//   * 接线侧：main.js 把插件声明登记进 ui/mods.js 并在启动时纠正历史「两个都开着」的存档；
//     标题页的两处开关走同一个 toggleMod（自动卸下后给出提示）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const crvSrc = read('public/mod/创造模式.js');
const bbSrc = read('public/mod/盲盒模式.js');
const modsSrc = read('public/js/ui/mods.js');
const mainSrc = read('public/js/main.js');
const titleSrc = read('public/js/screens/title.js');

test('两个插件互相声明冲突（id 与本体登记的一致）', () => {
  assert.match(crvSrc, /export const id = 'creativemode'/, '创造模式的稳定 id');
  assert.match(bbSrc, /export const id = 'blindbox'/, '盲盒模式的稳定 id');
  assert.match(crvSrc, /conflicts: \['blindbox'\]/, '创造模式声明与盲盒互斥');
  assert.match(bbSrc, /conflicts: \['creativemode'\]/, '盲盒声明与创造模式互斥');
});

test('启用一个自动卸下冲突的另一个（双向对称，且返回被卸下的 id）', async () => {
  // ui/mods.js 只依赖 localStorage / window：给最小浏览器替身就能在 Node 里真跑
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const events = [];
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: (e) => events.push(e) };
  const mods = await import(new URL('../../public/js/ui/mods.js', import.meta.url).href);

  mods.setModConflicts({ creativemode: ['blindbox'] }); // 只由一侧声明
  assert.deepEqual(mods.modConflicts('creativemode'), ['blindbox'], '声明方可查到对手');
  assert.deepEqual(mods.modConflicts('blindbox'), ['creativemode'], '关系对称：对手侧同样生效');
  assert.deepEqual(mods.modConflicts('musicbox'), [], '无关插件没有冲突');

  // 当前：盲盒启用、创造模式卸下 → 启用创造模式应自动卸下盲盒
  mods.setModOff('blindbox', false);
  assert.equal(mods.isModOff('creativemode'), true, '初始：创造模式已卸下');
  const victims = mods.setModOff('creativemode', false);
  assert.deepEqual(victims, ['blindbox'], '返回值 = 被自动卸下的 id（界面据此提示）');
  assert.equal(mods.isModOff('blindbox'), true, '盲盒被自动卸下');
  assert.equal(mods.isModOff('creativemode'), false, '创造模式已启用');
  assert.equal(mods.isModOff('musicbox'), false, '无关插件不受牵连');

  // 反向：启用盲盒会自动卸下创造模式
  const back = mods.setModOff('blindbox', false);
  assert.deepEqual(back, ['creativemode']);
  assert.equal(mods.isModOff('creativemode'), true, '创造模式被自动卸下');

  // 卸下操作（off=true）不牵连任何别人
  mods.setModOff('creativemode', false);
  const none = mods.setModOff('musicbox', true);
  assert.deepEqual(none, [], '卸下不返回自动卸下列表');
  assert.equal(mods.isModOff('creativemode'), false, '卸下 musicbox 不影响创造模式');
  assert.ok(events.length >= 4, `每次开关都广播变更事件（${events.length}）`);
});

test('本体接线：加载后登记冲突表，并纠正历史存档里两个都开着的情况', () => {
  assert.match(mainSrc, /const conflicts = \{\}/, '先收集每个插件的 meta.conflicts');
  assert.match(mainSrc, /conflicts\[m\.id\] = m\.conflicts/, '从每个插件的 meta.conflicts 收集');
  assert.match(mainSrc, /registerPacks\(packList, conflicts\)/, 'MOD 级 conflicts 随整合包一起登记给 ui/mods.js（registerPacks 内部合并后写回冲突表）');
  assert.match(modsSrc, /setModConflicts\(conflictMap\)/, 'registerPacks 把合并后的冲突表（MOD 级 + pack 级）写回');
  assert.match(mainSrc, /for \(const other of modConflicts\(m\.id\)\) if \(!isModOff\(other\)\) setModOff\(other, true\)/,
    '启动时把冲突方卸下（先加载的保留）');
});

test('界面：两处开关都走 toggleMod，自动卸下后提示玩家', () => {
  assert.equal((titleSrc.match(/toggleMod\(id, !isOff, plugins\)/g) || []).length, 2, '插件面板与 MOD 管理共用同一个开关');
  assert.match(titleSrc, /const autoOff = setModOff\(id, off\) \|\| \[\]/, '取回被自动卸下的 id');
  assert.match(titleSrc, /已自动卸下「\{NAMES\}」：与「\{NAME\}」不能同时启用/, '提示文案走 i18n');
  assert.match(titleSrc, /const nameOf = \(mid\) =>/, '把 id 翻译成插件名再提示');
  assert.doesNotMatch(titleSrc, /onClick=\$\{\(e\) => \{ e\.stopPropagation\(\);[\s\S]{0,120}setModOff\(id, !isOff\)\}/,
    '不再有绕过 toggleMod 的裸 setModOff');
});

test('机制本身是可选的：没有声明冲突时行为与以前完全一致', () => {
  assert.match(modsSrc, /export function setModConflicts\(map\)/, '冲突表可安装');
  assert.match(modsSrc, /if \(!off\) \{\s*\n\s*for \(const other of modConflicts\(id\)\)/, '只有启用时才处理冲突');
  assert.match(modsSrc, /return autoOff;/, '返回值向后兼容（老调用方忽略即可）');
});
