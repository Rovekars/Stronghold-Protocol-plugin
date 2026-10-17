// server/match/player/peershop.js — PlayerState methods: teammate shop spectating (MOD "观战队友").
//
// During PREP a player may look at a living teammate's shop (g.peerShop → an m.peerShop push with the slot snapshot:
// indices preserved, nulls kept so the client can address slots by index) and buy one of its unsold slots for
// themselves (g.peerBuy). The purchase runs on the BUYER: their funds, their hand (+ overflow temp), their merges and
// their onBuy / onSpend effects; the price is the owner's onPrice-adjusted price (it is the owner's shop being bought
// from), and the owner only loses the slot (marked sold). The shared chess pool makes the normal-copy pool identical
// for both players; a DIY slot sells only its owner's own 自选 stock (player/diy.js) → refused for a peer buy. Buying
// is stateless — nothing pending, no offer, so a round change or a departure needs no cleanup. Bots may be watched
// and bought from like any teammate (nothing needs their confirmation: they are selling, not spending).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container; `this` is the player state).

import { PHASE, ERR } from '../../../shared/constants.js';
import { msg, N_ } from '../../../shared/i18n.js';
import { OK, fail } from './common.js';
import { freeSlot } from '../board.js';

export class PlayerPeerShop {
  /** Watch a teammate's shop (PREP only): pushes m.peerShop { from, name, level, slots } back to the requester.
   * An eliminated player may still watch (they roam others' fields with 前往查看) — but never buy (peerBuy). */
  peerShop(toPlayerId) {
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const target = this.m.players.get(toPlayerId);
    if (!target || target === this || target.left || !target.alive) return fail(ERR.BAD_TARGET, N_('没有可观战的队友'));
    const slots = target.shop.slots.map((s) => (s ? { kind: s.kind, id: s.id, basePrice: s.basePrice, price: target.priceOf(s), sold: !!s.sold, frozen: !!s.frozen } : null));
    this.m.sendTo(this.playerId, { t: 'm.peerShop', from: toPlayerId, name: target.name, level: target.shop.level, slots });
    return OK;
  }

  /**
   * Buy one of a teammate's unsold shop slots into my own hand (PREP only). Mirrors buy()'s checks (slot → sold →
   * price → funds → pool → hand full) with `this` as the buyer; the slot is marked sold on the owner.
   */
  peerBuy(toPlayerId, slotIdx) {
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!this.alive) return fail(ERR.ELIMINATED);
    const target = this.m.players.get(toPlayerId);
    if (!target || target === this || target.left || !target.alive) return fail(ERR.BAD_TARGET, N_('没有可购买的目标'));
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= target.shop.slots.length) return fail(ERR.BAD_TARGET);
    const slot = target.shop.slots[slotIdx];
    if (!slot) return fail(ERR.BAD_TARGET);
    if (slot.sold) return fail(ERR.SOLD_OUT);
    const price = target.priceOf(slot);
    if (this.funds < price) return fail(ERR.NO_FUNDS);

    let piece;
    if (slot.kind === 'chess') {
      const rec = this.gd.chess(slot.id);
      // a DIY slot is the owner's own 自选 stock (player/diy.js) — never sold to a teammate
      if (!rec || rec.isDiy) return fail(ERR.BAD_TARGET, N_('自选干员不对外出售'));
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      const pool = this.poolOf(base);
      if (pool.has(base) && pool.left(base) < need) return fail(ERR.SOLD_OUT);
      if (freeSlot(this.hand) < 0) return fail(ERR.HAND_FULL, N_('你的整备区已满，无法购入'));
      this.spend(price);
      slot.sold = true;
      piece = this.acquireChess(slot.id, { source: 'peerBuy' });
    } else {
      if (!this.gd.item(slot.id)) return fail(ERR.BAD_TARGET);
      if (freeSlot(this.hand) < 0) return fail(ERR.HAND_FULL, N_('你的整备区已满，无法购入'));
      this.spend(price);
      slot.sold = true;
      piece = this.acquireItem(slot.id, { source: 'peerBuy' });
    }
    // acquire can still come up empty (a merge finding no room for the elite): undo the sale rather than take the money
    if (!piece) {
      slot.sold = false;
      this.addFunds(price, { reason: 'peerBuyRefund' });
      return fail(ERR.HAND_FULL, N_('整备区已满，无法放置，已退款'));
    }

    this.stats.buys++;
    this.round.buys++;
    this.m.dispatch(this, 'onBuy', { piece, slot, price, kind: slot.kind });
    this._afterSpend(price, 'buy');
    this.recompute();
    target.dirty();
    this.dirty();
    this.m.toast(target, 'info', msg('{name} 从你的商店买走了商品（￥{price}）', { name: this.name, price }));
    return OK;
  }
}
