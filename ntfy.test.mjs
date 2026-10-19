import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNtfy, ntfyUrlOk, cut } from './ntfy.mjs';

const URL_ = 'https://ntfy.sh/bridge_TEST-topic-0123456789';

function fakeFetch(status = 200) {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, ...opts }); return { ok: status < 300, status }; };
  return { fetch, calls };
}

test('ntfy is off without a URL', () => {
  assert.equal(makeNtfy({ url: '' }), null);
});

test('ntfy refuses a URL that is not https://server/topic, without logging it', () => {
  const long = 'a'.repeat(20);
  for (const bad of [`http://ntfy.sh/${long}`, 'https://ntfy.sh/', `https://ntfy.sh/a/${long}`, `https://ntfy.sh/${long}?x=1`, `ntfy.sh/${long}`,
    `https://user:pw@ntfy.sh/${long}`, 'https://ntfy.sh/bridge']) {
    const logs = [];
    assert.equal(makeNtfy({ url: bad, log: (...a) => logs.push(a.join(' ')) }), null, bad);
    assert.ok(logs.length === 1 && !logs[0].includes(bad), bad);
  }
  assert.ok(ntfyUrlOk(URL_));
  assert.ok(ntfyUrlOk('https://ntfy.example.com:8443/bridge', { token: 'tk' }), 'a short topic is fine behind a token');
  assert.ok(!ntfyUrlOk('https://ntfy.sh/bridge'));
  assert.ok(makeNtfy({ url: 'https://ntfy.example.com/bridge', token: 'tk' }));
});

test('ntfy posts the text with a title, and the token when set', async () => {
  const { fetch, calls } = fakeFetch();
  await makeNtfy({ fetch, url: URL_ })('relay: Done.');
  assert.equal(calls[0].url, URL_);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, 'relay: Done.');
  assert.equal(calls[0].headers.title, 'Bridge');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.authorization, undefined);
  await makeNtfy({ fetch, url: URL_, token: 'tk_TEST' })('hi');
  assert.equal(calls[1].headers.authorization, 'Bearer tk_TEST');
});

test('a long message is cut to 4000 bytes, on a character boundary', async () => {
  const { fetch, calls } = fakeFetch();
  await makeNtfy({ fetch, url: URL_ })('x'.repeat(5000));
  assert.equal(calls[0].body.length, 4000);
  assert.equal(Buffer.byteLength(cut('é'.repeat(3000))), 4000);
  const emoji = cut('a' + '😀'.repeat(1500));
  assert.ok(Buffer.byteLength(emoji) <= 4000 && emoji.endsWith('😀'));
  assert.equal(cut('short'), 'short');
});

test('a failed post is logged, not thrown, and the log has no URL or token', async () => {
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  await makeNtfy({ fetch: fakeFetch(403).fetch, url: URL_, token: 'tk_TEST', log })('hi');
  const failing = (e) => async () => { throw e; };
  await makeNtfy({ fetch: failing(Object.assign(new TypeError(`fetch failed ${URL_}`), { cause: { code: 'ENOTFOUND' } })), url: URL_, log })('hi');
  await makeNtfy({ fetch: failing(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${URL_}`)), url: URL_, log })('hi');
  await makeNtfy({ fetch: failing(Object.assign(new Error('x'), { name: 'TimeoutError' })), url: URL_, log })('hi');
  assert.deepEqual(logs, ['ntfy answered 403', 'ntfy failed: ENOTFOUND', 'ntfy failed: TypeError', 'ntfy failed: timed out']);
  assert.ok(logs.every((l) => !l.includes('bridge_TEST') && !l.includes('tk_TEST')));
});
