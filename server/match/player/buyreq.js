// server/match/player/buyreq.js — PlayerState methods: teammate proxy purchase (MOD "求购").
//
// A player short on funds may, during PREP, ask a teammate to pay for one of THEIR OWN unsold shop slots. The purchase
// itself always runs on the requester (this.buy with `payer` — economy.js): the piece is acquired into the requester's
// hand through the requester's pool / merges / onBuy effects, while the teammate only covers the price. A human
// teammate accepts or rejects via an offer push; an AI teammate pays immediately when it can afford the price. Only one
// pending request per target at a time, and a requester has at most one out. The offer stores a snapshot
// (slot index + kind + id), NOT the piece: on accept the slot is re-checked (a refresh replaces the cards → the offer
// is cancelled), and a stale offer (round advanced) is dropped. eliminate() clears any request involving the leaving
// player (nothing was ever detached, so nothing is stranded).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container; `this` is the player state).

import { PHASE, ERR } from '../../../shared/constants.js';
import { N_ } from '../../../shared/i18n.js';
import { OK, fail } from './common.js';
import { freeSlot } from '../board.js';

export class PlayerBuyReq {
  /** Ask a teammate to pay for one of my unsold shop slots (PREP only). */
  buyReq(slotIdx, toPlayerId) {
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= this.shop.slots.length) return fail(ERR.BAD_TARGET);
    if (typeof toPlayerId !== 'string' || !toPlayerId) return fail(ERR.BAD_TARGET);
    if (toPlayerId === this.playerId) return fail(ERR.BAD_TARGET, N_('不能请自己代购'));
    if (this.m._buyReqs) {
      for (const o of this.m._buyReqs.values()) if (o.from === this.playerId) return fail(ERR.ALREADY, N_('已有待处理的代购请求'));
      if (this.m._buyReqs.has(toPlayerId)) return fail(ERR.ALREADY, N_('对方正在处理其他代购请求'));
    }

    const target = this.m.players.get(toPlayerId);
    if (!target || target.left || !target.alive) return fail(ERR.BAD_TARGET, N_('没有可求助的队友'));

    const slot = this.shop.slots[slotIdx];
    if (!slot) return fail(ERR.BAD_TARGET);
    if (slot.sold) return fail(ERR.SOLD_OUT);
    let rec;
    if (slot.kind === 'chess') {
      rec = this.gd.chess(slot.id);
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      const base = this.gd.baseIdOf(slot.id);
      const need = rec.isGolden ? this.gd.goldenCopies : 1;
      const pool = this.poolOf(base);
      if (pool.has(base) && pool.left(base) < need) return fail(ERR.SOLD_OUT);
    } else {
      rec = this.gd.item(slot.id);
      if (!rec) return fail(ERR.BAD_TARGET);
    }
    // mirrored from buy() so an offer never promises a purchase the engine would refuse anyway
    if (freeSlot(this.hand) < 0) return fail(ERR.HAND_FULL, N_('你的整备区已满，无法购入'));
    const price = this.priceOf(slot);
    const name = rec && rec.name ? rec.name : slot.id;

    // AI teammates have no client to reply on: they pay immediately when they can afford it.
    if (target.isBot) {
      if (!this.m.creative?.infiniteFunds && target.funds < price) return fail(ERR.NO_FUNDS, N_('队友资金不足，无法代购'));
      const r = this.buy(slotIdx, { payer: target });
      if (!r || r.ok !== true) return r || fail(ERR.BAD_TARGET);
      this.m.broadcast({ t: 'm.buyReqResolved', from: this.playerId, to: toPlayerId, accepted: true, name, price });
      return OK;
    }

    if (!this.m._buyReqs) this.m._buyReqs = new Map();
    this.m._buyReqs.set(toPlayerId, {
      from: this.playerId, fromName: this.name, to: toPlayerId,
      slot: slotIdx, kind: slot.kind, id: slot.id, name, price, round: this.m.round,
    });
    this.dirty();

    this.m.sendTo(toPlayerId, { t: 'm.buyReqOffer', from: this.playerId, fromName: this.name, kind: slot.kind, id: slot.id, name, price });
    return OK;
  }

  /** Reply to an incoming proxy-purchase request (invoked on the PAYER; `this` is the payer's PlayerState). */
  buyReqReply(accept) {
    if (!this.m._buyReqs || !this.m._buyReqs.has(this.playerId)) return fail(ERR.ALREADY, N_('没有待处理的代购请求'));
    const offer = this.m._buyReqs.get(this.playerId);
    // a round advanced since the request → it is stale, drop it
    if (offer.round !== this.m.round) { this.m._buyReqs.delete(this.playerId); return fail(ERR.ALREADY, N_('代购请求已过期')); }

    const resolve = (accepted) => {
      this.m._buyReqs.delete(this.playerId);
      this.m.broadcast({ t: 'm.buyReqResolved', from: offer.from, to: this.playerId, accepted, name: offer.name, price: offer.price });
    };

    if (!accept) { resolve(false); return OK; }

    const sender = this.m.players.get(offer.from);
    if (!sender || !sender.alive) { resolve(false); return fail(ERR.BAD_TARGET, N_('请求者已离开')); }
    if (this.m.phase !== PHASE.PREP) { resolve(false); return fail(ERR.WRONG_PHASE, N_('已不在休整期')); }
    // the slot must still hold the very card that was offered (a refresh / purchase replaced the shop's contents)
    const slot = sender.shop.slots[offer.slot];
    if (!slot || slot.sold || slot.kind !== offer.kind || slot.id !== offer.id) { resolve(false); return fail(ERR.BAD_TARGET, N_('商品已更换，代购取消')); }
    if (!this.m.creative?.infiniteFunds && this.funds < sender.priceOf(slot)) { resolve(false); return fail(ERR.NO_FUNDS, N_('你的资金不足，无法代购')); }

    const r = sender.buy(offer.slot, { payer: this });
    if (!r || r.ok !== true) { resolve(false); return r || fail(ERR.BAD_TARGET); }
    resolve(true);
    return OK;
  }
}
