// 技能自动 插件（public/mod/技能自动施放.js）的装配测试：
//   * 走本体扩展点 api.registerLoadoutAction（干员调配头部原生按钮位，单个统一开关）+ 一个无头 overlay（进对局自动下发）；
//   * 点按钮开 / 关，按钮文案与状态在本地即时翻转并落盘；
//   * 默认挡 = 关（v1.1.3：手动技能不自动开、局内点击施放；开 = 挂机全自动）；
//   * 最终通过 g.setSkillAuto { on }（服务端权威）下发，本地偏好只是副本。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin from '../../public/mod/技能自动施放.js';

function fakeApi() {
  const sent = [];
  const actions = [];
  const overlays = [];
  const api = {
    html: (strings, ...values) => strings.reduce((a, s, i) => a + s + (values[i] ?? ''), ''),
    store: { get: () => ({}), subscribe: () => () => {} },
    net: { request: (t, body) => { sent.push({ t, body }); return Promise.resolve({ ok: true }); } },
    data: { list: () => [], lookup: () => null },
    toast: () => {},
    registerOverlay(C) { overlays.push(C); },
    registerLoadoutAction(entry) { actions.push(entry); },
    unregisterLoadoutActions() {},
  };
  return { api, sent, actions, overlays };
}

describe('skill-auto plugin setup', () => {
  before(() => {
    const store = {};
    globalThis.localStorage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
  });

  it('registers one loadout action and one headless overlay, and returns meta', () => {
    const { api, actions, overlays } = fakeApi();
    const meta = plugin.setup(api) || plugin;
    assert.equal(meta.id, 'skilltoggle');
    assert.equal(meta.name, '技能自动');
    assert.equal(meta.version, '1.1.3');
    assert.equal(actions.length, 1, 'one header button, no duplicates on a re-activation');
    assert.equal(actions[0].id, 'skillauto-toggle');
    assert.match(actions[0].label, /^技能自动施放：/);
    assert.equal(actions[0].icon, 'bolt');
    assert.equal(typeof actions[0].onClick, 'function');
    assert.equal(overlays.length, 1, 'the brain that applies the pref at match start');
  });

  it('clicking the header button flips the switch locally and persists it', () => {
    const { api, actions } = fakeApi();
    plugin.setup(api);
    const btn = actions[0];
    assert.equal(btn.label, '技能自动施放：关', 'starts closed by default (v1.1.3: manual skills wait for a hand cast)');
    assert.equal(btn.variant, 'secondary');

    btn.onClick();
    // refreshBtn re-registers, so the live entry is the last push
    const live = actions[actions.length - 1];
    assert.equal(live.label, '技能自动施放：开', 'flips to open (vanilla AFK: everything auto-casts)');
    assert.equal(live.variant, 'primary');
    const saved = JSON.parse(globalThis.localStorage.getItem('sp.skillauto.pref.v2'));
    assert.equal(saved.on, false, 'the preference is persisted to localStorage');
  });

  it('the switch is sent as g.setSkillAuto { on } — the server decides, the plugin only asks', () => {
    const src = fs.readFileSync(new URL('../../public/mod/技能自动施放.js', import.meta.url), 'utf8');
    assert.match(src, /net\.request\('g\.setSkillAuto', \{ on \}\)/);
    assert.match(src, /registerLoadoutAction\(/);
    assert.match(src, /registerOverlay\(SkillBrain\)/);
  });
});
