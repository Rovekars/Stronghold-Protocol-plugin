// server/match/player/skilltoggle.js — PlayerState methods: the 技能自动 MOD's unified manual-skill auto-cast switch.
// A single player-wide flag (`noAutoSkill`) flips whether this player's MANUAL battle skills auto-cast. When on, the
// sim keeps every operator's skill (天赋 / 特性 / 模组 / 攻击范围 all untouched) but suppresses the automatic
// activation of manual skills (server/sim/skills.js guards the three auto-cast paths) — SP still charges, the skill
// stays ready to be triggered by hand, nothing fires on its own.
//
// Nothing here is a gain and nothing fires: it is a debug write of the MOD, applied to every battle this player fights
// this match (a flip during PREP takes effect at that round's combat; one flipped between rounds, at the next). The flag
// lives on the player state ⇒ per match, never persisted; the MOD re-sends it at every match start.
// Installed on PlayerState.prototype by server/match/PlayerState.js.

import { OK } from './common.js';

export class PlayerSkillToggle {
  /**
   * g.setSkillAuto { on }: flip whether this player's MANUAL battle skills auto-cast this match.
   * `on=true` suppresses the automatic activation; `on=false` restores vanilla behaviour. Any phase — a match's own
   * debug switch; bots never call it.
   * @param {boolean} on
   */
  setSkillAuto(on) {
    this.noAutoSkill = !!on;
    this.m.markPrivate(this); // the header button reads the applied flag back from m.private
    return OK;
  }
}
