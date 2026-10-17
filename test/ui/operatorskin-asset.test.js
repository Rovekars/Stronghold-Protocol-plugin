import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chessAvatarUrl,
  chessPortraitUrl,
  setSkinOverride,
  clearSkinOverride,
  getSkinOverride,
} from '../../public/js/ui/assetUrls.js';

describe('operator-skin asset overrides', () => {
  const baseM = {
    chars: {
      chess_char_1_01_a: { avatar: '/a/avatar_a.png', portrait: '/a/portrait_a.png', avatarE2: '/a/avatar_a_e2.png', portraitE2: '/a/portrait_a_e2.png' },
      chess_char_1_01_b: { avatar: '/a/avatar_b.png', portrait: '/a/portrait_b.png' },
    },
  };

  it('returns base avatar/portrait without override', () => {
    const chess = { charId: 'chess_char_1_01_a', isGolden: true, assets: { avatar: 'chess_char_1_01_a', portrait: 'chess_char_1_01_a' } };
    assert.equal(chessAvatarUrl(baseM, chess), '/a/avatar_a.png');
    assert.equal(chessPortraitUrl(baseM, chess), '/a/portrait_a_e2.png');
  });

  it('overrides avatar and portrait when setSkinOverride is used', () => {
    const chess = { charId: 'chess_char_1_01_a', assets: { avatar: 'chess_char_1_01_a', portrait: 'chess_char_1_01_a' } };
    setSkinOverride('chess_char_1_01_a', { avatar: '/skin/head.png', portrait: '/skin/bust.png' });
    assert.equal(chessAvatarUrl(baseM, chess), '/skin/head.png');
    assert.equal(chessPortraitUrl(baseM, chess), '/skin/bust.png');
    const over = getSkinOverride('chess_char_1_01_a');
    assert.equal(over.avatar, '/skin/head.png');
    assert.equal(over.portrait, '/skin/bust.png');
  });

  it('clears override for one charId', () => {
    const chess = { charId: 'chess_char_1_01_a', assets: { avatar: 'chess_char_1_01_a', portrait: 'chess_char_1_01_a' } };
    clearSkinOverride('chess_char_1_01_a');
    assert.equal(chessAvatarUrl(baseM, chess), '/a/avatar_a.png');
    assert.equal(getSkinOverride('chess_char_1_01_a'), undefined);
  });

  it('clears all overrides', () => {
    setSkinOverride('chess_char_1_01_a', { avatar: '/s1.png' });
    setSkinOverride('chess_char_1_01_b', { portrait: '/s2.png' });
    clearSkinOverride();
    assert.equal(getSkinOverride('chess_char_1_01_a'), undefined);
    assert.equal(getSkinOverride('chess_char_1_01_b'), undefined);
  });
});
