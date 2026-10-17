// MOD 兼容回归（2026-10-09 调研的「MOD 兼容问题」第 1 / 2 条）：
//   1. BGM 覆写按 modId 注册（main.js 的 bgmOverrides Map → audio.js 的单槽 fn）：后注册的 MOD 替换前一个而不是
//      并存冲突；卸下/停用后回退到前一个 MOD 或本体音乐；一个坏 MOD 的 fn 抛错绝不能静音本体音乐。
//   2. 音频看门狗重建 context 后 BGM 自动重启且 MOD 覆写（音乐盒）仍然生效（wantBgm 重放走 override）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { audio, setBgmOverride } from '../../public/js/audio.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 最小 fake AudioContext（同 musicbox-modes.test.js 的桩，另加 close() / state）。 */
function makeCtx({ state = 'running' } = {}) {
  const started = [];
  const mkGain = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} },
    connect() {}, disconnect() {},
  });
  return {
    currentTime: 0, destination: {}, state,
    createGain: mkGain,
    createBufferSource: () => {
      const src = {
        buffer: null, loop: false, playbackRate: { value: 1 }, onended: null,
        connect() {}, start() { started.push(src); }, stop() {},
      };
      return src;
    },
    close() {}, resume() { return Promise.resolve(); },
    _started: started,
  };
}

/** 干净的 audio 单例。 */
function fresh(ctx) {
  audio.ctx = ctx;
  audio.bgm = null;
  audio.bgmToken = 0;
  audio.wantBgm = null;
  audio._buffer = (u) => Promise.resolve({ url: u, duration: 3, length: 3, numberOfChannels: 1 });
  return ctx;
}

test('M1 · 覆写 fn 接管 playBgm；null / 抛错的 fn 回落本体音乐（坏 MOD 不静音游戏）', async () => {
  const ctx = fresh(makeCtx());
  setBgmOverride(({ key, track }) => (key === 'lobby' ? { loop: 'mod://track-a' } : track));
  await audio.playBgm('lobby');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx._started.at(-1)?.buffer?.url, 'mod://track-a', 'the MOD track plays');
  setBgmOverride(() => { throw new Error('broken MOD'); });
  await audio.playBgm('lobby');
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(ctx._started.at(-1)?.buffer, 'mod://track-a', 'a throwing override falls back to the game track');
  setBgmOverride(null);
  audio.bgm = null;
});

test('M2 · 看门狗重建 context：新图上 BGM 以 wantBgm 重启，MOD 覆写仍然生效', async () => {
  const dead = fresh(makeCtx({ state: 'suspended' }));
  setBgmOverride(({ key }) => (key === 'lobby' ? { loop: 'mod://musicbox-current' } : null));
  await audio.playBgm('lobby');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dead._started.at(-1)?.buffer?.url, 'mod://musicbox-current');

  const next = makeCtx();
  let closed = 0;
  dead.close = () => { closed += 1; };
  audio._createGraph = () => { audio.ctx = next; audio.master = {}; audio.bgmGain = {}; audio.sfxGain = {}; audio.voiceGain = {}; return true; };
  audio._rebuildContext();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, 1, 'the dead context was closed');
  assert.equal(audio.ctx, next);
  assert.equal(next._started.at(-1)?.buffer?.url, 'mod://musicbox-current', 'the BGM restarts on the fresh graph — through the MOD override');
  setBgmOverride(null);
  audio.bgm = null;
});

test('M3 · main.js 按 modId 管理 BGM 覆写：重激活清旧、停用回退、Map 换单槽（源码契约）', () => {
  const main = readFileSync(`${ROOT}/public/js/main.js`, 'utf8');
  assert.match(main, /const bgmOverrides = new Map\(\)/, 'per-MOD registry (not a single slot)');
  assert.match(main, /bgmOverrides\.set\(meta\.id, fn\)/, 'keyed by the plugin manifest id');
  assert.match(main, /bgmOverrides\.delete\(meta\.id\)/, 're-activation clears the stale override');
  assert.match(main, /for \(const \[id, f\] of bgmOverrides\) if \(!off\[id\]\) fn = f/, 'sync skips a disabled MOD — the previous MOD (or the game music) takes over');
  const audio = readFileSync(`${ROOT}/public/js/audio.js`, 'utf8');
  assert.match(audio, /bgmOverride\) \{\s*\n\s*try \{\s*\n\s*const own = bgmOverride\(/s, 'the audio layer asks the (composed) override inside playBgm');
  assert.match(audio, /a broken MOD must not silence the game's own music/, 'the override is fault-isolated');
});

test('M4 · 音乐盒 noLoop/onEnded 协议在重建重启后保持一致：新图播放的是 override 的新 playId 答案', async () => {
  const ctx = fresh(makeCtx());
  let playId = 1;
  const ended = [];
  setBgmOverride(() => ({ loop: 'mod://seq', noLoop: true, playId, onEnded: () => ended.push(playId) }));
  audio.playBgm('lobby');
  await new Promise((r) => setTimeout(r, 10));
  const src = ctx._started.at(-1);
  assert.equal(src.loop, false, 'noLoop survives on the fresh graph');
  src.onended();
  assert.deepEqual(ended, [1], 'a natural end still fires onEnded (the token guard only kills stop-induced fakes)');
  setBgmOverride(null);
  audio.bgm = null;
});
