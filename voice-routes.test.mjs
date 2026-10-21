import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, inboxAfter } from './voice-routes.mjs';

test('each voice route reaches its handler', () => {
  assert.equal(route('GET', '/voice/inbox?after=3').name, 'inbox');
  assert.equal(route('POST', '/voice/tts').name, 'tts');
  assert.equal(route('POST', '/voice/photo').name, 'photo');
  for (const p of ['/voice', '/voice/confirm', '/voice/send']) assert.equal(route('POST', p).name, 'speech');
});

test('a query string or trailing slash still reaches the route', () => {
  assert.deepEqual(route('POST', '/voice/send?v=2'), { name: 'speech', pathname: '/voice/send' });
  assert.equal(route('POST', '/voice/confirm/').pathname, '/voice/confirm');
  assert.equal(route('POST', '//voice/confirm').pathname, '/voice/confirm');
  assert.equal(route('GET', '/voice//inbox').name, 'inbox');
});

test('unknown paths are 404, including near misses', () => {
  assert.equal(route('GET', '/voice/inboxes').status, 404);
  assert.equal(route('POST', '/voice/confirmx').status, 404);
  assert.equal(route('GET', '/').status, 404);
  assert.equal(route('GET', '/constructor').status, 404);
});

test('a known path with the wrong method is 405', () => {
  assert.deepEqual(route('GET', '/voice/send'), { status: 405, allow: 'POST', pathname: '/voice/send' });
  assert.equal(route('POST', '/voice/inbox').allow, 'GET');
});

test('inbox cursor: absent is now, digits are an id, anything else is rejected', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(inboxAfter(q(''), 42), 42);
  assert.equal(inboxAfter(q('after=7'), 42), 7);
  assert.equal(inboxAfter(q('after=0'), 42), 0);
  assert.equal(inboxAfter(q('after=abc'), 42), null);
  assert.equal(inboxAfter(q('after='), 42), null);
  assert.equal(inboxAfter(q('after=-1'), 42), null);
});
