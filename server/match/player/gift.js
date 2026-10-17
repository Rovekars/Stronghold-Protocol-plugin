// server/match/player/gift.js — PlayerState methods: inter-player gifting (MOD "赠送道具/干员").
//
// A player may, once per round (PREP only), offer one of their hand / temp pieces (a chess operator or an item) to a
// teammate — human or AI. A human teammate accepts or rejects; an AI teammate accepts immediately (no client to ask).
// On accept the piece moves from the sender to the recipient (hand, overflow temp), with a full-hand check on the
// recipient. The piece is NOT detached until a human recipient accepts — the offer only stores a reference (uid + a
// snapshot for the push) — so a round change or a departure never strands a detached piece;
// a stale offer (round advanced) is dropped on reply, and eliminate() clears any offer involving the leaving player.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { PHASE, ERR } from '../../../shared/constants.js';
import { N_ } from '../../../shared/i18n.js';
import { OK, fail } from './common.js';
import { freeSlot } from '../board.js';

export class PlayerGift {
  /** Offer one of my hand/temp pieces (chess or item) to a teammate. Once per round, PREP only. */
  gift(uid, toPlayerId) {
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (!Number.isInteger(uid)) return fail(ERR.BAD_MSG);
    if (typeof toPlayerId !== 'string' || !toPlayerId) return fail(ERR.BAD_TARGET);
    if (toPlayerId === this.playerId) return fail(ERR.BAD_TARGET, N_('不能赠送给自己'));
    if (this.round.gifts >= 1) return fail(ERR.ALREADY, N_('本回合已赠送过'));

    const target = this.m.players.get(toPlayerId);
    if (!target || target.left || !target.alive) return fail(ERR.BAD_TARGET, N_('没有可接收的队友'));
    // a human target handles one incoming offer at a time; the new sender keeps their once-per-round for later
    if (!target.isBot && this.m._giftOffers && this.m._giftOffers.has(toPlayerId)) return fail(ERR.ALREADY, N_('对方正在处理其他赠送'));

    const loc = this.find(uid);
    if (!loc || (loc.area !== 'hand' && loc.area !== 'temp')) return fail(ERR.BAD_TARGET, N_('该棋子不在手牌区'));
    const piece = loc.piece;
    if (piece.kind !== 'chess' && piece.kind !== 'item') return fail(ERR.BAD_TARGET, N_('只能赠送干员或道具'));
    if (freeSlot(target.hand) < 0) return fail(ERR.HAND_FULL, N_('对方整备区已满'));

    const rec = piece.kind === 'item' ? this.gd.item(piece.id) : this.gd.chess(piece.id);
    const name = rec && rec.name ? rec.name : piece.id;

    // AI teammates have no client to reply on: they accept immediately — the transfer happens right here.
    if (target.isBot) {
      this._detach(loc);
      const where = target.receiveChess(piece);
      if (!where) { this.stow(piece, { allowTemp: true }); return fail(ERR.HAND_FULL, N_('对方整备区已满，无法接收')); }
      if (piece.kind === 'item') target.checkItemMerges();
      this.round.gifts += 1;
      this.dirty();
      this.recompute();
      target.recompute();
      this.m.broadcast({ t: 'm.giftResolved', uid, from: this.playerId, to: toPlayerId, accepted: true, name });
      return OK;
    }

    if (!this.m._giftOffers) this.m._giftOffers = new Map();
    this.m._giftOffers.set(toPlayerId, {
      from: this.playerId, fromName: this.name, to: toPlayerId,
      uid, kind: piece.kind, id: piece.id, name, round: this.m.round,
    });

    this.round.gifts += 1;
    this.dirty();

    this.m.sendTo(toPlayerId, { t: 'm.giftOffer', from: this.playerId, fromName: this.name, uid, kind: piece.kind, id: piece.id, name });
    return OK;
  }

  /** Reply to an incoming gift offer (invoked on the TARGET; `this` is the target's PlayerState). */
  giftReply(accept) {
    if (!this.m._giftOffers || !this.m._giftOffers.has(this.playerId)) return fail(ERR.ALREADY, N_('没有待接收的赠送'));
    const offer = this.m._giftOffers.get(this.playerId);
    // a round advanced since the offer → it is stale, drop it
    if (offer.round !== this.m.round) { this.m._giftOffers.delete(this.playerId); return fail(ERR.ALREADY, N_('赠送已过期')); }

    const resolve = (accepted) => {
      this.m._giftOffers.delete(this.playerId);
      this.m.broadcast({ t: 'm.giftResolved', uid: offer.uid, from: offer.from, to: this.playerId, accepted, name: offer.name });
    };

    if (!accept) { resolve(false); return OK; }

    const sender = this.m.players.get(offer.from);
    if (!sender || !sender.alive) { resolve(false); return fail(ERR.BAD_TARGET, N_('赠送者已离开')); }
    const sloc = sender.find(offer.uid);
    if (!sloc || (sloc.area !== 'hand' && sloc.area !== 'temp')) { resolve(false); return fail(ERR.BAD_TARGET, N_('该棋子已不在对方手牌区')); }
    if (freeSlot(this.hand) < 0) { resolve(false); return fail(ERR.HAND_FULL, N_('整备区已满，无法接收')); }

    const piece = sloc.piece;
    sender._detach(sloc);
    const where = this.receiveChess(piece);
    if (!where) {
      // no room after all (a grant filled the hand between the check and the stow): give it back to the sender
      sender.receiveChess(piece);
      resolve(false);
      return fail(ERR.HAND_FULL, N_('整备区已满，无法接收'));
    }
    if (piece.kind === 'item') this.checkItemMerges();
    sender.recompute();
    this.recompute();
    if (typeof this.m.dispatch === 'function') this.m.dispatch(this, 'onGain', { piece, kind: piece.kind, source: 'gift' });
    resolve(true);
    return OK;
  }
}
