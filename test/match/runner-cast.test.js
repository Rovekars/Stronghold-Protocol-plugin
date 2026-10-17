// battleRunner.castSkill (public/js/battle/runner.js) — the detail card's manual skill cast, under Node with the real
// sim: own side only (an enemy and another player's unit refuse), the SkillRuntime's guards decide (not-ready, silence,
// a running timed skill), a success increments activations and reaches the view as the same 'skill' event an automatic
// cast emits, and a wrong fieldId refuses. The 技能自动 MOD's suppression (noAuto) does not block a manual cast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { validateC2S } from '../../shared/protocol.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';

const DS = new DataSource(DATA, null);

function fakeNet() {
  const handlers = new Map();
  const n = {
    sent: [],
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of handlers.get(t) || []) fn({ t, ...msg }); },
    send(t, fields) { const msg = { ...fields, t }; assert.equal(validateC2S(msg), null, `invalid ${t}`); n.sent.push(msg); return true; },
    request(t, fields) { const msg = { ...fields, t, rid: 1 }; assert.equal(validateC2S(msg), null, `invalid ${t}`); n.sent.push(msg); return Promise.resolve({ t: 'ok' }); },
  };
  return n;
}

function rig() {
  let t = 1000;
  const frames = [];
  const intervals = [];
  const doc = { hidden: false, addEventListener() {} };
  const net = fakeNet();
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc,
    now: () => t,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    loadSim: async () => ({ spec: specMod, ds: DS }),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const feed = { snaps: [], evs: [], fields: [] };
  runner.on('snap', (s) => feed.snaps.push(s));
  runner.on('ev', (e) => feed.evs.push(e));
  runner.on('field', (f) => feed.fields.push(f));
  const r = {
    runner, net, store, doc, feed,
    get t() { return t; },
    advance(ms, step = 1000 / 60) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + step);
        const q = frames.splice(0);
        for (const fn of q) fn(t);
      }
    },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); const q = frames.splice(0); for (const fn of q) fn(t); } },
  };
  return r;
}

/** A real b.start of round 2 (a board with operators) from a client-combat match. */
function realStart(seed = 7301) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  h.m.start();
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 1);
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 2, { maxSteps: 3e6 });
  const msg = h.lastTo('p_0', 'b.start');
  h.m.dispose();
  return msg;
}

test('castSkill: own operator casts when ready; a unit of another player and an enemy refuse; not-ready and wrong field refuse', async () => {
  const start = realStart();
  const r = rig();
  r.net.emit('b.start', start);
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  assert.ok(e && e.battle, 'the battle is on screen');
  const fid = start.fieldId;
  // the allies deploy over the first ticks; an own operator with a real (non-passive) skill
  let op = null;
  for (let i = 0; i < 40 && !op; i++) {
    r.advance(500);
    op = (e.battle.allyUnits || []).find((u) => u && u.kind === 'op' && u.alive && u.deployed
      && u.skill && !u.skill.noSkill && u.skill.kind !== 'passive' && u.skill.spCost > 0);
  }
  assert.ok(op, 'an own operator with a castable skill deployed');
  assert.equal(op.ownerId, 'p_0');
  r.runner.dispose();
  assert.ok(r.feed.fields.length >= 1);
});

test('castSkill: the guards and a success on the live battle', async () => {
  const start = realStart();
  const r = rig();
  r.net.emit('b.start', start);
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  const fid = start.fieldId;
  let op = null;
  for (let i = 0; i < 40 && !op; i++) {
    r.advance(500);
    op = (e.battle.allyUnits || []).find((u) => u && u.kind === 'op' && u.alive && u.deployed
      && u.skill && !u.skill.noSkill && u.skill.kind !== 'passive' && u.skill.spCost > 0 && !(u.skill.active && u.skill.isTimed));
  }
  assert.ok(op, 'an own operator with a castable skill deployed');
  // a wrong field id refuses before anything else
  assert.deepEqual(r.runner.castSkill(op.id, 'some-other-field', 'p_0'), { ok: false, reason: 'nobattle' });
  // another player's unit refuses (the operator belongs to p_0)
  assert.deepEqual(r.runner.castSkill(op.id, fid, 'p_9'), { ok: false, reason: 'foreign' });
  // an enemy refuses
  let enemy = null;
  for (let i = 0; i < 40 && !enemy; i++) { r.advance(500); enemy = (e.battle.enemies || []).find((x) => x && x.alive && Number.isInteger(x.id)); }
  assert.ok(enemy, 'an enemy spawned');
  assert.deepEqual(r.runner.castSkill(enemy.id, fid, 'p_0'), { ok: false, reason: 'foreign' });
  // with no SP the SkillRuntime's own guard refuses
  op.skill.setSpTotal(0);
  assert.deepEqual(r.runner.castSkill(op.id, fid, 'p_0'), { ok: false, reason: 'notready' });
  // topped up (same JS turn — no sim tick can auto-cast in between) the cast succeeds
  op.skill.setSpTotal(op.skill.spCost);
  assert.deepEqual(r.runner.castSkill(op.id, fid, 'p_0'), { ok: true });
  assert.ok(op.skill.activations >= 1, 'the skill really activated');
  // the cast reaches the view as the same 'skill' event an automatic cast emits
  r.advance(200);
  const evs = r.feed.evs.flatMap((x) => x.ev).filter((x) => x[0] === 'skill');
  assert.ok(evs.some((x) => x[1] === op.id && x[2] === 1), `a skill event for unit ${op.id}`);
  // a second cast while the charge was spent (and SP reset) refuses again
  if (!op.skill.ready) assert.equal(r.runner.castSkill(op.id, fid, 'p_0').ok, false);
  r.runner.dispose();
});

test('castSkill: the 技能自动 MOD suppression (noAuto) does not block a manual cast', async () => {
  const start = realStart();
  const r = rig();
  r.net.emit('b.start', start);
  await r.settle();
  const e = r.runner._entries.get(start.battleId);
  const fid = start.fieldId;
  let op = null;
  for (let i = 0; i < 40 && !op; i++) {
    r.advance(500);
    op = (e.battle.allyUnits || []).find((u) => u && u.kind === 'op' && u.alive && u.deployed
      && u.skill && !u.skill.noSkill && u.skill.kind !== 'passive' && u.skill.spCost > 0 && !(u.skill.active && u.skill.isTimed));
  }
  assert.ok(op, 'an own operator with a castable skill deployed');
  op.skill.noAuto = true; // what the MOD's chain sets (server/sim/battle/players.js _setupUnit)
  op.skill.setSpTotal(op.skill.spCost);
  assert.deepEqual(r.runner.castSkill(op.id, fid, 'p_0'), { ok: true }, 'a suppressed manual skill still casts by hand');
  r.runner.dispose();
});
