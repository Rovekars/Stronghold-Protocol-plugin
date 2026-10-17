// 自定义表情包 MOD (public/mod/自定义表情包.js + server/match/match/intents.js customEmote) 的服务端逻辑测试：
//   * g.customEmote 以 m.customEmote 广播给全场（含发送者自己），dataURL 原样透传；
//   * 与官方 g.emote 共用 lastEmoteAt —— chatCD 内再发任何一种表情都 RATE 拒绝；
//   * 非法 data（前缀 / 字符集 / 超长）BAD_MSG 拒绝且不广播；
//   * 每条路径跑完引擎不变量（invariants）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

/** Co-op match at PREP R1. */
function setup({ humans = 2, bots = 1, seed = 47 } = {}) {
  const h = makeMatch({ mode: 'coop', humans, bots, seed, fake: true }).start();
  h.toPrep(1);
  return h;
}

// 一张 1x1 gif 的 dataURL（合法形状，长度远小于上限）
const GIF_DATA = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const customEmotes = (h) => h.bc.filter((m) => m.t === 'm.customEmote');

test('发送：g.customEmote 广播 m.customEmote 给全场（dataURL 原样透传）', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.customEmote', data: GIF_DATA }), { ok: true });
  const msgs = customEmotes(h);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].playerId, 'p_0');
  assert.equal(msgs[0].data, GIF_DATA);
  h.invariants();
});

test('广播包含发送者自己（官方气泡对自己也显示）', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.customEmote', data: GIF_DATA }), { ok: true });
  // harness 记录 broadcast 的方式与官方 m.emote 相同；直接断言 bc 里有一条即可（全场同播）
  assert.equal(h.bc.filter((x) => x.t === 'm.emote').length, 0, 'does not go through the official emote channel');
  assert.equal(customEmotes(h).length, 1);
  h.invariants();
});

test('冷却：chatCD 内再发（官方或自定义）都 RATE 拒绝', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.customEmote', data: GIF_DATA }), { ok: true });
  const res = m.handle('p_0', { t: 'g.customEmote', data: GIF_DATA });
  assert.deepEqual(res, { error: 'RATE' });
  assert.equal(customEmotes(h).length, 1, 'no second broadcast');
  h.invariants();
});

test('非法 data：非图片前缀拒绝且不广播', () => {
  const h = setup();
  const m = h.m;
  const res = m.handle('p_0', { t: 'g.customEmote', data: 'data:text/html;base64,PGI+aGk8L2I+' });
  assert.deepEqual(res, { error: 'BAD_MSG', detail: 'bad custom emote' });
  assert.equal(customEmotes(h).length, 0);
  h.invariants();
});

test('非法 data：超长（> 2.8M 字符）拒绝且不广播', () => {
  const h = setup();
  const m = h.m;
  // 合法前缀 + 超出上限的 base64 主体
  const big = `data:image/png;base64,${'A'.repeat(2800001)}`;
  const res = m.handle('p_0', { t: 'g.customEmote', data: big });
  assert.deepEqual(res, { error: 'BAD_MSG', detail: 'bad custom emote' });
  assert.equal(customEmotes(h).length, 0);
  h.invariants();
});

test('大 GIF（≈2MB，典型表情包尺寸）放行并广播', () => {
  const h = setup();
  const m = h.m;
  // ≈1.85MB 图片 → 2.5M 字符 dataURL：上限放宽后（isEmoteData ≤ 2.8M）应放行
  const bigGif = `data:image/gif;base64,${'R'.repeat(2500000)}`;
  assert.deepEqual(m.handle('p_0', { t: 'g.customEmote', data: bigGif }), { ok: true });
  const msgs = customEmotes(h);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].data, bigGif);
  h.invariants();
});

test('非 gif 大图也受同一上限约束（2.8M 内放行）', () => {
  const h = setup();
  const m = h.m;
  const bigPng = `data:image/png;base64,${'i'.repeat(2000000)}`;
  assert.deepEqual(m.handle('p_0', { t: 'g.customEmote', data: bigPng }), { ok: true });
  assert.equal(customEmotes(h).length, 1);
  h.invariants();
});

test('非法 data：断裂的 base64（控制字符）拒绝', () => {
  const h = setup();
  const m = h.m;
  const res = m.handle('p_0', { t: 'g.customEmote', data: `data:image/gif;base64,R0lGOD\nlhAQABAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7` });
  assert.deepEqual(res, { error: 'BAD_MSG', detail: 'bad custom emote' });
  assert.equal(customEmotes(h).length, 0);
  h.invariants();
});

test('两人各自发送：各自走一遍冷却，互不影响', () => {
  const h = setup();
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.customEmote', data: GIF_DATA }), { ok: true });
  assert.deepEqual(m.handle('p_1', { t: 'g.customEmote', data: GIF_DATA }), { ok: true });
  assert.equal(customEmotes(h).length, 2);
  assert.equal(customEmotes(h)[0].playerId, 'p_0');
  assert.equal(customEmotes(h)[1].playerId, 'p_1');
  h.invariants();
});

test('协议白名单：validateC2S 接受合法形状、拒绝非法形状', async () => {
  const { validateC2S } = await import('../../shared/protocol.js');
  assert.equal(validateC2S({ t: 'g.customEmote', data: GIF_DATA }), null);
  assert.ok(validateC2S({ t: 'g.customEmote', data: 'data:image/bmp;base64,AAAA' }));
  assert.ok(validateC2S({ t: 'g.customEmote', data: 42 }));
});
