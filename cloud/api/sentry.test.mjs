import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Lambda bundle holds only cloud/api, so it has its own copy of the relay's sentry.mjs (tested there).
test('cloud/api/sentry.mjs is the same as the relay\'s sentry.mjs', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('./sentry.mjs'), read('../../sentry.mjs'), 'copy sentry.mjs to cloud/api/sentry.mjs');
});
