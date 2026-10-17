// 局内手动施放按钮的渲染回归（用户报告 2026-10-10：实战里技能图标不可点）：
// 根因是 ChessDetail 的 castable 门槛写成了 `typeof live === 'function'`，而 DetailPanel 传下来的是 getter 的
// 返回值（{ ...unitStatsEntry, src: 'battle' } 对象）——门槛永假，按钮从不渲染。本文件锁住三层：
//   * battle 实时卡（live.src === 'battle'）+ onCastSkill → 技能图标是 .dskill__cast 施放按钮；
//   * prep 卡（src: 'prep'）与未接 onCastSkill 的调用方 → 保持纯图标（不可点）；
//   * 接线在源头（game.js → DetailPanel → ChessDetail）不被回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// the browser data store reads the real data files from disk (the card renders below)
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const { ChessDetail } = await import('../../public/js/ui/detailPanel.js');
const { data } = await import('../../public/js/data.js');

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const hasCastButton = (blocks) => {
  const skill = blocks.find((b) => b.key === 'skill');
  return !!skill && [...walk(skill)].some((n) => hasClass(n, 'dskill__cast'));
};

const FIN = 'chess_char_1_01_a'; // 芬：有 manual 技能（S1），最便宜的渲染样本
const noop = () => {};

test('battle 卡（live.src=battle）+ onCastSkill → 技能图标是施放按钮', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const c = data.lookup('chess', FIN);
  const blocks = ChessDetail({ chess: c, piece: null, editable: false, bonds: [], loadout: null, live: { src: 'battle' }, onCastSkill: noop });
  assert.ok(hasCastButton(blocks), 'the skill icon is a cast button in battle');
});

test('prep 卡（src=prep）不渲染施放按钮', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const c = data.lookup('chess', FIN);
  const blocks = ChessDetail({ chess: c, piece: null, editable: false, bonds: [], loadout: null, live: { src: 'prep' }, onCastSkill: noop });
  assert.ok(!hasCastButton(blocks), 'prep: plain icon');
});

test('未接 onCastSkill 的调用方（观战 / 联防回放等）保持纯图标', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const c = data.lookup('chess', FIN);
  const blocks = ChessDetail({ chess: c, piece: null, editable: false, bonds: [], loadout: null, live: { src: 'battle' } });
  assert.ok(!hasCastButton(blocks), 'no handler: plain icon');
});

test('接线不被回退：game.js 传 onCastSkill，DetailPanel 透传给 ChessDetail', () => {
  const game = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
  assert.match(game, /onCastSkill=\$\{castSkill\}/);
  const src = readFileSync(path.join(ROOT, 'public/js/ui/detailPanel.js'), 'utf8');
  assert.match(src, /onCastSkill=\$\{onCastSkill\}/, 'DetailPanel passes it down');
  assert.match(src, /live\.src === 'battle'/, 'the gate keys on the battle live entry (the function form never reaches ChessDetail)');
});
