import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from './voice.mjs';

function setup() {
  const held = new Map(), msgs = new Map(), started = [], looked = [];
  let clock = 1_000_000;
  const store = {
    getHeld: async (u) => held.get(u) ?? null,
    setHeld: async (u, h) => (h ? held.set(u, h) : held.delete(u)),
    addMessage: async (u, text) => { const l = msgs.get(u) ?? []; l.push({ id: l.length + 1, text, at: clock }); msgs.set(u, l); },
    messagesAfter: async (u, after) => (msgs.get(u) ?? []).filter((m) => m.id > after),
  };
  const handler = makeHandler({
    store,
    look: async (jpeg, said) => { looked.push({ size: jpeg.length, said }); return 'A whiteboard with a diagram.'; },
    startTask: async (u, t) => { started.push(t); return 'Sent.'; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const call = (method, path, { body, user = 'u1', query, headers, base64 } = {}) => handler({
    requestContext: { http: { method }, authorizer: user ? { jwt: { claims: { sub: user } } } : undefined },
    rawPath: `/api${path}`, body, isBase64Encoded: !!base64, queryStringParameters: query, headers,
  });
  return { call, started, looked, store, advance: (ms) => (clock += ms) };
}

test('needs a signed-in user', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/voice/confirm', { body: 'hi', user: null })).statusCode, 401);
});

test('a task is read back with its project, then "send it" starts it', async () => {
  const { call, started } = setup();
  const r1 = await call('POST', '/voice/confirm', { body: JSON.stringify({ text: 'task: in trading bot, add a stop-loss check' }) });
  assert.match(r1.body, /^I heard: add a stop-loss check\. That goes to trading bot\./);
  const r2 = await call('POST', '/voice/confirm', { body: 'Send it.' });
  assert.equal(r2.body, 'Sent.');
  assert.deepEqual(started, [{ project: 'trading bot', task: 'add a stop-loss check' }]);
});

test('"send it" with nothing held, cancel, and expiry', async () => {
  const { call, started, advance } = setup();
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /Nothing is waiting/);
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
  assert.match((await call('POST', '/voice/confirm', { body: 'cancel' })).body, /Cancelled/);
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
  advance(11 * 60_000);
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /waited over ten minutes/);
  assert.equal(started.length, 0);
});

test('a task without a project is not held', async () => {
  const { call } = setup();
  assert.match((await call('POST', '/voice/confirm', { body: 'task: fix the bug' })).body, /can't tell which project/);
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /Nothing is waiting/);
});

test('users are kept apart', async () => {
  const { call } = setup();
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login', user: 'a' });
  assert.match((await call('POST', '/voice/confirm', { body: 'send it', user: 'b' })).body, /Nothing is waiting/);
});

test('inbox returns new messages, and waits when there are none', async () => {
  const { call, store } = setup();
  const empty = JSON.parse((await call('GET', '/voice/inbox', { query: { wait: '0' } })).body);
  assert.deepEqual(empty.messages, []);
  await store.addMessage('u1', 'trading bot: done.');
  const r = JSON.parse((await call('GET', '/voice/inbox', { query: { after: '0' } })).body);
  assert.equal(r.last, 1);
  assert.equal(r.messages[0].text, 'trading bot: done.');
  const later = JSON.parse((await call('GET', '/voice/inbox', { query: { after: '1' } })).body);
  assert.deepEqual(later.messages, []);   // waited ~20s of fake time, then answered empty
});

test('a photo gets a quick answer, or goes to a project', async () => {
  const { call, looked, started } = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  const r = await call('POST', '/voice/photo', { body: jpeg, base64: true, headers: { 'x-question': encodeURIComponent('What is this?') } });
  assert.equal(r.body, 'A whiteboard with a diagram.');
  assert.deepEqual(looked, [{ size: 7, said: 'What is this?' }]);
  await call('POST', '/voice/photo', { body: jpeg, base64: true, headers: { 'x-question': encodeURIComponent('send this to app, fix the layout') } });
  assert.equal(started[0].project, 'app');
  assert.equal(started[0].task, 'fix the layout');
  assert.equal(started[0].photo.length, 7);
});

test('send starts the task at once, with or without a project', async () => {
  const { call, started } = setup();
  assert.equal((await call('POST', '/voice/send', { body: JSON.stringify({ text: 'task: in trading bot, add a check.' }) })).body, 'Sent.');
  assert.equal((await call('POST', '/voice/send', { body: 'what is the status' })).body, 'Sent.');
  assert.deepEqual(started, [{ project: 'trading bot', task: 'add a check' }, { project: null, task: 'what is the status' }]);
});

test('unknown routes are 404', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/nope')).statusCode, 404);
});

test('dictation variants of "send it" confirm', async () => {
  for (const said of ['sent it', 'send it please', 'Please send it', 'send that', 'yes, send it']) {
    const { call, started } = setup();
    await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
    assert.equal((await call('POST', '/voice/confirm', { body: `task: ${said}` })).body, 'Sent.', said);
    assert.equal(started.length, 1, said);
  }
});
