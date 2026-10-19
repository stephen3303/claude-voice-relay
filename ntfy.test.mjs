import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNtfy } from './ntfy.mjs';

test('does nothing without a valid topic', async () => {
  let called = false;
  for (const topic of [undefined, '', 'short', 'has space in it!']) {
    const n = makeNtfy({ topic, fetchFn: async () => { called = true; } });
    assert.equal(n.enabled, false);
    assert.equal(await n.send('hi'), false);
  }
  assert.equal(called, false);
});

test('posts the message to the topic with an ASCII title', async () => {
  let seen;
  const n = makeNtfy({ topic: 'my-secret-topic-123', server: 'https://x.test/', fetchFn: async (url, o) => { seen = { url, o }; return { ok: true }; } });
  assert.equal(await n.send('done', 'Bridge é'), true);
  assert.equal(seen.url, 'https://x.test/my-secret-topic-123');
  assert.equal(seen.o.body, 'done');
  assert.equal(seen.o.headers.Title, 'Bridge ');
});

test('reports failure instead of throwing', async () => {
  const bad = makeNtfy({ topic: 'my-secret-topic-123', fetchFn: async () => ({ ok: false, status: 500 }) });
  assert.equal(await bad.send('x'), false);
  const boom = makeNtfy({ topic: 'my-secret-topic-123', fetchFn: async () => { throw new Error('down'); } });
  assert.equal(await boom.send('x'), false);
});
