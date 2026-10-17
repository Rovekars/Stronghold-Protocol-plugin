// 整合包（integration packs）源码级契约锁：文件夹式 pack.json + 整体原子启停。
// 与 test/ui/blindbox.test.js 同风格：直接读源文件做正则断言，确保关键代码路径不被后续改动悄悄抹掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const titleSrc = read('public/js/screens/title.js');
const mainSrc = read('public/js/main.js');
const modsSrc = read('public/js/ui/mods.js');
const staticSrc = read('server/http/static.js');
const modsServerSrc = read('server/mods.js');
const discSrc = read('server/modDiscovery.js');

test('单一真相源：server/modDiscovery.js 同时被 manifest 与 server 钩子加载器使用', () => {
  assert.match(staticSrc, /import \{ discoverMods \} from '\.\.\/modDiscovery\.js'/, 'static.js 引入 discoverMods');
  assert.match(modsServerSrc, /import \{ discoverMods \} from '\.\/modDiscovery\.js'/, 'mods.js 引入 discoverMods');
  assert.match(discSrc, /export function discoverMods/, 'discoverMods 是单一发现源');
});

test('manifest 现在带 packs 字段（pack 成员不入 standalone）', () => {
  assert.match(staticSrc, /const \{ standalone, packs \} = discoverMods\(\)/, 'scanPlugins 拆出 packs');
  assert.match(staticSrc, /return \{ plugins, packs: outPacks \};/, 'manifest 返回 packs');
  assert.match(staticSrc, /members: p\.members\.map/, 'pack 成员随 manifest 下发');
});

test('main.js 加载 pack 成员并登记整合包（store.ui.packs）', () => {
  assert.match(mainSrc, /const packs = \(manifest && Array\.isArray\(manifest\.packs\)\) \? manifest\.packs : \[\]/, '读取 manifest.packs');
  assert.match(mainSrc, /for \(const pack of packs\) \{\s*for \(const m of \(pack\.members/, '逐包加载成员（带 pack 标记）');
  assert.match(mainSrc, /pack: pack\.id, packName: pack\.name/, '成员 meta 打上 pack 标记');
  assert.match(mainSrc, /registerPacks\(packList(, [^)]*)?\)/, '登记整合包（成员 + 包级冲突，并传入 MOD 级 conflicts）');
  assert.match(mainSrc, /store\.patch\('ui', \{ plugins: loaded, packs: packList \}\)/, 'ui.packs 写入 store');
});

test('ui/mods.js 提供整合包原子启停助手', () => {
  assert.match(modsSrc, /export function registerPacks\(packs(, [^)]*)?\)/, 'registerPacks');
  assert.match(modsSrc, /export function isPackOff\(id\)/, 'isPackOff');
  assert.match(modsSrc, /export function setPackOff\(id, off\)/, 'setPackOff');
  assert.match(modsSrc, /const PACK_MEMBERS = new Map\(\)/, '成员映射在内存登记');
  assert.match(modsSrc, /for \(const mid of members\) if \(isModOff\(mid\) !== !!off\) setModOff\(mid, !!off\)/, '总开关驱动每个成员 off 状态（原子）');
  assert.match(modsSrc, /for \(const other of modConflicts\(id\)\) \{\s*if \(!packOffMap\(\)\[other\]\) setPackOff\(other, true\)/, '开启时级联卸下冲突包');
});

test('title.js 按 pack 分组渲染：包头 + 总开关 + 成员只读列出', () => {
  assert.match(titleSrc, /import \{ modsOffMap, setModOff, onModsChanged, addModsFromFiles, removeUserMod, isPackOff, setPackOff \} from '\.\.\/ui\/mods\.js'/, 'title 引入 isPackOff / setPackOff');
  assert.match(titleSrc, /const packs = useStore\(\(s\) => s\.ui\.packs\)/, '读取 ui.packs');
  assert.match(titleSrc, /function renderPackGroup\(pk, plugins\)/, '整合包分组渲染函数');
  assert.match(titleSrc, /const members = plugins\.filter\(\(p\) => p\.pack === pk\.id\)/, '成员按 pack 标记归组');
  assert.match(titleSrc, /t\('整合包'\)/, '整合包徽标文案');
  assert.match(titleSrc, /t\('内含 \{N\} 个 MOD'/, '内含 N 个 MOD 文案');
  assert.match(titleSrc, /setPackOff\(pk\.id,/, '总开关调用 setPackOff');
  // 面板与 MOD 管理弹窗两套视图都按 pack 分组
  assert.match(titleSrc, /packs\.map\(\(pk\) => renderPackGroup\(pk, plugins\)\)/, '插件面板渲染整合包分组');
  assert.match(titleSrc, /packs\.map\(\(pk\) => \{[\s\S]*?isPackOff\(pk\.id\)[\s\S]*?setPackOff\(pk\.id,/, 'MOD 管理弹窗也渲染整合包（总开关）');
});

test('en.json 已覆盖整合包相关新文案', () => {
  const en = JSON.parse(read('public/i18n/en.json'));
  for (const k of ['整合包', '内含 {N} 个 MOD', '已开启整合包「{NAME}」，旗下 {N} 个 MOD 一并启用', '已关闭整合包「{NAME}」，旗下 {N} 个 MOD 一并卸下']) {
    assert.ok(en[k], `en.json lacks "${k}"`);
  }
});
