import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNtfy, ntfyUrlOk } from './ntfy.mjs';

const URL_ = 'https://ntfy.sh/bridge_TEST-topic';

function fakeFetch(status = 200) {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, ...opts }); return { ok: status < 300, status }; };
  return { fetch, calls };
}

test('ntfy is off without a URL', () => {
  assert.equal(makeNtfy({ url: '' }), null);
});

test('ntfy refuses a URL that is not https://server/topic, without logging it', () => {
  for (const bad of ['http://ntfy.sh/topic', 'https://ntfy.sh/', 'https://ntfy.sh/a/b', 'https://ntfy.sh/topic?x=1', 'ntfy.sh/topic']) {
    const logs = [];
    assert.equal(makeNtfy({ url: bad, log: (...a) => logs.push(a.join(' ')) }), null, bad);
    assert.ok(logs.length === 1 && !logs[0].includes(bad), bad);
  }
  assert.ok(ntfyUrlOk(URL_));
  assert.ok(ntfyUrlOk('https://ntfy.example.com:8443/bridge'));
});

test('ntfy posts the text with a title, and the token when set', async () => {
  const { fetch, calls } = fakeFetch();
  await makeNtfy({ fetch, url: URL_ })('relay: Done.');
  assert.equal(calls[0].url, URL_);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, 'relay: Done.');
  assert.equal(calls[0].headers.title, 'Bridge');
  assert.equal(calls[0].headers.authorization, undefined);
  await makeNtfy({ fetch, url: URL_, token: 'tk_TEST' })('hi');
  assert.equal(calls[1].headers.authorization, 'Bearer tk_TEST');
});

test('a long message is cut to 4000 characters', async () => {
  const { fetch, calls } = fakeFetch();
  await makeNtfy({ fetch, url: URL_ })('x'.repeat(5000));
  assert.equal(calls[0].body.length, 4000);
});

test('a failed post is logged, not thrown, and the log has no URL or token', async () => {
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  await makeNtfy({ fetch: fakeFetch(403).fetch, url: URL_, token: 'tk_TEST', log })('hi');
  await makeNtfy({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, url: URL_, token: 'tk_TEST', log })('hi');
  assert.deepEqual(logs, ['ntfy answered 403', 'ntfy failed: getaddrinfo ENOTFOUND']);
});
