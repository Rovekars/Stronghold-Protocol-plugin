// MOD skin-override state, shared by the DOM URL helpers (ui/assetUrls.js) and the asset
// resolution layer (assets.js — battle spine / unit pictures). Kept dependency-free so both
// module layers can import it without cycles.
//
// The operator-skin plugin (mod/干员时装.js) writes here:
//   avatar / portrait  — PRTS costume images for <img> surfaces (loadout, detail, shop, thumbs);
//   spineFront / spineBack — full Spine entries ({ skel, atlas, textures, pma, anims, animations })
//     hosted by PRTS (torappu.prts.wiki, CORS open), swapped in at battle-render time by
//     assets.js spineEntry() so the board model wears the costume too.

const skinOverrides = new Map(); // charId → { avatar?, portrait?, spineFront?, spineBack? }

/** Install or update a skin override for a charId (undefined keys are kept; null clears the key). */
export function setSkinOverride(charId, { avatar, portrait, spineFront, spineBack } = {}) {
  if (!charId) return;
  const cur = skinOverrides.get(charId) || {};
  const next = { ...cur };
  if (avatar !== undefined) next.avatar = avatar || null;
  if (portrait !== undefined) next.portrait = portrait || null;
  if (spineFront !== undefined) next.spineFront = spineFront || null;
  if (spineBack !== undefined) next.spineBack = spineBack || null;
  skinOverrides.set(charId, next);
  bumpVersion();
}

/** Remove the skin override for a charId (or all if charId omitted). */
export function clearSkinOverride(charId) {
  const had = charId ? skinOverrides.delete(charId) : skinOverrides.size > 0;
  if (!charId) skinOverrides.clear();
  if (had) bumpVersion();
}

/** @returns {{ avatar?: string|null, portrait?: string|null, spineFront?: object|null, spineBack?: object|null }|undefined} */
export function getSkinOverride(charId) {
  return skinOverrides.get(charId);
}

// ---- change notification --------------------------------------------------------------------------------------------
// A monotonically increasing version + tiny pub-sub, so open screens (loadout detail, lists) can
// re-render the moment a skin is applied instead of waiting for an unrelated state change.

let version = 0;
const listeners = new Set();

function bumpVersion() {
  version += 1;
  for (const fn of [...listeners]) {
    try { fn(version); } catch { /* a broken listener must not break the writer */ }
  }
}

/** Subscribe to skin-state changes; returns an unsubscribe function. */
export function subscribeSkinState(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Current skin-state version — compare/render keys on it to pick up overrides immediately. */
export function skinStateVersion() {
  return version;
}
