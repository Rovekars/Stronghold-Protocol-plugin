// 干员时装插件：卸下后恢复原本皮肤（用户需求 2026-10-10）。
// 逻辑层（真实运行 MOD 的 setup，mock 掉本体模块 + window）：
//   * 卸下（MOD off）触发 MODS_EVENT 时，必须调用 clearSkinOverride() 清除全部皮肤覆盖；
//   * 卸下状态初始化 / 重新启用时不应再清除。
// 文件层（防回退）：源码必须真的引入 mods.js、有 isOff 守卫与 clearSkinOverride() 调用，
//   避免将来被 codemod 误删后只剩 stub 假象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'public/mod/干员时装.js');
const TMP = path.join(ROOT, 'test/.tmp-skin-unload');
const OP = path.join(TMP, 'op-src.mjs');
const srcText = fs.readFileSync(SRC, 'utf8');

// ── file-level anti-regression assertions ──────────────────────────────────────
test('卸下恢复：源码接线正确（防回退）', () => {
  assert.match(srcText, /import \{ modsOffMap, MODS_EVENT \} from '\.\.\/js\/ui\/mods\.js';/,
    'the mod imports the off-state API from ui/mods.js');
  assert.match(srcText, /const MOD_ID = 'operatorskin';/,
    'the mod knows its own id');
  assert.match(srcText, /const isOff = \(\) => \{ try \{ return !!modsOffMap\(\)\[MOD_ID\]; \}/,
    'the mod can tell whether it is 卸下 (off)');
  assert.match(srcText, /const applyAll = \(\) => \{\s*if \(isOff\(\)\) return;/,
    'applyAll() is a no-op while the mod is 卸下');
  assert.match(srcText, /window\.addEventListener\(MODS_EVENT, \(\) => \{\s*if \(isOff\(\)\) clearSkinOverride\(\);/,
    'on 卸下 it clears every skin override (back to base look)');
});

// ── runtime logic test (real MOD setup with stubbed engine modules) ─────────────
// self-contained: writes its own stub modules under TMP so it never depends on a
// leftover directory created by a previous run.
const STUBS = {
  'stub-preact-hooks.js': "export const useState=(v)=>[typeof v==='function'?v():v,()=>{}];export const useEffect=()=>{};export const useMemo=(f)=>(typeof f==='function'?f():f);export const useRef=()=>({current:null});",
  'stub-store.js': "export const loadPref=()=>({});export const savePref=()=>{};",
  'stub-audio.js': "export const audio={sfx:()=>{}};",
  'stub-asseturls.js': "export const setSkinOverride=(...a)=>{globalThis.__skin_set=(globalThis.__skin_set||0)+1;};export const clearSkinOverride=(...a)=>{globalThis.__skin_clear=(globalThis.__skin_clear||0)+1;};export const getSkinOverride=()=>undefined;",
  'stub-mods.js': "export const MODS_EVENT='sp.mods.test';let offMap={};export const __setOff=(m)=>{offMap=m||{};};export const modsOffMap=()=>offMap;",
};

test('卸下恢复：运行时卸下触发 clearSkinOverride', async () => {
  // mock window so the MOD can subscribe to MODS_EVENT without a browser.
  const winListeners = {};
  const myWin = {
    addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (ev) => { (winListeners[ev && ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  global.window = myWin;
  global.fetch = async () => ({ ok: false, json: async () => null });

  // write stub modules + node-importable copy of the MOD (engine imports redirected)
  fs.mkdirSync(TMP, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(TMP, name), body);
  const code = srcText
    .replace("import { useState, useEffect, useMemo, useRef } from 'preact/hooks';", "import { useState, useEffect, useMemo, useRef } from './stub-preact-hooks.js';")
    .replace("import { loadPref, savePref } from '../js/store.js';", "import { loadPref, savePref } from './stub-store.js';")
    .replace("import { audio } from '../js/audio.js';", "import { audio } from './stub-audio.js';")
    .replace("import { setSkinOverride, clearSkinOverride } from '../js/ui/assetUrls.js';", "import { setSkinOverride, clearSkinOverride } from './stub-asseturls.js';")
    .replace("import { modsOffMap, MODS_EVENT } from '../js/ui/mods.js';", "import { modsOffMap, MODS_EVENT } from './stub-mods.js';");
  fs.writeFileSync(OP, code);

  try {
    const { MODS_EVENT, __setOff } = await import('../.tmp-skin-unload/stub-mods.js');
    globalThis.__skin_clear = 0;
    globalThis.__skin_set = 0;

    // enabled at startup
    __setOff({});
    global.window = myWin; // ensure the MOD registers its listener on OUR window
    const setup = (await import('../.tmp-skin-unload/op-src.mjs')).default;
    setup({ registerDetailAction: () => {}, data: { subscribe: () => undefined, list: () => [] }, html: () => null, toast: () => {} });
    assert.equal(globalThis.__skin_clear, 0, 'enabled init must NOT clear overrides');

    // user 卸下 (unload) the mod
    __setOff({ operatorskin: true });
    global.window = myWin; // make sure dispatch hits OUR window with the registered listener
    global.window.dispatchEvent({ type: MODS_EVENT });
    assert.equal(globalThis.__skin_clear, 1, '卸下 must clear ALL skin overrides once → every operator back to base');

    // re-enable: must not clear again (the off→on branch re-applies instead)
    __setOff({});
    global.window = myWin;
    global.window.dispatchEvent({ type: MODS_EVENT });
    assert.equal(globalThis.__skin_clear, 1, 're-enable must not clear again (it re-applies saved selections)');
  } finally {
    try { fs.rmSync(OP, { force: true }); } catch { /* ignore */ }
  }
});
