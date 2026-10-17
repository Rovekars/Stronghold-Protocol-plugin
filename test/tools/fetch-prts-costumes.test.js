import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('PRTS costumes data', () => {
  const path = resolve(import.meta.dirname, '../../data/costumes.json');

  it('data/costumes.json exists', () => {
    assert.ok(existsSync(path), 'costumes.json should be committed');
  });

  it('has the expected schema and non-empty list', () => {
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(payload.fetchedAt && typeof payload.fetchedAt === 'string');
    assert.ok(Array.isArray(payload.costumes));
    assert.ok(payload.costumes.length > 300, `expected >300 costumes, got ${payload.costumes.length}`);
    for (const c of payload.costumes.slice(0, 20)) {
      assert.ok(c.id && typeof c.id === 'string');
      assert.ok(c.operator && typeof c.operator === 'string');
      assert.ok(c.skinName && typeof c.skinName === 'string');
      assert.ok(c.series && typeof c.series === 'string');
      assert.ok(c.bust && c.bust.startsWith('https://media.prts.wiki/'));
      assert.ok(c.head && c.head.startsWith('https://media.prts.wiki/'));
      assert.ok(c.full && c.full.startsWith('https://media.prts.wiki/'));
    }
  });
});
