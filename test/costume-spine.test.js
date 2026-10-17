// data/costume-spine.json invariant: every anim clip name must be a REAL animation of the char's base model.
// Regression (user report 2026-10-10): tools/fetch-prts-spine.mjs used a naive printable-string scan on the
// .skel binary; Spine stores names length-prefixed (prefix = len + 1) and the timeline bytes that follow a
// name are often printable ASCII, so the scan glued them on ("Idle" + 0x31 0x30 → "Idle10"). The poisoned
// mapping (Attack10/IdleQ/AttackOE/Attack@3…) never matched the runtime skeleton, whose parse yields clean
// names — the renderer's `_attackClip()` found no attack loop and skins silently lost their attack animation
// (idle kept working only through its hardcoded 'Idle' fallback in render/spine.js `_idleName()`).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spine = JSON.parse(readFileSync(join(ROOT, 'data/costume-spine.json'), 'utf8'));
const assets = JSON.parse(readFileSync(join(ROOT, 'data/assets.json'), 'utf8'));

/** Every legit animation name of a char's base model: the anims-mapping clip values + animations keys. */
function baseNames(charId) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { out.add(v); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  for (const side of ['front', 'back']) {
    const e = assets.chars?.[charId]?.spine?.[side];
    if (!e) continue;
    walk(e.anims);
    if (e.animations) for (const k of Object.keys(e.animations)) out.add(k);
  }
  return out;
}

describe('costume-spine.json anim names', () => {
  it('every skin anim clip value is a base-model animation name (no scan-glued garbage)', () => {
    let refs = 0, entries = 0;
    const bad = [];
    for (const [charId, skins] of Object.entries(spine.chars || {})) {
      const names = baseNames(charId);
      const walk = (v, path) => {
        if (typeof v === 'string') {
          refs += 1;
          if (!names.has(v)) bad.push(`${charId} ${path} → ${v}`);
          return;
        }
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      };
      for (const rec of Object.values(skins || {})) {
        for (const side of ['front', 'back']) {
          const e = rec?.[side];
          if (!e?.anims) continue;
          entries += 1;
          walk(e.anims, side);
        }
      }
    }
    assert.ok(entries > 0, 'the dataset has skin entries');
    assert.deepEqual(bad, []);
  });

  it('the known-poisoned skins now resolve to the canonical clips', () => {
    const angel = spine.chars?.char_103_angel?.['野地秘行']?.front?.anims;
    assert.equal(angel?.attack?.loop, 'Attack');
    assert.equal(angel?.idle, 'Idle');
    assert.equal(angel?.deploy, 'Start');
    const slchan = spine.chars?.char_173_slchan?.['孤攀客']?.front?.anims;
    assert.equal(slchan?.attack?.loop, 'Attack');
    assert.equal(slchan?.idle, 'Idle');
  });
});
