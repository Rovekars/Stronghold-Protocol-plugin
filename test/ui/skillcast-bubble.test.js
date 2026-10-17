// 局内快捷施放菱形的回归（用户反馈 2026-10-10 第二轮：实战点击干员要出现虚线菱形，方形技能图标坐在菱形的右角，
// 像官方的撤退/出售按钮）： 
//   * castableSkillOf：从 resolveDetail 的棋子条目解析出可施放技能（loadout 默认技能；被动/无技能 → null，
//     屏幕保持旧路径开详情卡）；
//   * SkillQuickCast：锚在干员落点（anchor = 字段 pieceClick 带来的地面点 + 每格像素）画虚线菱形，方形施放按钮
//     坐在菱形右角、技能名在图标下方；无 anchor 时退回点击点；skill 缺失 → 不渲染；
//   * 接线不被回退：game.js 战斗中点己方干员 setQuickCast（透传 anchor）、渲染 SkillQuickCast、castSkillUnit 复用，
//     字段（app.js / fallbackField.js）带 anchor。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// the browser data store reads the real data files from disk (the resolution below)
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const { castableSkillOf, SkillQuickCast } = await import('../../public/js/ui/detailPanel.js');
const { data } = await import('../../public/js/data.js');

function* walk(v) {
  if (Array.isArray(v)) { for (const x of yieldAll(v)) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
function* yieldAll(arr) { for (const x of arr) yield x; }
const hasClass = (v, c) => (typeof v?.props?.class === 'string' || typeof v?.props?.className === 'string')
  && String(v.props.class || v.props.className).split(/\s+/).includes(c);

const FIN = 'chess_char_1_01_a'; // 芬：有 manual 技能（S1），最便宜的解析样本
const noop = () => {};

test('castableSkillOf：从棋子条目解析出可施放技能（名称 / 图标 / 槽位）', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  const c = data.lookup('chess', FIN);
  assert.ok(c, 'sample chess record exists');
  const q = castableSkillOf({ type: 'chess', chess: c, standIn: null, diy: null }, null);
  assert.ok(q, 'returns the skill');
  assert.equal(typeof q.sk.name, 'string');
  assert.notEqual(q.sk.skillType, 'PASSIVE');
  assert.equal(typeof q.skIcon, 'string');
  assert.match(q.skIcon, /^data:|^\.?\/|^\//);
});

test('castableSkillOf：被动 / 无技能 / 非棋子条目 → null（保持详情卡路径）', async () => {
  await data.loadAll('chess', 'garrisons', 'assets', 'bonds', 'items');
  assert.equal(castableSkillOf(null), null);
  assert.equal(castableSkillOf({ type: 'token', token: {} }), null);
  const passive = castableSkillOf({ type: 'chess', chess: { name: 'X', skill: { name: 'P', skillType: 'PASSIVE' } }, standIn: null, diy: null }, null);
  assert.equal(passive, null, 'a passive-only record shows nothing to cast');
  const none = castableSkillOf({ type: 'chess', chess: { name: 'Y' }, standIn: null, diy: null }, null);
  assert.equal(none, null, 'no skill at all');
});

test('SkillQuickCast：锚在干员落点画虚线菱形，方形按钮坐在右角，技能名在下方', () => {
  const skill = { sk: { name: '箭矢·暴风', skillType: 'MANUAL' }, skIcon: '/a.png', skSlot: 'S3' };
  // tile 64 → R = 67.84 → side = round(95.94) = 96；框 = 落点 ± 48
  const v = SkillQuickCast({ skill, x: 0, y: 0, anchor: { cx: 300, cy: 400, tile: 64 }, onCast: noop });
  assert.ok(v, 'renders');
  const nodes = [...walk(v)];
  const frame = nodes.find((n) => hasClass(n, 'qcast'));
  assert.ok(frame, 'the diamond frame');
  assert.match(frame.props.style, /left:\s*252px/, 'the diamond box is centred on the unit');
  assert.match(frame.props.style, /top:\s*352px/);
  assert.match(frame.props.style, /width:\s*96px/);
  assert.match(frame.props.style, /height:\s*96px/);
  assert.ok(nodes.some((n) => hasClass(n, 'qcast__diamond')), 'the dashed diamond itself');
  const btn = nodes.find((n) => hasClass(n, 'qskill__cast'));
  assert.ok(btn, 'the square cast button');
  assert.ok(Number.isFinite(parseInt(String(btn.props.style).match(/left:\s*(\d+)px/, '')?.[1] ?? NaN, 10) + 48), 'the button is placed inline on the right corner');
  assert.ok(nodes.some((n) => hasClass(n, 'qskill__name')), 'the skill name label');
});

test('SkillQuickCast：无 anchor 退回点击点；skill 缺失不渲染', () => {
  const skill = { sk: { name: 'S', skillType: 'MANUAL' }, skIcon: '/a.png', skSlot: null };
  // tile 缺省 56 → R = 59.36 → side = 84；框 = 点击点 ± 42
  const v = SkillQuickCast({ skill, x: 100, y: 50, anchor: null, onCast: noop });
  const frame = [...walk(v)].find((n) => hasClass(n, 'qcast'));
  assert.match(frame.props.style, /left:\s*58px/, 'falls back to the tap point');
  assert.match(frame.props.style, /top:\s*8px/);
  assert.equal(SkillQuickCast({ skill: null, x: 0, y: 0, onCast: noop }), null);
});

test('SkillQuickCast：图标贴近视口右缘时收进来', () => {
  const skill = { sk: { name: 'S', skillType: 'MANUAL' }, skIcon: '/a.png', skSlot: null };
  const v = SkillQuickCast({ skill, x: 0, y: 0, anchor: { cx: 1260, cy: 400, tile: 64 }, onCast: noop });
  const btn = [...walk(v)].find((n) => hasClass(n, 'qskill__cast'));
  const left = parseInt(String(btn.props.style).match(/left:\s*(-?\d+)px/)[1], 10);
  assert.ok(left <= 1280, 'the icon is clamped into the viewport');
});

test('样式：菱形虚线存在，图标是方形（不再是 50% 圆角）', () => {
  const css = readFileSync(path.join(ROOT, 'public/css/screens/game-panels.css'), 'utf8');
  assert.match(css, /\.qcast__diamond[^}]*dashed/, 'the dashed diamond rule');
  assert.doesNotMatch(css, /\.qskill__icon[^}]*border-radius:\s*50%/, 'the icon is square now');
  assert.match(css, /\.qskill__icon[^}]*border-radius:\s*\.06rem/, 'slightly rounded square corners');
});

test('接线不被回退：game.js 战斗中点己方干员走 setQuickCast（透传 anchor）并渲染 SkillQuickCast', () => {
  const game = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
  assert.match(game, /SkillQuickCast,\s*castableSkillOf/, 'imports both from detailPanel');
  assert.match(game, /e\.unit\?\.side !== 'enemy'/, 'only own-side units');
  assert.match(game, /isCombatPhase\(L\.pub\?\.phase\)/, 'battle only');
  assert.match(game, /setQuickCast\(\{ unitId: e\.unitId/, 'a tap sets the bubble');
  assert.match(game, /anchor: e\.anchor \|\| null/, 'the unit anchor is passed through the state');
  assert.match(game, /anchor=\$\{quickCast\.anchor\}/, 'the diamond gets the anchor');
  assert.match(game, /<\$\{SkillQuickCast\}/, 'the bubble renders');
  assert.match(game, /onCast=\$\{\(\) => castSkillUnit\(quickCast\.unitId\)\}/, 'the cast goes through the shared runner call');
  assert.match(game, /own\.piece\.kind !== 'item'/, 'own chess pieces only (tokens / strangers keep the detail card)');
  const app = readFileSync(path.join(ROOT, 'public/js/render/app.js'), 'utf8');
  assert.match(app, /payload\.anchor = \{ cx: cr\.left \+ sc\.x/, 'the field reports the unit ground point + px per tile');
  const fallback = readFileSync(path.join(ROOT, 'public/js/ui/fallbackField.js'), 'utf8');
  assert.match(fallback, /anchor: \{ cx: r\.left \+ r\.width \/ 2/, 'the fallback field anchors too');
});
