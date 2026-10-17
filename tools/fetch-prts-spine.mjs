// 构建期脚本：从 PRTS 抓取全皮肤 Spine（骨骼动画）模型清单，生成 data/costume-spine.json。
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 数据源（2026-10 探明，CORS 全开，浏览器可直连）：
//   https://torappu.prts.wiki/assets/char_spine/<charId>/meta.json
//     → { prefix, name, skin: { [皮肤中文名]: { 正面: { file }, 背面?: { file }, 基建?: { file } } } }
//   模型文件 = prefix + file + '.skel' / '.atlas' / '.png'（官方游戏数据，spine 3.8 二进制）。
//
// 产出（data/costume-spine.json）：
//   { generatedAt, source, versions: {…}, chars: { [charId]: { [皮肤中文名]: { front: ENTRY, back: ENTRY|null } } } }
//   ENTRY = { skel, atlas, textures[], pma, anims, animations }
//   anims / animations 由本体 data/assets.json 里基础模型的动画映射，与皮肤 .skel 二进制中实际存在的
//   动画名求交集得到（皮肤缺某动画时该角色位置为 null，渲染端安全跳过）。
//
// 用法：
//   node tools/fetch-prts-spine.mjs --out data/costume-spine.json [--cache-dir .cache/prts-spine] [--limit N]
// 依赖 data/costumes.json（tools/fetch-prts-costumes.mjs 的产物）与 data/chess.json、data/assets.json。

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://prts.wiki/',
};

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const CACHE_DIR = join(ROOT, opt('cache-dir', '.cache/prts-spine'));
const OUT = join(ROOT, opt('out', 'data/costume-spine.json'));
const LIMIT = Number(opt('limit', '0')) || Infinity;
const CONCURRENCY = Number(opt('concurrency', '8')) || 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCached(url, ext, tries = 3) {
  const key = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._/-]/g, '_') + ext;
  const path = join(CACHE_DIR, key);
  if (existsSync(path)) {
    const buf = await readFile(path);
    if (buf.length) return buf;
  }
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty body');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buf);
      return buf;
    } catch (e) {
      if (t === tries - 1) { console.warn(`  ! fetch failed: ${url} (${e.message})`); return null; }
      await sleep(600 * (t + 1));
    }
  }
  return null;
}

/** Printable strings from a spine .skel binary. Spine stores every string length-prefixed (single-byte
 * prefix = len + 1 for len < 127), so a REAL name is a printable run whose preceding byte equals len + 1.
 * A naive scan glues the timeline bytes that follow a name onto it (they are often printable ASCII:
 * "Idle" + 0x31 0x30 → token "Idle10" — exactly the bug that poisoned costume-spine.json anims with
 * Attack10/IdleQ/AttackOE and broke skins' attack clips), so each run is accepted only after trimming
 * trailing characters until the prefix check holds. */
function stringSet(buf) {
  const set = new Set();
  let start = -1;
  const flush = (i) => {
    if (start < 0) return;
    const from = start;
    const max = i - from;
    start = -1;
    if (max < 2) return;
    for (let len = max; len >= 2; len--) {
      // a real string of this length sits behind a prefix byte of len + 1
      if (from > 0 && buf[from - 1] === len + 1) {
        set.add(buf.toString('latin1', from, from + len));
        return;
      }
    }
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) { if (start < 0) start = i; }
    else flush(i);
  }
  flush(buf.length);
  return set;
}

/** Spine version string in a .skel binary header (e.g. 3.8.99), or null. */
function spineVersion(buf) {
  const m = buf.slice(0, 120).toString('latin1').match(/[234]\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Keep base-model animation mapping only where the skin skeleton really has that animation. */
function makeResolver(strings) {
  // Skin skeletons rename animations with a short alphanumeric suffix (Idle → Idle10 / IdleQ / IdleOE…),
  // so resolve a base animation name to an exact hit, else the shortest prefixed candidate.
  const candidates = (name) => {
    const list = [];
    for (const s of strings) {
      if (s.length > name.length && s.startsWith(name) && s.length - name.length <= 3) list.push(s);
    }
    if (!list.length) return null;
    list.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    return list[0];
  };
  return (name) => (strings.has(name) ? name : candidates(name));
}

function adaptAnims(anims, strings) {
  if (!anims || typeof anims !== 'object') return null;
  const resolve = makeResolver(strings);
  const has = (n) => (typeof n === 'string' ? resolve(n) : false);
  const clip = (c) => {
    if (!c || typeof c !== 'object') return c ?? null;
    const out = {};
    let any = false;
    for (const [k, v] of Object.entries(c)) {
      if (v === null) { out[k] = null; continue; }
      if (k === 'index' || k === 'via') { out[k] = v; any = any || k === 'via'; continue; }
      const r = has(v);
      if (r) { out[k] = r; any = true; } else out[k] = null;
    }
    return any ? out : null;
  };
  const out = {};
  for (const [role, v] of Object.entries(anims)) {
    if (role === 'skills') {
      const sk = {};
      for (const [idx, c] of Object.entries(v || {})) { const r = clip(c); if (r) sk[idx] = r; }
      out.skills = Object.keys(sk).length ? sk : null;
      continue;
    }
    if (v === null) { out[role] = null; continue; }
    if (typeof v === 'string') { out[role] = has(v) || null; continue; }
    out[role] = clip(v);
  }
  return out;
}

function adaptAnimations(anims, strings) {
  if (!anims || typeof anims !== 'object') return null;
  const resolve = makeResolver(strings);
  const out = {};
  for (const [name, dur] of Object.entries(anims)) {
    const r = resolve(name);
    if (r) out[r] = dur;
  }
  return Object.keys(out).length ? out : null;
}

async function buildEntry(prefix, file, baseAnims, baseAnimations) {
  const base = prefix + file;
  const skelUrl = `${base}.skel`;
  const [skelBuf, atlasBuf] = await Promise.all([
    fetchCached(skelUrl, ''),
    fetchCached(`${base}.atlas`, ''),
  ]);
  if (!skelBuf || !atlasBuf) return null;
  const version = spineVersion(skelBuf);
  if (!version) { console.warn(`  ! not a spine skel: ${skelUrl}`); return null; }
  const atlasText = atlasBuf.toString('utf8');
  const pma = /pma:\s*true/i.test(atlasText);
  const pngUrls = [...atlasText.matchAll(/^([^\s:][^\s]*\.png)$/gm)].slice(0, 4).map((m) => prefix + file.replace(/\/[^/]+$/, '/') + m[1]);
  const textures = pngUrls.length ? pngUrls : [`${base}.png`];
  const strings = stringSet(skelBuf);
  const entry = {
    skel: skelUrl,
    atlas: `${base}.atlas`,
    textures,
    pma,
    anims: adaptAnims(baseAnims, strings),
    animations: adaptAnimations(baseAnimations, strings),
    spineVersion: version,
  };
  if (!entry.anims) return null; // 没有可用的动画映射，宁可不用（保底基础模型/头像钻石）
  return entry;
}

async function pool(items, n, fn) {
  const ret = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  }));
  return ret;
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  const costumes = JSON.parse(await readFile(join(ROOT, 'data/costumes.json'), 'utf8')).costumes;
  const chess = JSON.parse(await readFile(join(ROOT, 'data/chess.json'), 'utf8'));
  const assets = JSON.parse(await readFile(join(ROOT, 'data/assets.json'), 'utf8'));

  // operator name → [{ charId, baseAnims, baseAnimations }]（a/b 金卡变体共享同一 charId，需去重）
  const byOperator = new Map();
  for (const rec of Object.values(chess)) {
    if (!rec?.charId || !rec?.name) continue;
    const list = byOperator.get(rec.name) || [];
    if (list.some((e) => e.charId === rec.charId)) continue;
    const base = assets.chars?.[rec.charId]?.spine?.front || null;
    byOperator.set(rec.name, [...list, {
      charId: rec.charId,
      baseAnims: base?.anims || null,
      baseAnimations: base?.animations || null,
    }]);
  }

  // unique charIds needed (only operators that appear in the costume gallery)
  const wantedOperators = [...new Set(costumes.map((c) => c.operator))].slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const wantedCharIds = new Set();
  for (const name of wantedOperators) for (const e of byOperator.get(name) || []) wantedCharIds.add(e.charId);
  console.log(`costumes: ${costumes.length}, operators: ${wantedOperators.length}, charIds: ${wantedCharIds.size}`);

  const metaCache = new Map();
  const versionHist = {};
  let skins = 0, missingMeta = 0, missingSkin = 0, noBaseAnims = 0;

  const charIds = [...wantedCharIds];
  await pool(charIds, CONCURRENCY, async (charId) => {
    const url = `https://torappu.prts.wiki/assets/char_spine/${charId}/meta.json`;
    const buf = await fetchCached(url, '.json');
    if (!buf) { metaCache.set(charId, null); return; }
    let meta;
    try { meta = JSON.parse(buf.toString('utf8')); } catch { metaCache.set(charId, null); return; }
    metaCache.set(charId, meta);
  });

  const charsOut = {};
  for (const name of wantedOperators) {
    const entries = byOperator.get(name) || [];
    for (const { charId, baseAnims, baseAnimations } of entries) {
      const meta = metaCache.get(charId);
      if (!meta?.skin) { missingMeta += 1; continue; }
      if (!baseAnims) noBaseAnims += 1;
      const list = costumes.filter((c) => c.operator === name);
      for (const c of list) {
        const files = meta.skin[c.skinName];
        if (!files?.正面?.file) { missingSkin += 1; continue; }
        if (LIMIT !== Infinity) { /* --limit limits operators only */ }
        const front = await buildEntry(meta.prefix, files.正面.file, baseAnims, baseAnimations);
        let back = null;
        if (files.背面?.file) back = await buildEntry(meta.prefix, files.背面.file, baseAnims, baseAnimations);
        if (front || back) {
          charsOut[charId] = charsOut[charId] || {};
          charsOut[charId][c.skinName] = { front, back };
          skins += 1;
          if (front) versionHist[front.spineVersion] = (versionHist[front.spineVersion] || 0) + 1;
        }
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'torappu.prts.wiki/assets/char_spine',
    versions: versionHist,
    chars: charsOut,
  };
  const totalKeys = Object.values(charsOut).reduce((a, sk) => a + Object.keys(sk).length, 0);
  console.log(`in-memory check: charIds=${Object.keys(charsOut).length} skinKeys=${totalKeys}`);
  await writeFile(OUT, JSON.stringify(payload));
  const { size } = await stat(OUT);
  console.log(`\nwrote ${OUT} (${(size / 1024).toFixed(0)} KB)`);
  console.log(`skins with spine: ${skins}; no meta: ${missingMeta}; skin name not in meta: ${missingSkin}; no base anims: ${noBaseAnims}`);
  console.log(`spine versions: ${JSON.stringify(versionHist)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
