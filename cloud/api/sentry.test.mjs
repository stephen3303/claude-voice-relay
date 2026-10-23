import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The Lambda bundle holds only cloud/api, so it has its own copy of the relay's sentry.mjs (tested there).
test('cloud/api/sentry.mjs is the same as the relay\'s sentry.mjs', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('./sentry.mjs'), read('../../sentry.mjs'), 'copy sentry.mjs to cloud/api/sentry.mjs');
});

// The first argument of console.error becomes the report's "where" tag, sent as is (sentry.mjs, reportConsoleErrors).
test('cloud/api passes console.error fixed words or a route, never a template string', () => {
  const dir = new URL('./', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /console\.error\(\s*`/, `${f}: give console.error a fixed place as its first argument`);
  }
});
