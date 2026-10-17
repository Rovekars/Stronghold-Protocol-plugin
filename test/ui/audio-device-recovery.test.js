// Device-failure recovery (public/js/audio.js): Chrome kills a WebAudio context with "an error from the audio
// device or the WebAudio renderer" when the output device vanishes / switches, and the context then stays
// 'suspended' FOREVER — resume() resolves but never runs, and BGM / SFX / voice / the 音乐盒 are all silent.
// The watchdog (audio.js WATCHDOG_* constants) must notice, try resume(), and rebuild the graph on a fresh
// AudioContext — including restarting the wanted BGM (MOD 音乐盒 override included).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioManager } from '../../public/js/audio.js';
import { mediaUrl } from '../../public/js/media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));

/** Fake window + a configurable AudioContext: `resume` behaves per script (refuse = resolve but never run). */
function fakeWorld() {
  const listeners = new Map();
  const ticks = [];
  const urls = [];
  const made = { closed: [], created: 0, started: 0 };

  class Param {
    constructor() { this.value = 1; }
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime() {}
    setTargetAtTime() {}
    cancelScheduledValues() {}
  }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Src extends Node {
    constructor() { super(); this.playbackRate = new Param(); made.started++; }
    start() {}
    stop() {}
  }
  class Ctx {
    constructor() {
      made.created++;
      this.currentTime = 0;
      this.state = 'running';
      this.sampleRate = 44100;
      this.destination = new Node();
    }
    createGain() { return new Gain(); }
    createBufferSource() { return new Src(); }
    createBuffer() { return { duration: 1 }; }
    decodeAudioData(ab, ok) { ok({ duration: 1.5 }); }
    addEventListener() {}
    resume() { return Promise.resolve(); }   // scripts override (refuse = a dead device)
    suspend() { return Promise.resolve(); }
    close() { this.closed = true; made.closed.push(this); }
  }
  const win = {
    AudioContext: Ctx,
    document: { hidden: false, addEventListener() {} },
    addEventListener(t, fn) { listeners.set(t, fn); },
    removeEventListener(t) { listeners.delete(t); },
    setInterval(fn) { ticks.push(fn); return 1; },
    clearInterval() {},
  };
  const fire = (t) => listeners.get(t)?.();
  return { win, listeners, ticks, urls, made, fire };
}

/** Manifest-returning manager on the fake world, unlocked like a real player (a first gesture). */
function rig(w) {
  globalThis.fetch = (u) => {
    w.urls.push(String(u));
    return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(8) });
  };
  const a = new AudioManager({ win: w.win, getManifest: () => manifest });
  a.install();
  return a;
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('audio device-failure recovery (watchdog)', () => {
  test('watchdog is armed by install() through the window, not a global timer', () => {
    const w = fakeWorld();
    rig(w);
    assert.equal(w.ticks.length, 1, 'exactly one interval, taken from the (fake) window');
  });

  test('a context killed by the device error is rebuilt after 3 fruitless resume ticks, BGM restarts', async () => {
    const w = fakeWorld();
    const a = rig(w);
    w.fire('pointerdown');                       // unlocked: ctx #1 running
    a.playBgm('lobby');
    await settle();
    assert.ok(w.urls.includes(mediaUrl(manifest.audio.bgm.lobby.loop)), 'BGM fetched on the first graph');

    const dead = a.ctx;
    dead.state = 'suspended';                    // Chrome's device error: suspended forever, resume "works" but never runs
    const tick = w.ticks[0];
    tick(); tick();                              // tries 1–2: resume, still suspended
    assert.equal(a.ctx, dead, 'no rebuild before WATCHDOG_RESUMES attempts');
    tick();                                      // try 3 ⇒ rebuild
    assert.ok(dead.closed, 'the dead context was closed');
    assert.notEqual(a.ctx, dead);
    assert.equal(a.ctx.state, 'running', 'the fresh graph runs');
    await settle();
    assert.ok(w.urls.includes(mediaUrl(manifest.audio.bgm.lobby.loop)), 'BGM restarted on the new graph');
    assert.ok(a.bgm, 'a BGM node set exists again');
  });

  test('rebuilds are rate-limited: a second failure burst inside the gap does not churn', async () => {
    const w = fakeWorld();
    const a = rig(w);
    w.fire('pointerdown');
    const tick = w.ticks[0];
    a.ctx.state = 'suspended';
    tick(); tick(); tick();
    assert.equal(w.made.closed.length, 1, 'first burst rebuilt once');
    a.ctx.state = 'suspended';                   // the fresh one dies too, right away
    a._lastRebuildAt = Date.now();               // …and the gap has not elapsed
    tick(); tick(); tick();
    assert.equal(w.made.closed.length, 1, 'no second rebuild inside REBUILD_MIN_GAP_MS');
  });

  test('a resume that actually works (device came back) never rebuilds', async () => {
    const w = fakeWorld();
    const a = rig(w);
    w.fire('pointerdown');
    const ctx = a.ctx;
    ctx.state = 'suspended';
    ctx.resume = function () { this.state = 'running'; return Promise.resolve(); };   // device is back
    const tick = w.ticks[0];
    tick();
    await Promise.resolve();                     // let the resume promise's then run
    tick(); tick(); tick();
    assert.equal(a.ctx, ctx, 'the recovered context stays');
    assert.equal(w.made.closed.length, 0, 'nothing was closed');
  });

  test('a visible page is required: hidden tabs tick to nothing', () => {
    const w = fakeWorld();
    const a = rig(w);
    w.fire('pointerdown');
    a.ctx.state = 'suspended';
    w.win.document.hidden = true;
    w.ticks[0](); w.ticks[0](); w.ticks[0]();
    assert.equal(w.made.closed.length, 0, 'no rebuild while the tab is hidden');
    w.win.document.hidden = false;
    w.ticks[0](); w.ticks[0](); w.ticks[0]();
    assert.equal(w.made.closed.length, 1, 'rebuild resumes once visible again');
  });

  test('retryAudio (设置面板的 修复): a dead context is rebuilt right away', async () => {
    const w = fakeWorld();
    const a = rig(w);
    w.fire('pointerdown');
    const dead = a.ctx;
    dead.state = 'suspended';
    dead.resume = function () { return Promise.resolve(); };   // never recovers
    a.retryAudio();
    await settle();
    assert.ok(dead.closed, 'the dead context was closed');
    assert.notEqual(a.ctx, dead, 'a fresh graph exists');
    assert.equal(a.deviceStatus.state, 'running');
  });

  test('retryAudio on a healthy context does nothing', () => {
    const w = fakeWorld();
    const a = rig(w);
    w.fire('pointerdown');
    const ctx = a.ctx;
    a.retryAudio();
    assert.equal(a.ctx, ctx, 'no churn when audio is fine');
  });

  test('deviceStatus reports the truth for the settings row', () => {
    const w = fakeWorld();
    const a = rig(w);
    assert.deepEqual(a.deviceStatus, { ctx: false, state: null }, 'locked = nothing to report');
    w.fire('pointerdown');
    assert.deepEqual(a.deviceStatus, { ctx: true, state: 'running' });
    a.ctx.state = 'suspended';
    assert.equal(a.deviceStatus.state, 'suspended', 'the hint row can see the dead device');
  });
});
