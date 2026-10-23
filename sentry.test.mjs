import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDsn, clean, frames, toEvent, makeSentry } from './sentry.mjs';

const DSN = 'https://0123456789abcdef0123456789abcdef@o123.ingest.us.sentry.io/456';

test('parseDsn reads the key and the envelope URL, and refuses anything else', () => {
  assert.deepEqual(parseDsn(DSN), { key: '0123456789abcdef0123456789abcdef', url: 'https://o123.ingest.us.sentry.io/api/456/envelope/', dsn: DSN });
  assert.equal(parseDsn('http://0123456789abcdef@host/1'), null);
  assert.equal(parseDsn('https://host/1'), null);
  assert.equal(parseDsn('https://0123456789abcdef:secret@host/1'), null);
  assert.equal(parseDsn('https://0123456789abcdef@host/1/../x'), null);
});

test('clean keeps the start of a message and takes out what identifies anyone', () => {
  assert.equal(clean("ENOENT: no such file or directory, open 'C:\\Users\\steph\\x'"), 'ENOENT');
  assert.equal(clean('claude exited 1: here is what you asked about your bank'), 'claude exited 1');
  assert.equal(clean('fetch https://powerspec.tail.ts.net/voice?x=1 refused'), 'fetch <url> refused');
  assert.equal(clean('no route to 100.64.1.2'), 'no route to <ip>');
  assert.equal(clean('mail stephen@example.com'), 'mail <email>');
  assert.equal(clean('cannot open C:\\Users\\steph\\Projects\\a.txt'), 'cannot open <path>');
  assert.equal(clean('cannot open /home/user/x'), 'cannot open <path>');
  assert.equal(clean('bad token sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'), 'bad token <redacted>');
  assert.equal(clean('x'.repeat(500)).length <= 160, true);
  assert.equal(clean(undefined), '');
});

test('frames are oldest first, with file names only', () => {
  const stack = 'Error: boom\n    at inner (C:\\Users\\steph\\Projects\\relay\\relay.mjs:10:5)\n    at file:///home/user/x/outer.mjs:20:3\n    at node:internal/process/task_queues:95:5';
  assert.deepEqual(frames(stack), [
    { function: '?', filename: 'task_queues', lineno: 95, colno: 5, in_app: false },
    { function: '?', filename: 'outer.mjs', lineno: 20, colno: 3, in_app: true },
    { function: 'inner', filename: 'relay.mjs', lineno: 10, colno: 5, in_app: true },
  ]);
});

test('toEvent sends the type, a cleaned message, code and status, and no user or request', () => {
  const e = Object.assign(new Error('OpenAI 401: {"error":"bad key sk-abc"}'), { code: 'ERR_X', $metadata: { httpStatusCode: 503 } });
  const ev = toEvent(e, 'voice tts', { environment: 'relay', now: 1_000_000 });
  assert.equal(ev.exception.values[0].type, 'Error');
  assert.equal(ev.exception.values[0].value, 'OpenAI 401');
  assert.deepEqual(ev.tags, { where: 'voice tts', code: 'ERR_X', status: '503' });
  assert.equal(ev.timestamp, 1000);
  assert.equal(ev.environment, 'relay');
  assert.match(ev.event_id, /^[0-9a-f]{32}$/);
  for (const k of ['user', 'request', 'extra', 'breadcrumbs', 'server_name']) assert.equal(k in ev, false, k);
  assert.equal(toEvent('a string', 'x').exception.values[0].value, 'a string');
  assert.equal(toEvent(undefined, 'x').exception.values[0].value, 'non-Error thrown');
});

function fakeFetch(status = 200) {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); if (status === 'throw') throw new TypeError('fetch failed'); return { ok: status < 300, status }; };
  return { calls, fetch };
}

test('makeSentry posts an envelope with the auth header, and is off without a DSN', async () => {
  const off = makeSentry({});
  assert.equal(off.enabled, false);
  await off.capture(new Error('x'), 'y');

  const { calls, fetch } = fakeFetch();
  const s = makeSentry({ dsn: DSN, environment: 'cloud', fetch, now: () => 5_000_000 });
  await s.capture(new Error('boom'), 'GET /voice/inbox');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://o123.ingest.us.sentry.io/api/456/envelope/');
  assert.equal(calls[0].opts.redirect, 'error');
  assert.match(calls[0].opts.headers['x-sentry-auth'], /sentry_key=0123456789abcdef0123456789abcdef/);
  const [head, item, event] = calls[0].opts.body.split('\n').map((l) => JSON.parse(l));
  assert.equal(head.dsn, DSN);
  assert.deepEqual(item, { type: 'event' });
  assert.equal(event.event_id, head.event_id);
  assert.equal(event.tags.where, 'GET /voice/inbox');
  assert.equal(event.environment, 'cloud');
});

test('a bad DSN is logged and turns reports off', () => {
  const lines = [];
  const s = makeSentry({ dsn: 'nope', log: (...a) => lines.push(a.join(' ')) });
  assert.equal(s.enabled, false);
  assert.match(lines[0], /not a Sentry DSN/);
});

test('the same error is sent once a minute, and 30 an hour in all', async () => {
  let t = 7_200_000;
  const { calls, fetch } = fakeFetch();
  const s = makeSentry({ dsn: DSN, fetch, now: () => t, perHour: 3 });
  await s.capture(new Error('same'), 'here');
  await s.capture(new Error('same'), 'here');
  assert.equal(calls.length, 1);
  t += 61_000;
  await s.capture(new Error('same'), 'here');
  await s.capture(new Error('other'), 'here');
  await s.capture(new Error('third'), 'here');
  assert.equal(calls.length, 3);
  t += 3600_000;
  await s.capture(new Error('third'), 'here');
  assert.equal(calls.length, 4);
});

test('a failed post is logged without the DSN and never thrown', async () => {
  const lines = [];
  for (const status of [500, 'throw']) {
    const { fetch } = fakeFetch(status);
    const s = makeSentry({ dsn: DSN, fetch, log: (...a) => lines.push(a.join(' ')) });
    await s.capture(new Error('x'), 'y');
  }
  assert.deepEqual(lines, ['Sentry answered 500', 'Sentry report failed: TypeError']);
});

test('flush waits for reports in flight, and no longer than its limit', async () => {
  let release;
  const fetch = () => new Promise((r) => { release = () => r({ ok: true, status: 200 }); });
  const s = makeSentry({ dsn: DSN, fetch });
  s.capture(new Error('x'), 'y');
  let done = false;
  const f = s.flush(1000).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false);
  release();
  await f;
  assert.equal(done, true);
  s.capture(new Error('z'), 'y');   // never answers
  const started = Date.now();
  const alive = setInterval(() => {}, 1000);   // flush's own timer doesn't hold the process open
  await s.flush(50);
  clearInterval(alive);
  assert.ok(Date.now() - started < 500);
});
