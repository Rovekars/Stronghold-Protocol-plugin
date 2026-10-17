// User MOD registry (client-side companion to the plugin loader in main.js).
//
// Two pieces of state, both persisted to localStorage and notified via a window event so any
// subscribed component (title screen MOD manager, main.js PluginOverlays) re-renders:
//   1. Enabled / 卸下 state per plugin id ('sp.mods.off'). Unloading hides the plugin's registered
//      overlays everywhere (title, lobby, match); the plugin's code stays loaded — a true unload
//      would need the loader to re-import the page.
//      A MOD may declare `conflicts: ['otherId']`: the two can never run at the same time — enabling
//      one turns the other off (see MOD_CONFLICTS below).
//   2. Locally added MODs ('sp.mods.user'): .js files the player dropped onto the MOD manager on
//      the title screen. main.js's loadPlugins() imports them (from a Blob URL) after the
//      server-side /mod manifest, so they survive reloads without touching the server.
// This module is intentionally dependency-free (no store / preact imports): pure storage + events.

const OFF_KEY = 'sp.mods.off';
const USER_KEY = 'sp.mods.user';
export const MODS_EVENT = 'sp.mods';

/** @returns {Record<string, boolean>} plugin id → true (off) */
export function modsOffMap() {
  try { return JSON.parse(localStorage.getItem(OFF_KEY)) || {}; } catch { return {}; }
}

/** @param {string} id @returns {boolean} */
export function isModOff(id) {
  return !!modsOffMap()[id];
}

// ---- mutual exclusion ---------------------------------------------------------------------------
// A MOD's default export may declare `conflicts: ['otherModId']` (e.g. 创造模式 ↔ 盲盒模式: both replace the
// same parts of the match UI, so only one may run). main.js collects the declarations once every plugin is
// loaded and hands them to setModConflicts(); setModOff() then turns the conflicting MODs off when one is
// enabled, so no code path can leave two conflicting MODs on at once. Empty until the plugins load (and in
// builds without such a MOD) — a plain enable/卸下 then behaves exactly as before.
const MOD_CONFLICTS = new Map(); // id → Set<string> (ids that must be off while this one is on)

/**
 * Install the conflict map. The relation is symmetric: a declaration on either side is enforced in both
 * directions, so the two MODs never have to agree on who declares it.
 * @param {Record<string, string[]>} map plugin id → ids it cannot run alongside
 */
export function setModConflicts(map) {
  MOD_CONFLICTS.clear();
  for (const [id, list] of Object.entries(map || {})) {
    if (!id || !Array.isArray(list)) continue;
    for (const other of list) {
      if (!other || other === id) continue;
      let set = MOD_CONFLICTS.get(id);
      if (!set) MOD_CONFLICTS.set(id, set = new Set());
      let back = MOD_CONFLICTS.get(other);
      if (!back) MOD_CONFLICTS.set(other, back = new Set());
      set.add(other);
      back.add(id);
    }
  }
}

/** @param {string} id @returns {string[]} the MOD ids that must be 卸下 while `id` is enabled. */
export function modConflicts(id) {
  return MOD_CONFLICTS.has(id) ? [...MOD_CONFLICTS.get(id)] : [];
}

/** Enable / unload a plugin (id = manifest id, i.e. the file name without .js). */
export function setModOff(id, off) {
  const map = modsOffMap();
  const autoOff = [];
  // Enabling (off=false) also 卸下 every conflicting MOD — they cannot run at the same time.
  if (!off) {
    for (const other of modConflicts(id)) {
      if (map[other]) continue;
      map[other] = true;
      autoOff.push(other);
    }
  }
  if (off) map[id] = true; else delete map[id];
  try { localStorage.setItem(OFF_KEY, JSON.stringify(map)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(MODS_EVENT));
  return autoOff; // the ids unloaded by this enable (empty on a plain toggle) — the caller toasts them
}

/** Subscribe to enable-state changes. @returns {() => void} unsubscribe */
export function onModsChanged(fn) {
  window.addEventListener(MODS_EVENT, fn);
  return () => window.removeEventListener(MODS_EVENT, fn);
}

/** @returns {Array<{id: string, name: string, code: string}>} locally added MOD sources */
export function userMods() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)) || []; } catch { return []; }
}

function saveUserMods(list) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(list)); } catch { /* quota — the caller toasts */ }
}

/**
 * Read .js Files into the locally-added MOD list (persisted; loaded on the next page load).
 * @param {File[]} files
 * @returns {Promise<number>} how many were added
 */
export async function addModsFromFiles(files) {
  const list = userMods();
  let added = 0;
  for (const file of files) {
    if (!file || !/\.js$/i.test(file.name)) continue;
    let code;
    try { code = await file.text(); } catch (err) { throw new Error(`无法读取 ${file.name}：${(err && err.message) || err}`, { cause: err }); }
    // same id shape the loader reports: 'user:<file name without .js>:<ms>' — unique per drop
    const id = `user:${file.name.replace(/\.js$/i, '')}:${Date.now()}`;
    list.push({ id, name: file.name.replace(/\.js$/i, ''), code });
    added++;
  }
  if (added) saveUserMods(list);
  return added;
}

/** Remove a locally added MOD (takes effect on the next page load). */
export function removeUserMod(id) {
  saveUserMods(userMods().filter((m) => m.id !== id));
}

// ---- 整合包（integration packs）-----------------------------------------------------------------------------------
// An 整合包 (declared by a `pack.json` next to its member MODs) is toggled atomically: enabling it turns every member
// MOD on; disabling it turns every member off. The manager renders a pack as one group with a single master switch,
// so members are never toggled individually. Pack ids participate in the same mutual-exclusion map as MODs, so a pack
// may declare `conflicts: ['otherPackId']` and enabling it switches the conflicting pack off.

const PACK_OFF_KEY = 'sp.packs.off';

/** Member ids of every known pack, indexed by pack id (registered by registerPacks on boot). */
const PACK_MEMBERS = new Map(); // packId → string[]

/**
 * Register the discovered packs so the atomic helpers know each pack's members (and conflicts). Called once by
 * main.js's loadPlugins() after the manifest is read. Pack ids share the same mutual-exclusion id space as MODs, so
 * `modConflicts` (the MOD-level `conflicts`) is merged in — registerPacks must NOT drop it (setModConflicts clears the
 * map), otherwise a MOD that declared `conflicts` would stop being mutually exclusive after a pack is registered.
 * @param {Array<{ id: string, memberIds: string[], conflicts?: string[] }>} packs
 * @param {Record<string, string[]>} [modConflicts] MOD-level conflicts (id → ids it cannot run alongside)
 */
export function registerPacks(packs, modConflicts = {}) {
  PACK_MEMBERS.clear();
  const conflictMap = { ...(modConflicts || {}) };
  for (const p of packs || []) {
    if (!p || !p.id) continue;
    PACK_MEMBERS.set(p.id, Array.isArray(p.memberIds) ? p.memberIds : []);
    if (Array.isArray(p.conflicts) && p.conflicts.length) conflictMap[p.id] = p.conflicts;
  }
  setModConflicts(conflictMap);
}

/** @returns {Record<string, boolean>} pack id → true (off) */
export function packOffMap() {
  try { return JSON.parse(localStorage.getItem(PACK_OFF_KEY)) || {}; } catch { return {}; }
}

/**
 * Whether a pack is 卸下. A pack is off iff its stored flag says so; before any toggle the flag derives from its
 * members (off when every member is off), so a freshly discovered pack with all members on reads as on.
 * @param {string} id
 */
export function isPackOff(id) {
  const pm = packOffMap();
  if (Object.prototype.hasOwnProperty.call(pm, id)) return !!pm[id];
  const members = PACK_MEMBERS.get(id) || [];
  return members.every((mid) => isModOff(mid));
}

/**
 * Enable / 卸下 a whole pack atomically. Enabling also switches off any conflicting pack (which in turn switches off
 * its own members). Fires the MODS event so the manager re-renders.
 * @param {string} id
 * @param {boolean} off
 */
export function setPackOff(id, off) {
  const members = PACK_MEMBERS.get(id) || [];
  const pm = packOffMap();
  pm[id] = !!off;
  try { localStorage.setItem(PACK_OFF_KEY, JSON.stringify(pm)); } catch { /* private mode */ }
  for (const mid of members) if (isModOff(mid) !== !!off) setModOff(mid, !!off);
  if (!off) {
    for (const other of modConflicts(id)) {
      if (!packOffMap()[other]) setPackOff(other, true);
    }
  }
  window.dispatchEvent(new CustomEvent(MODS_EVENT));
}
