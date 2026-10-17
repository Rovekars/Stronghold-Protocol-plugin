// server/modDiscovery.js — single source of truth for user MOD discovery, shared by the HTTP manifest
// (server/http/static.js scanPlugins) and the server-side hook loader (server/mods.js doLoad).
// Verifies: standalone MODs, 整合包 (integration packs) grouping, members never double-reported, pack.json parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverMods } from '../../server/modDiscovery.js';

test('discoverMods: standalone .js + folder/index.js are reported as standalone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  try {
    fs.writeFileSync(path.join(dir, 'solo.js'), 'export default {};');
    fs.mkdirSync(path.join(dir, 'folder-mod'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'folder-mod', 'index.js'), 'export default {};');
    const { standalone, packs } = discoverMods(dir);
    const ids = standalone.map((s) => s.id);
    // 顶层 .js 与 目录/index.js 都作为 standalone 出现（目录式插件继承旧递归扫描约定，其 index.js 也可能被一并列出）
    assert.ok(ids.includes('solo'), 'solo.js 是 standalone');
    assert.ok(ids.includes('folder-mod'), 'folder-mod/index.js 是 standalone');
    assert.equal(packs.length, 0);
    // file URLs are rooted at /mod/
    const solo = standalone.find((s) => s.id === 'solo');
    assert.equal(solo.file, '/mod/solo.js');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discoverMods: a folder with pack.json becomes a 整合包, members grouped, not standalone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  try {
    fs.writeFileSync(path.join(dir, 'solo.js'), 'export default {};');
    fs.mkdirSync(path.join(dir, 'mypack'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mypack', 'pack.json'),
      JSON.stringify({ id: 'pk1', name: '测试包', author: 'me', description: 'd', mods: ['a', 'b'] }));
    fs.writeFileSync(path.join(dir, 'mypack', 'a.js'), 'export default {};');
    fs.writeFileSync(path.join(dir, 'mypack', 'b.js'), 'export default {};');
    const { standalone, packs } = discoverMods(dir);
    assert.equal(standalone.length, 1, 'one standalone (solo)');
    assert.equal(standalone[0].id, 'solo');
    assert.equal(packs.length, 1, 'one pack');
    const pk = packs[0];
    assert.equal(pk.id, 'pk1');
    assert.equal(pk.name, '测试包');
    assert.equal(pk.author, 'me');
    assert.deepEqual(pk.members.map((m) => m.id).sort(), ['a', 'b']);
    // members must NOT appear as standalone
    assert.ok(!standalone.some((s) => s.id === 'a' || s.id === 'b'));
    // member file URLs stay inside /mod/<pack>/
    assert.ok(pk.members.every((m) => m.file.startsWith('/mod/mypack/')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discoverMods: pack with missing member files skips them; folder without index.js is not a standalone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  try {
    fs.mkdirSync(path.join(dir, 'mypack'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mypack', 'pack.json'), JSON.stringify({ id: 'pk', mods: ['exists', 'ghost'] }));
    fs.writeFileSync(path.join(dir, 'mypack', 'exists.js'), 'export default {};');
    // 'ghost.js' is intentionally absent
    const { standalone, packs } = discoverMods(dir);
    assert.equal(standalone.length, 0, 'no standalone from a pack-only folder');
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].members.map((m) => m.id), ['exists']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discoverMods: duplicate member ids across packs are de-duplicated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  try {
    fs.mkdirSync(path.join(dir, 'p1'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'p2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'p1', 'pack.json'), JSON.stringify({ id: 'p1', mods: ['shared'] }));
    fs.writeFileSync(path.join(dir, 'p2', 'pack.json'), JSON.stringify({ id: 'p2', mods: ['shared'] }));
    fs.writeFileSync(path.join(dir, 'p1', 'shared.js'), 'export default {};');
    fs.writeFileSync(path.join(dir, 'p2', 'shared.js'), 'export default {};');
    const { packs } = discoverMods(dir);
    const memberIds = packs.flatMap((p) => p.members.map((m) => `${p.id}:${m.id}`));
    assert.equal(memberIds.length, new Set(memberIds).size, 'no duplicate member id reported');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
