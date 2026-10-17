// Protocol fuzz: random VALID-SHAPED intents (they pass shared/protocol.js validateC2S) in random phases, random
// disconnects/reconnects/leaves and random time jumps never throw, always answer { ok } or { error: ERR.* }, never
// report an internal error and never corrupt the invariants (pool accounting, funds, slots, legality, merges).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S, C2S } from '../../shared/protocol.js';
import { ERR, EMOTES } from '../../shared/constants.js';
import { createRng } from '../../server/sim/rng.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';

const GAME = Object.keys(C2S).filter((t) => t.startsWith('g.') && t !== 'g.leave');
const BANDS = Object.keys(DATA.bands);
const CHESS_IDS = Object.keys(DATA.chess);
const BOND_IDS = Object.keys(DATA.bonds);

function randomIntent(rng, m, ps) {
  const t = rng.pick(GAME);
  const pieces = [];
  if (ps) {
    for (const p of [...ps.board.values(), ...ps.hand, ...ps.temp]) {
      if (!p) continue;
      pieces.push(p.uid);
      for (const it of p.items || []) pieces.push(it.uid);
    }
  }
  const uid = () => (pieces.length && rng() < 0.8 ? rng.pick(pieces) : 1 + rng.int(5000));
  const to = () => (rng() < 0.6 ? { area: 'board', row: rng() < 0.8 ? 9 + rng.int(4) : rng.int(19), col: rng() < 0.8 ? 2 + rng.int(9) : rng.int(21) } : { area: 'hand', idx: rng.int(10) });
  // teammate targeted MODs (gift / buyReq / peerShop): 70% a real player id, 30% garbage (still valid-shaped: ≤64 chars)
  const otherIds = [...m.players.keys()].filter((id) => id !== ps.playerId);
  const peer = () => (otherIds.length && rng() < 0.7 ? rng.pick(otherIds) : 'p_' + rng.int(9999));
  // valid-shaped emote payload for g.customEmote (isEmoteData: strict data:image prefix, base64 charset, ≤2.8 MB)
  const emoteData = () => `data:image/${rng.pick(['png', 'gif'])};base64,${'QUJD'.repeat(1 + rng.int(64))}${rng() < 0.2 ? '=' : ''}`;
  switch (t) {
    case 'g.band': return { t, bandId: rng() < 0.8 ? rng.pick(BANDS) : rng.pick(['constructor', '__proto__', 'band_x', 'a'.repeat(64)]) };
    case 'g.buy': return { t, slot: rng.int(16) };
    case 'g.sell': case 'g.destroy': return { t, uid: uid() };
    case 'g.move': return { t, uid: uid(), to: to() };
    case 'g.equip': return { t, itemUid: uid(), targetUid: uid() };
    case 'g.art': return { t, itemUid: uid(), row: rng.int(19), col: rng.int(21) };
    case 'g.reward': case 'g.choice': return { t, idx: rng.int(6) };
    case 'g.ready': return { t, ready: rng() < 0.4 };
    case 'g.emote': return { t, id: rng.pick(EMOTES) };
    case 'g.watch': return { t, fieldId: rng.pick(['n:p_0', 'n:p_1', 'n:ai_0', 'u', 'b1', 'b2', 'zz', '']) };
    case 'g.autoplay': return { t, on: rng() < 0.05 };
    case 'g.pause': return { t, on: rng() < 0.5 };
    // inter-player MODs (赠送 / 求购 / 观战队友 / 自定义表情) — handlers answer ERR / OK per PREP-only & CD rules;
    // fuzz only requires valid shapes, so a WRONG_PHASE / NOT_FOUND / RATE reply is exactly the coverage we want
    case 'g.customEmote': return { t, data: emoteData() };
    case 'g.gift': return { t, uid: uid(), to: peer() };
    case 'g.giftReply': return { t, accept: rng() < 0.5 };
    case 'g.buyReq': return { t, slot: rng.int(16), to: peer() };
    case 'g.buyReqReply': return { t, accept: rng() < 0.5 };
    case 'g.peerShop': return { t, to: peer() };
    case 'g.peerBuy': return { t, slot: rng.int(16), to: peer() };
    // 盲盒 MOD — set a valid mode and scout / smash; the fuzzer only needs valid shapes (WRONG_PHASE / OK / BAD_MSG all fine)
    // 不含 'jar'：jar 是无尽模式（无人被淘汰则对局永不结束）→ fuzz 的 h.drive 会死循环；jar 全链路由 blindbox-jarShop / -endless / -jarSell 专项覆盖
    case 'g.blindBoxSet': return { t, mode: rng.pick(['off', 'shop', 'enemy', 'all']) };
    case 'g.scoutWave': return { t, round: rng.int(20) };
    case 'g.smashJar': return { t, round: rng.int(20), jarId: 'jar:p_0:' + rng.int(20) + ':' + rng.int(6) };
    case 'g.jarEquip': return { t, itemUid: uid(), targetUid: uid() }; // 战斗中穿装：与 g.equip 同形，handler 按 jar 规则答 ERR / OK
    case 'g.jarSell': return { t, uid: uid() }; // 战斗中售卖干员：与 g.sell 同形，handler 按 jar 规则答 ERR / OK
    // jar 商店：三件商品 + 复活消耗上报（playerId 只能报自己的；handler 按 jar 规则答 ERR / OK / 去重后的 OK）
    case 'g.jarShopBuy': return { t, item: rng.pick(['slot', 'life', 'revive']) };
    case 'g.jarReviveUsed': return { t, battleId: 'fuzz:' + rng.int(999), playerId: ps.playerId, n: rng.int(3) };
    case 'g.jarDeployDevice': return { t, item: rng.pick(['obstacleBasic', 'obstacleAdvanced']), row: rng.int(19), col: rng.int(21) }; // 战斗中手动放障碍物：非 jar 模式回 BAD_MSG
    case 'g.jarDeployDeviceDone': return { t, item: rng.pick(['obstacleBasic', 'obstacleAdvanced']) }; // 客户端生成后上报扣库存：非 jar 模式回 BAD_MSG
    case 'g.jarLoadSave': return { t, data: { v: 1, name: 'fuzz', round: rng.int(20), funds: rng.int(999), lp: rng.int(9), shopLevel: 1, jarShop: {}, roster: [] } }; // 读档暂存：非 jar 模式回 BAD_MSG
    case 'g.jarStartAndLoad': return { t, data: { v: 1, name: 'fuzz', round: rng.int(20), funds: 0, lp: 1, shopLevel: 1, jarShop: {}, roster: [] } }; // 大厅一键读档：非 jar 模式回 BAD_MSG（不借道开无尽，fuzz 才安全）
    case 'g.jarObstacleLost': return { t, item: rng.pick(['obstacleBasic', 'obstacleAdvanced']), row: rng.int(19), col: rng.int(21) }; // 障碍物被摧毁上报：非 jar 模式回 BAD_MSG
    // 创造模式 MOD — a pick with an unknown id answers BAD_TARGET, a set off the toggle is legal in any phase but
    // LOBBY (fuzz starts matches, so OK / WRONG_PHASE replies are both fine coverage)
    case 'g.creativeSet': return { t, on: rng() < 0.6, ...(rng() < 0.6 ? { layerCap: 1 + rng.int(99999) } : {}) };
    case 'g.creativePick': return { t, id: rng.pick(['chess_fuzz_' + rng.int(999), 'a'.repeat(64), '']) };
    case 'g.creativeLayers': return { t, bondId: rng() < 0.8 ? rng.pick(BOND_IDS) : rng.pick(['bond_x', 'a'.repeat(64)]), layers: rng.int(100000) };
    // 技能自动 MOD — a boolean flip; any phase is legal so OK is the only reply the fuzzer cares about
    case 'g.setSkillAuto': return { t, on: rng() < 0.5 };
    default: return { t };
  }
}

function fuzzOne(seed, { fake }) {
  const rng = createRng(seed * 7919);
  const mode = rng() < 0.3 ? 'solo' : 'coop';
  const difficulty = rng.pick(['FUNNY', 'NORMAL', 'HARD', 'ABYSS']);
  const humans = mode === 'solo' ? 1 : 1 + rng.int(3);
  const bots = mode === 'solo' ? 0 : rng.int(3);
  const h = makeMatch({ mode, difficulty, humans, bots, seed, fake, captureFrames: false, checkFrames: true, script: () => ({ duration: 2 + rng.int(6), leaks: {} }) });
  const m = h.m;
  m.start();
  const humanIds = [...m.players.values()].filter((p) => !p.isBot).map((p) => p.playerId);
  let intents = 0;
  for (let step = 0; step < 2500 && h.ended == null; step++) {
    const r = rng();
    const pid = rng.pick(humanIds);
    const ps = m.players.get(pid);
    if (r < 0.82) {
      const msg = randomIntent(rng, m, ps);
      assert.equal(validateC2S(msg), null, `fuzz produced an invalid message ${JSON.stringify(msg)}`);
      const res = m.handle(pid, msg);
      intents++;
      assert.ok(res && (res.ok === true || (typeof res.error === 'string' && Object.hasOwn(ERR, res.error))), `bad reply ${JSON.stringify(res)} to ${JSON.stringify(msg)}`);
      assert.notEqual(res.error, ERR.INTERNAL, `internal error on ${JSON.stringify(msg)}`);
    } else if (r < 0.85) {
      m.onDisconnect(pid);
    } else if (r < 0.88) {
      m.onReconnect(pid);
    } else if (r < 0.882 && humanIds.filter((id) => !m.players.get(id).left).length > 1) {
      m.onLeave(pid);
    } else if (r < 0.96) {
      h.sched.advance(rng.int(3000));
    } else {
      for (let k = 0; k < 20; k++) if (!h.sched.runNext()) break;
    }
    if (step % 20 === 0) checkInvariants(m);
  }
  // finish the match: everyone left on AI 托管
  for (const ps of m.players.values()) if (!ps.isBot && !ps.left) m.handle(ps.playerId, { t: 'g.autoplay', on: true });
  h.drive(() => h.ended != null);
  assert.ok(h.ended, `seed ${seed}: match did not end (${m.phase} R${m.round})`);
  assert.equal(h.endedCount, 1);
  assert.equal(m.errorCount, 0, `seed ${seed}: ${JSON.stringify(m.errors.slice(0, 3))}`);
  assert.equal(m.dispatcher.errors, 0);
  assert.deepEqual(h.sched.errors, []);
  assert.deepEqual(h.badFrames, []);
  checkInvariants(m);
  m.dispose();
  return intents;
}

test('fuzz with FakeBattle: 60 matches of random intents / connection churn / time jumps', () => {
  let n = 0;
  for (let seed = 1; seed <= 60; seed++) n += fuzzOne(seed, { fake: true });
  assert.ok(n > 10000, `${n} intents`);
});

test('fuzz with the real simulation: 8 matches', () => {
  for (let seed = 101; seed <= 108; seed++) fuzzOne(seed, { fake: false });
});
