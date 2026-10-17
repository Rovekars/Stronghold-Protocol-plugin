// server/modDiscovery.js — single source of truth for user MOD discovery, shared by the HTTP manifest
// (server/http/static.js scanPlugins → GET /mod/manifest.json) and the server-side hook loader
// (server/mods.js doLoad).
//
// A MOD is a top-level `*.js` file or a folder containing `index.js` (the pre-existing rules, the recursive walk
// for nested `.js` files is preserved so nothing that loaded before stops loading). NEW: a folder that contains
// `pack.json` is an 整合包 (integration pack) — its members are the `.js` files named in `pack.mods`, grouped under
// one entry and toggled atomically by the MOD manager. Pack members are never also reported as standalone plugins,
// and a pack folder is not recursed into for standalone discovery.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './http/config.js';

const MOD_ROOT = path.join(ROOT, 'public', 'mod');
const SKIP_NAMES = new Set(['node_modules', '.git', 'README.md', 'README.txt', 'readme.md', 'readme.txt', 'manifest.json', 'pack.json']);

/** Whether `p` is a regular file (swallows any error). */
const safeIsFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Read + minimally validate a pack.json. @returns {object|null} */
function readPackJson(dir) {
  try {
    const p = path.join(dir, 'pack.json');
    if (!safeIsFile(p)) return null;
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    return json;
  } catch { return null; }
}

/** Resolve a member id to a real .js file (`<id>.js` or `<id>/index.js`). @returns {string|null} absolute path */
function memberFile(dir, mid) {
  if (!mid || typeof mid !== 'string') return null;
  const direct = path.join(dir, `${mid}.js`);
  if (safeIsFile(direct)) return direct;
  const idx = path.join(dir, mid, 'index.js');
  if (safeIsFile(idx)) return idx;
  return null;
}

const fileUrl = (rel) => `/mod/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;

/**
 * Discover user MODs under `root`.
 * @param {string} [root] defaults to <ROOT>/public/mod
 * @returns {{ standalone: Array<{id:string, full:string, file:string}>, packs: Array<{id:string, name:string, author:string, description:string, version:string, conflicts:string[], full:string, file:string, members: Array<{id:string, full:string, file:string}>}> }}
 */
export function discoverMods(root = MOD_ROOT) {
  const out = { standalone: [], packs: [] };
  const seen = new Set();
  let top;
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of top) {
    if (e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const pack = readPackJson(full);
      if (pack) {
        const id = (typeof pack.id === 'string' && pack.id) || e.name;
        const members = [];
        for (const m of (Array.isArray(pack.mods) ? pack.mods : [])) {
          const mid = typeof m === 'string' ? m.replace(/\.js$/, '') : (m && typeof m.id === 'string' && m.id.replace(/\.js$/, ''));
          if (!mid || seen.has(mid)) continue;
          const mf = memberFile(full, mid);
          if (!mf) continue;
          seen.add(mid);
          members.push({ id: mid, full: mf, file: fileUrl(path.join(e.name, path.relative(full, mf))) });
        }
        out.packs.push({
          id, name: pack.name || id, author: pack.author || '', description: pack.description || '',
          version: pack.version || '', conflicts: Array.isArray(pack.conflicts) ? pack.conflicts.filter((x) => typeof x === 'string') : [],
          full, file: fileUrl(path.join(e.name, 'pack.json')), members,
        });
        continue;
      }
      // ordinary mod folder (index.js) — reported as a standalone mod (preserves the prior top-level rule)
      const idx = path.join(full, 'index.js');
      if (safeIsFile(idx) && !seen.has(e.name)) {
        seen.add(e.name);
        out.standalone.push({ id: e.name, full: idx, file: fileUrl(path.join(e.name, 'index.js')) });
      }
      collectNested(full, e.name, out.standalone, seen);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      const id = e.name.replace(/\.js$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      out.standalone.push({ id, full, file: fileUrl(e.name) });
    }
  }
  return out;
}

/** Recurse into a non-pack folder for nested `.js` files (preserves the prior recursive behavior; id = relative path). */
function collectNested(dir, rel, out, seen) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collectNested(full, r, out, seen);
    else if (e.isFile() && e.name.endsWith('.js')) {
      const id = r.replace(/\.js$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, full, file: fileUrl(r) });
    }
  }
}
