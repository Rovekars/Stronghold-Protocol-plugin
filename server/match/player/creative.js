// server/match/player/creative.js — PlayerState methods: the 创造模式 MOD's free pick. The sandbox switch and the
// per-match layer cap live on the match (Match.creative, match/intents.js creativeSet); here a player takes any known
// chess for free during PREP — from the shared pool (so the pool economy stays consistent), with the immediate-merge
// rule applying exactly like a shop buy (acquireChess). Installed on PlayerState.prototype by server/match/PlayerState.js.

import { PHASE, ERR } from '../../../shared/constants.js';
import { N_ } from '../../../shared/i18n.js';
import { OK, fail } from './common.js';

export class PlayerCreative {
  /**
   * g.creativePick { id, kind? }: grant any known chess or item for free (创造模式 must be on, PREP only). A chess
   * takes pool copies when available (poolCopies 0 when the pool is dry — the sandbox never runs out), merges
   * immediately on a completing copy (invariants.js "merges are immediate"), fires onGain like any other grant. An
   * item goes through acquireItem (2 identical → the golden item, exactly like a shop buy). Returns OK, or
   * CREATIVE_OFF / WRONG_PHASE / BAD_TARGET / HAND_FULL.
   * @param {string} id the chessId / itemId (a golden elite is allowed too — that is the point of the sandbox)
   * @param {'chess'|'item'} [kind] default 'chess' (the pre-1.2 protocol had no kind field)
   */
  creativePick(id, kind = 'chess') {
    if (!(this.m.creative && this.m.creative.on)) return fail(ERR.CREATIVE_OFF);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (kind === 'item') {
      const rec = this.gd.item(id);
      if (!rec) return fail(ERR.BAD_TARGET, N_('没有这个道具'));
      const piece = this.acquireItem(id, { source: 'creative' });
      if (!piece) return fail(ERR.HAND_FULL); // acquireItem already toasted 整备区已满
      return OK;
    }
    const rec = this.gd.chess(id);
    if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET, N_('没有这个干员'));
    const owned = this.acquireChess(id, { source: 'creative' });
    if (!owned) return fail(ERR.HAND_FULL);
    return OK;
  }

  /**
   * g.creativeLayers { bondId, layers }: set a bond's CURRENT layer count directly (创造模式 must be on, PREP only).
   * The sandbox counterpart of addLayers — which only ever adds and stops at the cap; here the player jumps straight
   * to any value 0 … cap (本局 layerCapNow, default 999) so an effect's thresholds can be tested at will. No onLayers
   * dispatch: this is a debug write, not a gain, so nothing else should fire off it.
   * @param {string} bondId the bond (bonds.json id; any bond — layers persist the whole match and only matter while
   *   the bond is active, so setting an inactive one simply pre-loads it)
   * @param {number} layers the wanted count (clamped: 0 … this match's cap, floored)
   */
  creativeLayers(bondId, layers) {
    if (!(this.m.creative && this.m.creative.on)) return fail(ERR.CREATIVE_OFF);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!this.gd.bond(bondId)) return fail(ERR.BAD_TARGET, N_('没有这个盟约'));
    const cap = this.m.layerCapNow();
    const n = Math.min(cap, Math.max(0, Math.floor(Number(layers) || 0)));
    this.layers[bondId] = n;
    this.recompute();
    this.m.markPrivate(this); // push m.private / m.public: the bonds strip and the bond popup read layers from them
    return OK;
  }
}
