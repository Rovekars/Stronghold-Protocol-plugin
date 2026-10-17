// MOD skin spine override: assets.js spineEntry / unitPictureUrl must swap in the PRTS battle
// model (and the board avatar diamond) when the operator-skin plugin set a skin override.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spineEntry, unitPictureUrl, validSpine, hasBackSpine } from '../../public/js/assets.js';
import { setSkinOverride, clearSkinOverride, subscribeSkinState, skinStateVersion } from '../../public/js/skinState.js';

const M = {
  chars: {
    char_001_amiya: {
      avatar: '/a/amiya.png',
      spine: {
        front: { skel: '/spine/amiya/front.skel', atlas: '/spine/amiya/front.atlas', textures: ['/spine/amiya/front.png'], pma: false, anims: { idle: 'Idle', die: 'Die' } },
        back: { skel: '/spine/amiya/back.skel', atlas: '/spine/amiya/back.atlas', textures: ['/spine/amiya/back.png'], pma: false, anims: { idle: 'Idle' } },
      },
    },
  },
};

const SKIN_FRONT = { skel: 'https://torappu.prts.wiki/assets/char_spine/char_001_amiya/skin1/front/skin1.skel', atlas: 'https://torappu.prts.wiki/assets/char_spine/char_001_amiya/skin1/front/skin1.atlas', textures: ['https://torappu.prts.wiki/assets/char_spine/char_001_amiya/skin1/front/skin1.png'], pma: false, anims: { idle: 'Idle', die: null } };
const SKIN_BACK = { skel: 'https://torappu.prts.wiki/assets/char_spine/char_001_amiya/skin1/back/skin1.skel', atlas: 'https://torappu.prts.wiki/assets/char_spine/char_001_amiya/skin1/back/skin1.atlas', textures: ['https://torappu.prts.wiki/assets/char_spine/char_001_amiya/skin1/back/skin1.png'], pma: false, anims: { idle: 'Idle' } };

describe('skin spine override (battle board model)', () => {
  beforeEach(() => clearSkinOverride());

  it('validSpine accepts remote https entries (PRTS models are cross-origin)', () => {
    assert.equal(validSpine(SKIN_FRONT), true);
    assert.equal(validSpine({ ...SKIN_FRONT, skel: 'https://x/skin.skel' }), true);
    assert.equal(validSpine({ ...SKIN_FRONT, skel: '/local/front.skel' }), true);
    assert.equal(validSpine({ ...SKIN_FRONT, skel: 'ftp://x/skin.skel' }), false);
    assert.equal(validSpine({ ...SKIN_FRONT, anims: null }), false);
  });

  it('returns the base model without an override', () => {
    assert.equal(spineEntry(M, 'char_001_amiya', {}).skel, '/spine/amiya/front.skel');
    assert.equal(spineEntry(M, 'char_001_amiya', { back: true }).skel, '/spine/amiya/back.skel');
  });

  it('swaps the front model for the costume spine', () => {
    setSkinOverride('char_001_amiya', { spineFront: SKIN_FRONT });
    const e = spineEntry(M, 'char_001_amiya', {});
    assert.equal(e.skel, SKIN_FRONT.skel);
    // phase suffixes (`_1`/`_2`) resolve to the same override
    assert.equal(spineEntry(M, 'char_001_amiya_2', {}).skel, SKIN_FRONT.skel);
  });

  it('back follows the skin when the costume has a back model, else the base back', () => {
    setSkinOverride('char_001_amiya', { spineFront: SKIN_FRONT, spineBack: SKIN_BACK });
    assert.equal(spineEntry(M, 'char_001_amiya', { back: true }).skel, SKIN_BACK.skel);
    setSkinOverride('char_001_amiya', { spineFront: SKIN_FRONT, spineBack: null });
    assert.equal(spineEntry(M, 'char_001_amiya', { back: true }).skel, '/spine/amiya/back.skel');
  });

  it('clearing the override restores the base model', () => {
    setSkinOverride('char_001_amiya', { spineFront: SKIN_FRONT });
    clearSkinOverride('char_001_amiya');
    assert.equal(spineEntry(M, 'char_001_amiya', {}).skel, '/spine/amiya/front.skel');
  });

  it('a malformed override entry is ignored', () => {
    setSkinOverride('char_001_amiya', { spineFront: { skel: 'https://x/skin.skel' } }); // no atlas/anims
    assert.equal(spineEntry(M, 'char_001_amiya', {}).skel, '/spine/amiya/front.skel');
  });

  it('the board avatar diamond wears the costume head (unitPictureUrl)', () => {
    assert.equal(unitPictureUrl(M, 'char_001_amiya'), '/a/amiya.png');
    setSkinOverride('char_001_amiya', { avatar: 'https://media.prts.wiki/head.png' });
    assert.equal(unitPictureUrl(M, 'char_001_amiya'), 'https://media.prts.wiki/head.png');
    // the override is keyed by charId and only set for real operators; an unrelated id is untouched
    assert.equal(unitPictureUrl(M, 'char_999_none'), null);
    setSkinOverride('char_999_none', { avatar: '/nope.png' });
    assert.equal(unitPictureUrl(M, 'char_999_none'), '/nope.png'); // operator override wins even without a manifest record
  });

  it('hasBackSpine still reports the manifest back (skin back does not affect the flag)', () => {
    setSkinOverride('char_001_amiya', { spineFront: SKIN_FRONT });
    assert.equal(hasBackSpine(M, 'char_001_amiya'), true);
  });
});

describe('skin state change notification', () => {
  beforeEach(() => clearSkinOverride());

  it('setSkinOverride bumps the version and notifies subscribers', () => {
    const seen = [];
    const unsub = subscribeSkinState((v) => seen.push(v));
    const v0 = skinStateVersion();
    setSkinOverride('char_001_amiya', { avatar: '/x.png' });
    assert.equal(seen.length, 1);
    assert.equal(skinStateVersion(), v0 + 1);
    assert.equal(seen[0], v0 + 1);
    unsub();
    setSkinOverride('char_001_amiya', { avatar: '/y.png' });
    assert.equal(seen.length, 1); // no notify after unsubscribe
  });

  it('clearSkinOverride notifies when something was actually removed', () => {
    const seen = [];
    const unsub = subscribeSkinState(() => seen.push(1));
    setSkinOverride('char_001_amiya', { avatar: '/x.png' });
    const n = seen.length;
    clearSkinOverride('char_001_amiya');
    assert.equal(seen.length, n + 1);
    clearSkinOverride('char_001_amiya'); // already gone → silent
    assert.equal(seen.length, n + 1);
    clearSkinOverride('char_999_nobody'); // never set → silent
    assert.equal(seen.length, n + 1);
    unsub();
  });
});
