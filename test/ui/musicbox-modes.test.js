// 音乐盒 播放模式（v1.1.0：顺序 / 单曲循环 / 随机）回归测试。
//
// A. audio.js 侧的 BGM 覆写协议扩展：override 答案可以带 `noLoop`（曲目只播一次）+ `onEnded`
//    （自然播完回调，淡出 / 切歌的 stop 触发的 onended 必须被 token 守卫挡掉）+ `playId`
//    （同一 URL 重新开播的流水号，绕过「同 loop URL 不重启」的短路）。
// B. musicbox.js 面板（fake DOM）：三个模式按钮渲染、点击切换、override 形状随模式变化、
//    localStorage 持久化（含 v1.0 的 shuffle 布尔兼容）、顺序模式播完推进 / 到列表末尾停下。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// ---- A. audio.js：BGM 覆写的 noLoop / onEnded / playId ------------------------------------------------------------

import { audio, setBgmOverride } from '../../public/js/audio.js';

/** 最小 fake AudioContext：够 _startBgm / _fadeOutBgm 跑通，并记录 start 的源节点。 */
function makeCtx() {
  const started = [];
  const mkGain = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} },
    connect() {}, disconnect() {},
  });
  return {
    currentTime: 0, destination: {},
    createGain: mkGain,
    createBufferSource: () => {
      const src = {
        buffer: null, loop: false, playbackRate: { value: 1 }, onended: null, _stopped: false,
        connect() {},
        start(_t) { started.push(src); },
        stop() { src._stopped = true; },
      };
      return src;
    },
    _started: started,
  };
}

/** 干净的 audio 单例 + 立即解码成功的 buffer 缓存桩。 */
function fresh() {
  const ctx = makeCtx();
  audio.ctx = ctx;
  audio.bgm = null;
  audio.bgmToken = 0;
  audio.wantBgm = null;
  audio._buffer = () => Promise.resolve({ duration: 3, length: 3, numberOfChannels: 1 });
  return ctx;
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('A1 · 默认（无 noLoop）仍是原生 loop=true', async () => {
  const ctx = fresh();
  await audio._startBgm('lobby', { loop: 'u1' }, ++audio.bgmToken);
  assert.equal(ctx._started.length, 1);
  assert.equal(ctx._started[0].loop, true);
  assert.equal(ctx._started[0].onended, null);
  setBgmOverride(null);
});

test('A2 · noLoop：只播一次；onEnded 只在 token 仍有效（自然播完）时触发', async () => {
  const ctx = fresh();
  let ended = 0;
  const token = ++audio.bgmToken;
  await audio._startBgm('lobby', { loop: 'u2', noLoop: true, playId: 1, onEnded: () => { ended += 1; } }, token);
  const src = ctx._started.at(-1);
  assert.equal(src.loop, false);
  assert.equal(typeof src.onended, 'function');
  src.onended();                       // 自然播完
  assert.equal(ended, 1);
  audio.bgmToken += 1;                 // 淡出 / 切歌：token 已前进
  src.onended();                       // stop 引发的假结束必须被挡掉
  assert.equal(ended, 1);
  setBgmOverride(null);
});

test('A3 · playBgm：同 URL 同 playId 短路续播；playId 变化则重启同一首', async () => {
  const ctx = fresh();
  const track = { loop: 'u3', noLoop: true, playId: 42, onEnded() {} };
  setBgmOverride(() => track);
  audio.playBgm('lobby');
  await tick();
  assert.equal(ctx._started.length, 1);
  audio.playBgm('lobby');              // 同 key：续播
  await tick();
  audio.playBgm('room');               // 换 key、同曲目：同样续播（阶段切换不能重启曲子）
  await tick();
  assert.equal(ctx._started.length, 1);
  track.playId = 43;                   // 插件重播同一首：必须真的重启
  audio.playBgm('lobby');
  await tick();
  assert.equal(ctx._started.length, 2);
  assert.equal(ctx._started[1]._stopped || ctx._started[0]._stopped, true); // 旧的那条被淡出停掉
  setBgmOverride(null);
});

// ---- B. musicbox.js：面板的三模式按钮 + 播完推进（fake DOM） ------------------------------------------------------

register(new URL('./musicbox-vendor-loader.mjs', import.meta.url));

const { h, render } = await import('preact');
const html = (await import('htm')).default.bind(h);

// fake DOM（preact-fake-dom-test 方法论：data 双向、onclick/onchange/oninput 归一、事件对象带 type）
function fakeNode(tag) {
  const n = {
    tagName: tag, type: tag, children: [], attributes: {}, l: {}, style: {},
    onclick: null, onchange: null, oninput: null, value: '',
    appendChild(c) { n.children.push(c); c.parentNode = n; return c; },
    insertBefore(c, ref) {
      const i = n.children.indexOf(ref);
      if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
      c.parentNode = n; return c;
    },
    removeChild(c) {
      const i = n.children.indexOf(c);
      if (i >= 0) n.children.splice(i, 1);
      c.parentNode = null; return c;
    },
    setAttribute(k, v) { n.attributes[k] = String(v); },
    removeAttribute(k) { delete n.attributes[k]; },
    addEventListener() {}, removeEventListener() {},
    get firstChild() { return n.children[0] || null; },
    get nextSibling() {
      const p = n.parentNode;
      return p ? p.children[p.children.indexOf(n) + 1] || null : null;
    },
  };
  return n;
}
globalThis.document = {
  createElement: (t) => fakeNode(String(t).toLowerCase()),
  createElementNS: (_ns, t) => fakeNode(String(t).toLowerCase()),
  createTextNode: (s) => {
    const n = fakeNode('#text');
    n.textContent = String(s);
    Object.defineProperty(n, 'data', { get() { return this.textContent; }, set(v) { this.textContent = String(v); } });
    return n;
  },
  body: fakeNode('body'),
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const flatText = (n, out = []) => {
  if (n.type === '#text') out.push(n.textContent);
  for (const c of n.children) flatText(c, out);
  return out;
};
const all = (n, pred, out = []) => {
  if (pred(n)) out.push(n);
  for (const c of n.children) all(c, pred, out);
  return out;
};
const buttons = (n) => all(n, (x) => x.type === 'button');
const byText = (n, s) => buttons(n).find((b) => flatText(b).join('').includes(s));
const fire = (node, type, extra) => {
  const fn = (node.l && (node.l[`${type}false`] || node.l[type])) || node[`on${type}`];
  assert.equal(typeof fn, 'function', `no ${type} handler on node`);
  fn.call(node, { type, stopPropagation() {}, preventDefault() {}, ...extra });
};

const mod = (await import('../../public/mod/音乐盒.js')).default;

/** fake plugin api：捕获 settings entry / BGM 覆写。 */
function makeApi() {
  const cap = { entry: null, overrides: [], toasts: [], refreshed: 0 };
  cap.api = {
    html, h,
    toast: (m, t) => cap.toasts.push([m, t]),
    setBgmOverride: (fn) => { cap.overrides.push(fn); },
    refreshBgm: () => { cap.refreshed += 1; },
    registerSettingsEntry: (e) => { cap.entry = e; },
  };
  return cap;
}
const lastOverride = (cap) => cap.overrides[cap.overrides.length - 1];

test('B1 · 三模式按钮渲染；循环（默认）走原生 loop，不开 noLoop', async () => {
  const cap = makeApi();
  mod.setup(cap.api);
  await tick(60);                      // idbAll().then 异步收尾
  const root = fakeNode('div');
  render(h(cap.entry.Panel), root);
  await tick(60);
  const text = flatText(root).join('');
  assert.ok(text.includes('➡️ 顺序'), '顺序按钮');
  assert.ok(text.includes('🔁 循环'), '循环按钮');
  assert.ok(text.includes('🔀 随机'), '随机按钮');
  // 点一首曲库曲目：默认单曲循环 → override 只有 loop，无 noLoop / onEnded
  fire(byText(root, 'Innocence'), 'click');
  await tick(60);
  const o1 = lastOverride(cap)({ key: 'lobby', track: null });
  assert.deepEqual([o1.loop, o1.noLoop, o1.onEnded], ['/media/netease/3375918502', undefined, undefined]);
  cap.done = true;
});

test('B2 · 随机 / 顺序模式：override 带 noLoop + playId + onEnded，持久化跟随', async () => {
  const cap = makeApi();
  mod.setup(cap.api);
  await tick(60);
  const root = fakeNode('div');
  render(h(cap.entry.Panel), root);
  await tick(60);
  fire(byText(root, 'Innocence'), 'click');
  await tick(60);
  fire(byText(root, '随机'), 'click');
  await tick(60);
  let o = lastOverride(cap)({ key: 'lobby', track: null });
  assert.equal(o.loop, '/media/netease/3375918502');
  assert.equal(o.noLoop, true);
  assert.equal(typeof o.onEnded, 'function');
  assert.ok(Number.isFinite(o.playId) && o.playId > 0);
  assert.equal(JSON.parse(localStorage.getItem('sp.pref.musicbox')).mode, 'shuffle');
  fire(byText(root, '顺序'), 'click');
  await tick(60);
  o = lastOverride(cap)({ key: 'lobby', track: null });
  assert.equal(o.noLoop, true);
  assert.equal(JSON.parse(localStorage.getItem('sp.pref.musicbox')).mode, 'order');
  fire(byText(root, '循环'), 'click');
  await tick(60);
  o = lastOverride(cap)({ key: 'lobby', track: null });
  assert.equal(o.noLoop, undefined);
  assert.equal(JSON.parse(localStorage.getItem('sp.pref.musicbox')).mode, 'loop');
});

test('B3 · 顺序模式自然播完：推进到下一首（playId 递增）；最后一首播完即停', async () => {
  const cap = makeApi();
  mod.setup(cap.api);
  await tick(60);
  const root = fakeNode('div');
  render(h(cap.entry.Panel), root);
  await tick(60);
  fire(byText(root, '顺序'), 'click');
  await tick(60);
  fire(byText(root, 'Innocence'), 'click');       // 曲库第 1 首
  await tick(60);
  let o = lastOverride(cap)({ key: 'lobby', track: null });
  const pid1 = o.playId;
  o.onEnded();                                     // 播完 → 顺序推进到第 2 首
  await tick(60);
  o = lastOverride(cap)({ key: 'lobby', track: null });
  assert.equal(o.loop, '/media/netease/3376569082'); // All by My Design
  assert.ok(o.playId > pid1, 'playId 递增让同一协议重启新曲');
  // 搜到曲库最后一首「嚣」（不在前 60 行里，走搜索过滤）
  const input = all(root, (x) => x.type === 'input')[0];
  input.value = '嚣';
  fire(input, 'input', { currentTarget: input });
  await tick(60);
  fire(byText(root, '嚣'), 'click');
  await tick(60);
  o = lastOverride(cap)({ key: 'lobby', track: null });
  assert.ok(o.loop.startsWith('https://media.prts.wiki/'), '最后一首是站内直链');
  o.onEnded();                                     // 顺序模式放完最后一首 → 停
  await tick(60);
  o = lastOverride(cap)({ key: 'lobby', track: null });
  assert.equal(o, null, '停止后 BGM 交还本体');
  assert.equal(JSON.parse(localStorage.getItem('sp.pref.musicbox')).playing, false);
});

test('B4 · v1.0 存档兼容：shuffle 布尔读成随机模式', async () => {
  localStorage.setItem('sp.pref.musicbox', JSON.stringify({ on: true, playing: true, shuffle: true, cur: null }));
  const cap = makeApi();
  mod.setup(cap.api);
  await tick(60);
  const root = fakeNode('div');
  render(h(cap.entry.Panel), root);
  await tick(60);
  const rnd = byText(root, '随机');
  assert.ok(rnd, '随机按钮在');
  assert.ok(rnd.style.background.includes('rgba(78, 216, 175'), '随机 pill 处于选中态（v1.0 shuffle 继承）');
  // 立刻覆写回 v1.1.0 形状，别把兼容写法留进存档
  fire(byText(root, '顺序'), 'click');
  await tick(60);
  assert.equal(JSON.parse(localStorage.getItem('sp.pref.musicbox')).mode, 'order');
  assert.equal(JSON.parse(localStorage.getItem('sp.pref.musicbox')).shuffle, undefined);
});
