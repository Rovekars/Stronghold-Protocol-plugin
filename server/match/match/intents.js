// server/match/match/intents.js — Match methods: the g.* / b.* intent router (_handle: the prep intents go to
// PlayerState, the drafts, watching, the pause and the battle reports to the match), emotes, AI 托管 (setAutoplay,
// kickBot) and g.unitStats (the stats the board's units start their next battle with: a preview battle, started, read
// and dropped).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { unitStatsEntry, isEmoteData } from '../../../shared/protocol.js';
import { PHASE, ERR, EMOTES, EMOTE_COOLDOWN_MS, GEO, BOND_LAYER_CAP, INFINITE_FUNDS } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { deriveSeed } from '../../sim/rng.js';
import { lookupIntent } from '../../mods.js';
import { OK, fail } from './common.js';

export class MatchIntents {
  _handle(ps, msg) {
    // 服务端 MOD 的自有 intent（server/mods.js 注册表；如 盲盒 MOD 的 g.blindBoxSet / g.smashJar）：
    // C2S schema 已由 MOD registerMessage 注入（validateC2S 放行），这里直接路由，查不到再走本体 switch。
    const modHandler = lookupIntent(msg.t);
    if (modHandler) return modHandler(this, ps, msg);
    switch (msg.t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
        if (!ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
        return OK;
      case 'g.band': return this.pickBand(ps, msg.bandId);
      case 'g.bandSkip': return this.skipBand(ps);
      // the strategy highlighted in the draft screen (what a timed-out turn takes, timeoutBand)
      case 'g.bandFocus': return this.bandFocus(ps, msg.bandId ?? null);
      case 'g.buy': return ps.buy(msg.slot);
      case 'g.refresh': return ps.refresh();
      case 'g.freeze': return ps.freeze();
      case 'g.levelUp': return ps.levelUp();
      case 'g.sell': return ps.sell(msg.uid);
      // dir: the deploy wheel's facing (DESIGN §3; absent ⇒ PlayerState reads to.dir, then RIGHT)
      case 'g.move': return ps.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return ps.equip(msg.itemUid, msg.targetUid, msg.replaceUid ?? null);
      case 'g.art': return ps.useArt(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return ps.destroy(msg.uid);
      case 'g.reward': return ps.pickReward(msg.idx);
      case 'g.choice': return this.pickCard(ps, msg.idx);
      case 'g.ready': return ps.setReady(!!msg.ready);
      case 'g.emote': return this.emote(ps, msg.id);
      // custom emote (MOD "自定义表情包"): relay a picture data URL to everyone, the same chatCD as g.emote
      case 'g.customEmote': return this.customEmote(ps, msg.data);
      // playerId: the player tapped (a shared field names two) — the watch preference (item 56)
      case 'g.watch': return this.watch(ps, msg.fieldId, msg.playerId ?? null);
      case 'g.autoplay': return this.setAutoplay(ps, !!msg.on);
      case 'g.pause': return this.setPause(ps, !!msg.on);
      // the stats the board's units start their next battle with (the detail card in prep, user playtest #4 item 7)
      case 'g.unitStats': return this.unitStats(ps, msg.seq ?? null);
      case 'g.leave': this.onLeave(ps.playerId); return OK;
      case 'g.gift': return ps.gift(msg.uid, msg.to);
      case 'g.giftReply': return ps.giftReply(!!msg.accept);
      case 'g.buyReq': return ps.buyReq(msg.slot, msg.to);
      case 'g.peerShop': return ps.peerShop(msg.to);
      case 'g.peerBuy': return ps.peerBuy(msg.to, msg.slot);
      case 'g.buyReqReply': return ps.buyReqReply(!!msg.accept);
      case 'g.creativeSet': return this.creativeSet(ps, !!msg.on, msg.layerCap, msg.infiniteFunds);
      case 'g.creativeGet': return this.creativeGet(ps);
      case 'g.creativePick': return ps.creativePick(msg.id, msg.kind === 'item' ? 'item' : 'chess');
      case 'g.creativeLayers': return ps.creativeLayers(msg.bondId, msg.layers);
      // skill toggle (MOD "技能开关"): the operators whose battle skill this player keeps switched off this match
      case 'g.setSkillAuto': return ps.setSkillAuto(msg.on);
      case 'b.progress': return this._onProgress(ps, msg);
      case 'b.result': return this._onResult(ps, msg);
      default: return fail(ERR.BAD_MSG);
    }
  }

  /**
   * The bond layer cap in force this match: the 创造模式 MOD's cap (g.creativeSet) while the sandbox is on, the
   * official BOND_LAYER_CAP (999) otherwise. Every layerGainRoom call site on the match / player side passes this on
   * (player/economy.js, match/settle.js, unite.js, bondsMeta.js, fields.js via the battle spec flags, invariants.js).
   */
  layerCapNow() {
    const c = this.creative && this.creative.on ? this.creative.layerCap : BOND_LAYER_CAP;
    return Number.isFinite(c) && c > 0 ? c : BOND_LAYER_CAP;
  }

  /** 创造模式 MOD: toggle the sandbox and (optionally) set the per-match bond layer cap. Any phase, any human; the
   *  new state is broadcast (m.creativeState) so every client's panel and the cap-aware clamps agree. Turning the
   *  mode off resets the cap to the official 999. */
  creativeSet(ps, on, layerCap, infiniteFunds) {
    if (this.phase === PHASE.LOBBY) return fail(ERR.WRONG_PHASE);
    const c = this.creative;
    c.on = !!on;
    if (c.on && Number.isFinite(layerCap) && layerCap > 0) c.layerCap = Math.min(99999, Math.floor(layerCap));
    else if (!c.on) c.layerCap = BOND_LAYER_CAP;
    // a cap that just shrank (the mode switched off, or a lower cap set) must not leave a bond above it: the
    // engine invariant reads every layer against the cap in force now (invariants.js), so clamp what is over
    const cap = this.layerCapNow();
    for (const p of this.players.values()) {
      let changed = false;
      for (const [b, v] of Object.entries(p.layers || {})) {
        if (Number.isFinite(v) && v > cap) { p.layers[b] = cap; changed = true; }
      }
      if (changed) { p.recompute(); this.markPrivate(p); }
    }
    // 无限资金（match-wide, like `on`): only set when the client sends the flag; applyCap sends no flag so it is kept.
    if (infiniteFunds !== undefined) c.infiniteFunds = !!infiniteFunds;
    // 开启时把所有玩家的展示资金顶到 INFINITE_FUNDS，使界面价格不再灰显 / 购买按钮不再禁用（economy.js 不再扣减）
    if (c.infiniteFunds) {
      for (const p of this.players.values()) {
        if (p.funds < INFINITE_FUNDS) { p.funds = INFINITE_FUNDS; this.markPrivate(p); }
      }
    }
    this.broadcast({ t: 'm.creativeState', on: c.on, layerCap: c.layerCap, infiniteFunds: c.infiniteFunds });
    this.toast(ps, 'info', c.on
      ? msg('创造模式已开启（盟约叠层上限 {cap}）', { cap: c.layerCap })
      : msg('创造模式已关闭'));
    return OK;
  }

  /** 创造模式 MOD: the current sandbox state, unicast to the asking client (page reload / late join). */
  creativeGet(ps) {
    this.sendTo(ps.playerId, { t: 'm.creativeState', on: this.creative.on, layerCap: this.creative.layerCap, infiniteFunds: this.creative.infiniteFunds });
    return OK;
  }

  emote(ps, id) {
    if (!EMOTES.includes(id)) return fail(ERR.BAD_MSG, 'unknown emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.emote', playerId: ps.playerId, id });
    return OK;
  }

  // MOD "自定义表情包": a picture data URL relayed to everyone (validateC2S already checked the shape; the guard here
  // keeps a direct m.handle call from bypassing it). Shares lastEmoteAt with g.emote — one emote per chatCD, whatever kind.
  customEmote(ps, data) {
    if (!isEmoteData(data)) return fail(ERR.BAD_MSG, 'bad custom emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.customEmote', playerId: ps.playerId, data });
    return OK;
  }

  setAutoplay(ps, on) {
    if (ps.autoplay === on) return OK;
    ps.autoplay = on;
    this.markPublic();
    if (on) this.kickBot(ps);
    return OK;
  }

  /** Let the bot act for a (newly) bot-controlled seat in the current phase. */
  kickBot(ps) {
    if (!ps.botControlled || this.ended) return;
    if (this.phase === PHASE.INFO_CHECK && !ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
    else if (this.phase === PHASE.BAND_DRAFT && this.draftTurn() === ps.playerId) this.scheduleBandBot();
    else if (this.phase === PHASE.SP_DRAFT && this.spTurn() === ps.playerId) this.scheduleSpBot();
    else if (this.phase === PHASE.PREP && ps.alive && !ps.ready) this.scheduleBotPrep(ps, 0);
  }

  /**
   * g.unitStats { seq? } (user playtest #4 item 7: the detail card showed fixed record stats): the stats every unit of
   * the player's board will fight with at the start of its next battle — equipment, bonds and their layers, 特质, the
   * band and 机变 effects — computed exactly by the shared sim. The player's battle input after the onBattleStart meta
   * handlers (`ev.preview: true`, no enemies — those handlers must not change the match for a preview) builds a Battle
   * of the battle's options that is started (initial deployment + battleStart hooks), read and dropped: it is never
   * stepped, so skills and timed effects do not show. Pushed to the player as `m.unitStats { seq, round, units }`
   * (units: shared/protocol.js unitStatsEntry, board operators and summons by uid); cached per input (a build costs
   * ≈ 0.3–0.7 ms). Prep phases only (ROUND_START, 机变, PREP); a battle's live stats come from the browser's own sim.
   * @param {PlayerState} ps @param {number|null} seq echoed (the client keeps the newest answer)
   */
  unitStats(ps, seq = null) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.ROUND_START && this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const units = this._unitStatsOf(ps);
    this.sendTo(ps.playerId, { t: 'm.unitStats', seq: Number.isInteger(seq) ? seq : null, round: this.round, units });
    return OK;
  }

  /** The start-of-battle stats of a player's board units (see unitStats); [] when the preview battle cannot be built. */
  _unitStatsOf(ps) {
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    const ev = { input, kind: 'normal', round: this.round, preview: true };
    this.dispatch(ps, 'onBattleStart', ev);
    const players = [ev.input && typeof ev.input === 'object' ? ev.input : input];
    let key = null;
    try { key = JSON.stringify([this.round, this.stageId, this.battleContent, players]); } catch { key = null; }
    if (!this._unitStatsCache) this._unitStatsCache = new WeakMap(); // PlayerState → { key, units } (the last preview)
    const cached = this._unitStatsCache.get(ps);
    if (key && cached && cached.key === key) return cached.units;
    const units = [];
    // the flags of the battle it previews: a normal round gains IN_BATTLE layers from its start (a <战斗开始时> layer gain
    // raises bond stats at t = 0 there too); the Final Assault / Hidden Core fight without (previewed as a normal field)
    const bossRound = this.round === this.gd.bossRound || this.round === this.gd.hiddenRound;
    const b = this.newBattle({
      seed: deriveSeed(this.seed, `preview:${this.round}:${ps.seat}`), kind: 'normal', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players, spawns: [], routes: this.wave ? this.wave.routes : [],
      sharedBoss: null, flags: { layerGainsEnabled: !bossRound, ...this.gd.dp }, fieldId: `n:${ps.playerId}`, recordEvents: false,
    });
    try {
      if (typeof b.start === 'function') b.start();
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        if (u && Number.isInteger(u.uid) && (u.kind === 'op' || u.kind === 'token')) units.push(unitStatsEntry(u, u.s));
      }
    } catch (e) { this.reportError('unitStats', e); }
    this._unitStatsCache.set(ps, { key, units });
    return units;
  }
}
