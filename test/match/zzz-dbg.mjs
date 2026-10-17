import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor, chessOfTier } from './harness.js';

test('dbg2', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 5 }).start();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  h.toPrep(1);
  const ps = h.ps('p_0');
  const cA = chessOfTier(1)[0];
  const cB = chessOfTier(1).find((c) => c !== cA);
  const tA = legalTileFor(m, ps, cA);
  const pieceA = give(m, ps, cA, 'board', tA);
  const pieceB = give(m, ps, cB, 'hand');
  h.run(() => m.phase === 'COMBAT', { maxSteps: 200000 });
  const f = m.fields.find((x) => x.live && x.players.includes('p_0'));
  h.run(() => f.battle.time > 0.5, { maxSteps: 100000 });
  const aUnit = f.battle.allyUnits.find((u) => u.uid === pieceA.uid && u.kind === 'op');
  ps.coords = 'field';
  const iR = aUnit.tileR, iC = aUnit.tileC;
  aUnit.alive = false; aUnit.removeReason = 'killed'; aUnit.removed = false; aUnit.deploySeq = 1; aUnit.respawnAt = f.battle.time + 100; aUnit.body = [iR, iC];
  console.log('iR,iC=', iR, iC, 'body=', aUnit.body, 'isDown=', f.battle.isDown(aUnit));
  console.log('downOn(iR,iC)=', !!f.battle.downOn(iR, iC));
  console.log('downOn result unit body=', f.battle.downOn(iR, iC) && f.battle.downOn(iR, iC).body);
  // direct _deploy test
  const u2 = f.battle._createAllyFromInput(ps, { uid: 99999, kind: 'chess', chessId: cB, row: iR, col: iC, dir: 'RIGHT', items: [] });
  console.log('_createAllyFromInput homeR/C=', u2 && u2.homeR, u2 && u2.homeC);
  const depOk = f.battle._deploy(u2, { initial: false });
  console.log('_deploy returned', depOk, 'u2.removed=', u2 && u2.removed, 'u2.alive=', u2 && u2.alive);
});
