// 盲盒·砸罐子（jar）：战斗中的合成（merge）吃掉场上 / 已撤离的棋子时，
//   ① 装备（素材）不能凭空消失——要么随精英走，要么回整备区（手牌满也不能销毁）；
//   ② 战斗里不该留下「棋子已经不在阵容里」的幽灵单位（否则点它只弹详情窗 / 什么都没有）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor, DATA } from './harness.js';
import { GEO } from '../../shared/constants.js';

await new Promise((r) => setImmediate(r));

const jar = (h) => {
  assert.deepEqual(h.m.handle('p_0', { t: 'g.blindBoxSet', mode: 'jar' }), { ok: true });
  return h.m;
};
const anyItem = () => Object.values(DATA.items).find((x) => x && x.visible !== false && !x.isGolden)?.id ?? null;

const deploy = (m, ps, chessId, skip = new Set()) => {
  const piece = give(m, ps, chessId, 'hand');
  const at = legalTileFor(m, ps, chessId, skip);
  assert.ok(at);
  skip.add(`${at[0]},${at[1]}`);
  const r = m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: at[0], col: at[1] }, dir: 'LEFT' });
  assert.deepEqual(r, { ok: true }, JSON.stringify(r));
  return { piece, at };
};

test('jar 战斗中合成：吃掉场上棋子时装备（素材）不凭空消失', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 41 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  // 找一种 mergeCount=2 的干员（两份即合成）
  const base = chessOfTier(1).find((id) => m.gd.mergeCount(id) === 3 && m.gd.goldenIdOf(id));
  assert.ok(base, '应存在三份合成的干员');
  const skip = new Set();
  const a = deploy(m, ps, base, skip);
  // 给场上这个干员穿一件装备
  const itemId = anyItem();
  const it = giveItem(m, ps, itemId, 'hand');
  assert.deepEqual(m.handle('p_0', { t: 'g.jarEquip', itemUid: it.uid, targetUid: a.piece.uid }), { ok: true });
  assert.equal((a.piece.items || []).length, 1, '干员身上有 1 件装备');
  // 第二份 → 立即合成
  ps.acquireChess(base); // 第二份
  const b = ps.acquireChess(base); // 第三份 → 立即合成
  const merged = ps.find(b.uid) === null || ps.find(a.piece.uid) === null;
  const elite = [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]
    .find((p) => p && p.kind === 'chess' && m.gd.isGolden(p.id));
  assert.ok(merged || elite, '两份同干员应立即合成（原棋子被消耗）');
  assert.ok(elite, '应出现精英');
  const allItemIds = () => {
    const out = [];
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) {
      if (p && p.kind === 'item') out.push(p.id);
      for (const i of p && p.items ? p.items : []) out.push(i.id);
    }
    return out;
  };
  assert.ok(allItemIds().includes(itemId), `装备不能凭空消失（现存：${JSON.stringify(allItemIds())}）`);
  h.invariants();
});

test('jar 战斗中合成：战斗里不留幽灵单位（被吃掉的棋子 uid 不再出现在战斗单位里）', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 43 }).start();
  const m = jar(h);
  h.toPrep(1);
  h.runToPhase('COMBAT');
  const ps = h.ps('p_0');
  const base = chessOfTier(1).find((id) => m.gd.mergeCount(id) === 3 && m.gd.goldenIdOf(id));
  assert.ok(base);
  const skip = new Set();
  const a = deploy(m, ps, base, skip);
  ps.acquireChess(base);
  ps.acquireChess(base); // 第三份 → 合成，吃掉场上的 a
  const f = (m.fields || []).find((x) => x && x.battle && Array.isArray(x.players) && x.players.includes('p_0') && !x.done);
  assert.ok(f, '应有战斗');
  const ghost = f.battle.allyUnits.filter((u) => u && u.uid === a.piece.uid && !u.removed);
  assert.equal(ghost.length, 0, `被合成吃掉的棋子不应再是战斗里的存活单位（仍有 ${ghost.length} 个）`);
  h.invariants();
});
