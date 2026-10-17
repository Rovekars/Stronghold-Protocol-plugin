import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import setup from '../../public/mod/干员时装.js';

describe('operator-skin plugin setup', () => {
  before(() => {
    const store = {};
    globalThis.localStorage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
    globalThis.document = {
      createElement: () => ({ remove: () => {}, appendChild: () => {} }),
      body: { appendChild: () => {} },
    };
    globalThis.window = { addEventListener: () => {} };
    const payloads = {
      '/data/costumes.json': { costumes: [] },
      '/data/costume-spine.json': { chars: {} },
    };
    globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(payloads[url] ?? {}) });
  });

  it('registers a detail action and returns meta', () => {
    const actions = [];
    const api = {
      html: (strings, ...values) => strings.reduce((a, s, i) => a + s + (values[i] ?? ''), ''),
      registerDetailAction(entry) { actions.push(entry); },
      data: { list: () => [], subscribe: () => () => {} },
      toast: () => {},
    };
    const meta = setup(api);
    assert.equal(meta.id, 'operatorskin');
    assert.equal(meta.name, '干员时装');
    assert.equal(meta.version, '1.2.1');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].id, 'operatorskin-open');
    assert.equal(actions[0].label, '时装');
    assert.equal(typeof actions[0].onClick, 'function');
  });

  it('gallery/panel re-renders are not shadowed by the preact import (the revert-to-original click must live-render)', () => {
    // Regression (user report 2026-10-10): both render closures used to destructure `render` from the preact
    // module inside their own `import().then(({ render, h }) => …)` — shadowing the closure, so onPick handed
    // preact's render() to pickCostume as its re-render hook. after() then crashed preact (no args →
    // `t.__k` TypeError) and picking a costume (cancel included) never re-rendered nor toasted.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/mod/干员时装.js'), 'utf8');
    const opens = [...src.matchAll(/import\('\.\.\/vendor\/preact\.module\.js'\)\.then\(\(\{ ([^}]+) \}\) => \{/g)].map((m) => m[1]);
    assert.equal(opens.length, 2, 'exactly the gallery and the panel import preact');
    for (const destructure of opens) {
      assert.match(destructure, /render: draw/, `must alias preact render to draw (got "{ ${destructure} }")`);
      assert.ok(!/[^:\w]render[,}]/.test(destructure), `plain render in the destructure shadows the closure (got "{ ${destructure} }")`);
    }
  });

  it('the detail action forwards the chess record to togglePanel (regression: sfx wrap dropped the arg)', () => {
    // Regression (user report 2026-10-10): the 全项目音效大接线 wrapped the detail action's onClick from
    // `onClick: togglePanel` (the loader calls it as a.onClick(chess), loadout.js:389) into
    // `onClick: () => { audio.sfx('click'); togglePanel(); }` — dropping the `chess` argument, so openPanel
    // hit `if (!chess?.name) return` and the 时装 panel never opened. The wrapper must forward chess.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/mod/干员时装.js'), 'utf8');
    assert.ok(/onClick:\s*\(chess\)\s*=>\s*\{[\s\S]*togglePanel\(chess\)/.test(src),
      'the 时装 detail action must forward the chess record: onClick: (chess) => { … togglePanel(chess); }');
    assert.ok(!/onClick:\s*\(\)\s*=>\s*\{[\s\S]*?togglePanel\(\)/.test(src),
      'the broken arg-swallowing form (togglePanel() with no chess) must not exist');
  });
});
