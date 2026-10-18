import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from './voice.mjs';

function setup() {
  const budget = new Map(), spoken = [], held = new Map(), msgs = new Map(), started = [], looked = [], devices = new Map(), listening = [], delivered = [];
  const pros = new Set(['u1', 'u2', 'u3']), claims = [];
  let clock = 1_000_000;
  const store = {
    getHeld: async (u) => held.get(u) ?? null,
    setHeld: async (u, h) => (h ? held.set(u, h) : held.delete(u)),
    addMessage: async (u, text) => { const l = msgs.get(u) ?? []; l.push({ id: l.length + 1, text, at: clock }); msgs.set(u, l); },
    messagesAfter: async (u, after) => (msgs.get(u) ?? []).filter((m) => m.id > after),
    spendSpeech: async (key, day, chars, max) => {
      const k = `${key}/${day}`, n = budget.get(k) ?? 0;
      if (n + chars > max) return false;
      budget.set(k, n + chars); return true;
    },
  };
  const handler = makeHandler({
    store,
    look: async (jpeg, said) => { looked.push({ size: jpeg.length, said }); return 'A whiteboard with a diagram.'; },
    startTask: async (u, t) => { started.push(t); return 'Sent.'; },
    devices: {
      save: async (u, d) => devices.set(`${u}/${d.device}`, d),
      remove: async (u, id) => devices.delete(`${u}/${id}`),
      markListening: async (u) => listening.push(u),
      stopListening: async (u) => listening.push(`stop:${u}`),
    },
    deliver: async (u, text, from) => delivered.push({ u, text, from, at: clock }),
    speak: async (text) => { if (text === 'fail') throw new Error('Polly down'); spoken.push(text); return new Uint8Array([0xff, 0xf3, text.length]); },
    pro: {
      isPro: async (u) => pros.has(u),
      claim: async (u, jws) => { claims.push({ u, jws }); return jws === 'good' ? { status: 200, body: { pro: true } } : { status: 400, body: { error: 'no' } }; },
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const call = (method, path, { body, user = 'u1', query, headers, base64 } = {}) => handler({
    requestContext: { http: { method }, authorizer: user ? { jwt: { claims: { sub: user } } } : undefined },
    rawPath: `/api${path}`, body, isBase64Encoded: !!base64, queryStringParameters: query, headers,
  });
  return { call, pros, claims, budget, spoken, started, looked, store, devices, listening, delivered, advance: (ms) => (clock += ms), now: () => clock };
}

test('needs a signed-in user', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/voice/confirm', { body: 'hi', user: null })).statusCode, 401);
});

test('a task is read back with its project, then "send it" starts it', async () => {
  const { call, started } = setup();
  const r1 = await call('POST', '/voice/confirm', { body: JSON.stringify({ text: 'task: in trading bot, add a stop-loss check' }) });
  assert.equal(r1.body, "Here's your message to Claude for trading bot, add a stop-loss check. Ready to send it?");
  const r2 = await call('POST', '/voice/confirm', { body: 'Send it.' });
  assert.equal(r2.body, 'Sent.');
  assert.deepEqual(started, [{ project: 'trading bot', task: 'add a stop-loss check' }]);
});

test('"send it" with nothing held, cancel, and expiry', async () => {
  const { call, started, advance } = setup();
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /nothing to send/);
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
  assert.match((await call('POST', '/voice/confirm', { body: 'cancel' })).body, /won't send it/);
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
  advance(11 * 60_000);
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /waited over ten minutes/);
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /nothing to send/, 'the expired hold is cleared');
  assert.equal(started.length, 0);
});

test('a task without a project is not held', async () => {
  const { call } = setup();
  assert.match((await call('POST', '/voice/confirm', { body: 'task: fix the bug' })).body, /can't tell which project/);
  assert.match((await call('POST', '/voice/confirm', { body: 'send it' })).body, /nothing to send/);
});

test('"change it" keeps the project for the new words, and "no" drops the message', async () => {
  const { call, started } = setup();
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
  assert.equal((await call('POST', '/voice/confirm', { body: 'Change it.' })).body, 'OK. What do you want to tell app?');
  assert.equal((await call('POST', '/voice/confirm', { body: 'send it' })).body, 'What do you want to tell app?');
  assert.equal((await call('POST', '/voice/confirm', { body: 'fix the signup page' })).body,
    "Here's your message to Claude for app, fix the signup page. Ready to send it?");
  assert.equal((await call('POST', '/voice/confirm', { body: 'yes' })).body, 'Sent.');
  assert.deepEqual(started, [{ project: 'app', task: 'fix the signup page' }]);

  await call('POST', '/voice/confirm', { body: 'looks good' });
  assert.equal((await call('POST', '/voice/confirm', { body: 'no' })).body, "OK, I won't send it.");
  assert.equal((await call('POST', '/voice/confirm', { body: 'no' })).body, "Here's your message to Claude, no. Ready to send it?");
  assert.equal(started.length, 1);
});

test('cloud: every reply that waits is a question, and change it with no project asks for new words', async () => {
  const { call, started } = setup();
  const say = async (body) => (await call('POST', '/voice/confirm', { body })).body;
  for (const r of [await say(''), await say('send it'), await say('task: fix the bug'), await say('task: in app, fix login'),
    await say('change it'), await say('yes')]) {
    assert.match(r, /\?/);
  }
  assert.equal(await say('fix the signup page'), "Here's your message to Claude for app, fix the signup page. Ready to send it?");
  assert.equal(await say('nope'), "OK, I won't send it.");
  await say('hello there');
  assert.equal(await say('Change that.'), 'OK. What do you want to send?');
  assert.equal(await say('send it'), "There's nothing to send yet. What do you want to send?");
  assert.equal(await say('change it'), "Here's your message to Claude, change it. Ready to send it?", 'with nothing held it is a message');
  assert.doesNotMatch(await say('cancel it'), /\?/);
  assert.equal(started.length, 0);
});

test('cloud: a bare "go" never sends, and a held project is not re-targeted by "for ..."', async () => {
  const { call, started } = setup();
  const say = async (body) => (await call('POST', '/voice/confirm', { body })).body;
  await say('task: in app, fix login');
  assert.equal(await say('go'), "Here's your message to Claude, go. Ready to send it?");
  assert.equal(started.length, 0);
  await say('task: in app, fix login');
  await say('change it');
  assert.equal(await say('task: for the README, fix typos'), "Here's your message to Claude for app, for the README, fix typos. Ready to send it?");
});

test('users are kept apart', async () => {
  const { call } = setup();
  await call('POST', '/voice/confirm', { body: 'task: in app, fix login', user: 'a' });
  assert.match((await call('POST', '/voice/confirm', { body: 'send it', user: 'b' })).body, /nothing to send/);
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

test('a long inbox poll marks a conversation as open; a one-off check or the end of a conversation does not', async () => {
  const { call, listening, store } = setup();
  await call('GET', '/voice/inbox', { query: { wait: '0' } });
  assert.deepEqual(listening, []);
  await store.addMessage('u1', 'hi');
  await call('GET', '/voice/inbox', { query: { after: '0' } });
  assert.deepEqual(listening, ['u1']);
  assert.equal((await call('DELETE', '/voice/listening')).statusCode, 200);
  assert.deepEqual(listening, ['u1', 'stop:u1']);
});

test('a failed push registration answers with an error the app can retry on', async () => {
  const { call, devices } = setup();
  devices.set = () => { throw new Error('throttled'); };
  const r = await call('POST', '/push/register', { body: JSON.stringify({ device: 'p', token: 'ab'.repeat(32) }) });
  assert.equal(r.statusCode, 500);
});

test('a phone registers its push tokens and headset state, and can unregister', async () => {
  const { call, devices } = setup();
  const body = { device: 'phone-1', token: 'AB'.repeat(32), voipToken: 'cd'.repeat(32), env: 'sandbox', headset: true, calls: true };
  assert.equal((await call('POST', '/push/register', { body: JSON.stringify(body) })).statusCode, 200);
  const d = devices.get('u1/phone-1');
  assert.equal(d.token, 'ab'.repeat(32));   // stored lowercase
  assert.deepEqual([d.env, d.headset, d.calls], ['sandbox', true, true]);
  await call('POST', '/push/register', { body: JSON.stringify({ ...body, headset: false, calls: 'yes', env: 'other' }) });
  assert.deepEqual([devices.get('u1/phone-1').headset, devices.get('u1/phone-1').calls, devices.get('u1/phone-1').env], [false, false, 'production']);
  assert.equal((await call('DELETE', '/push/register', { query: { device: 'phone-1' } })).statusCode, 200);
  assert.equal(devices.size, 0);
});

test('registration needs a device ID and a real token', async () => {
  const { call, devices } = setup();
  for (const body of ['junk', JSON.stringify({ token: 'ab'.repeat(32) }), JSON.stringify({ device: 'p', token: 'not hex' }),
    JSON.stringify({ device: '../x', token: 'ab'.repeat(32) })]) {
    assert.equal((await call('POST', '/push/register', { body })).statusCode, 400, body);
  }
  assert.equal(devices.size, 0);
});

test('a test call waits the asked delay (at most 20s), then rings like an agent', async () => {
  const { call, delivered, now } = setup();
  const start = now();
  await call('POST', '/push/test', { body: JSON.stringify({ delay: 90 }) });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].from, 'Bridge');
  assert.equal(delivered[0].at - start, 20_000);
});

test('dictation variants of "send it" confirm', async () => {
  for (const said of ['sent it', 'send it please', 'Please send it', 'send that', 'yes, send it']) {
    const { call, started } = setup();
    await call('POST', '/voice/confirm', { body: 'task: in app, fix login' });
    assert.equal((await call('POST', '/voice/confirm', { body: `task: ${said}` })).body, 'Sent.', said);
    assert.equal(started.length, 1, said);
  }
});

test('tts answers MP3 as base64, and a failure is a non-200 so the app falls back', async () => {
  const { call, spoken } = setup();
  const r = await call('POST', '/voice/tts', { body: JSON.stringify({ text: ' Hello there. ' }) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'audio/mpeg');
  assert.equal(r.isBase64Encoded, true);
  assert.deepEqual([...Buffer.from(r.body, 'base64')], [0xff, 0xf3, 12]);
  assert.deepEqual(spoken, ['Hello there.']);
  assert.equal((await call('POST', '/voice/tts', { body: '   ' })).statusCode, 400);
  assert.equal((await call('POST', '/voice/tts', { body: 'fail' })).statusCode, 500);
  assert.equal((await call('POST', '/voice/tts', { body: 'hi', user: null })).statusCode, 401);
});

test('tts refunds the budget when nothing was spoken', async () => {
  const { call, budget, now } = setup();
  const day = new Date(now()).toISOString().slice(0, 10);
  await call('POST', '/voice/tts', { body: 'fail' });
  assert.equal(budget.get(`SPEECH#u1/${day}`), 0);
  assert.equal(budget.get(`ALL/${day}`), 0);
  budget.set(`ALL/${day}`, 1_000_000);
  assert.equal((await call('POST', '/voice/tts', { body: 'hello' })).statusCode, 429);
  assert.equal(budget.get(`SPEECH#u1/${day}`), 0, 'the total cap refused it, so u1 is not charged');
});

test('tts refuses JSON without a text string instead of reading it out', async () => {
  const { call, spoken } = setup();
  assert.equal((await call('POST', '/voice/tts', { body: '{"text":null}' })).statusCode, 400);
  assert.equal((await call('POST', '/voice/tts', { body: '{"msg":"hi"}' })).statusCode, 400);
  assert.deepEqual(spoken, []);
});

test('confirm and send treat JSON without a text string as nothing said', async () => {
  const { call, started } = setup();
  assert.match((await call('POST', '/voice/send', { body: '{"msg":"x"}' })).body, /didn't catch that/);
  assert.match((await call('POST', '/voice/confirm', { body: '{"text":null}' })).body, /didn't catch that/);
  assert.match((await call('POST', '/voice/send', { body: 'null' })).body, /didn't catch that/);
  assert.equal(started.length, 0);
});

test('a line over Polly\'s limit is refused whole, so the phone reads all of it', async () => {
  const { call, spoken } = setup();
  assert.equal((await call('POST', '/voice/tts', { body: 'x'.repeat(3001) })).statusCode, 413);
  assert.equal((await call('POST', '/voice/tts', { body: '😀'.repeat(3000) })).statusCode, 200, 'counted in characters, not UTF-16 units');
  assert.equal(spoken.length, 1);
});

test('tts has a daily budget per account and in total', async () => {
  const { call, spoken, budget, advance } = setup();
  const line = 'y'.repeat(3000);
  for (let i = 0; i < 20; i++) assert.equal((await call('POST', '/voice/tts', { body: line })).statusCode, 200);
  assert.equal((await call('POST', '/voice/tts', { body: line })).statusCode, 429, 'u1 used 60,000 today');
  assert.equal((await call('POST', '/voice/tts', { body: line, user: 'u2' })).statusCode, 200, 'others are unaffected');
  assert.equal(spoken.length, 21);
  advance(24 * 3600_000);
  assert.equal((await call('POST', '/voice/tts', { body: line })).statusCode, 200, 'a new day, a new budget');
  budget.set(`ALL/${new Date(1_000_000 + 24 * 3600_000).toISOString().slice(0, 10)}`, 1_000_000);
  assert.equal((await call('POST', '/voice/tts', { body: 'hi', user: 'u3' })).statusCode, 429, 'the total cap holds for everyone');
});

test('tts is for Bridge Pro: anyone else gets a non-200 (the phone voice) and spends nothing', async () => {
  const { call, pros, budget, spoken } = setup();
  pros.delete('u1');
  const r = await call('POST', '/voice/tts', { body: 'hello' });
  assert.equal(r.statusCode, 402);
  assert.equal(spoken.length, 0);
  assert.equal(budget.size, 0);
});

test('POST /pro hands the signed transaction to the Pro check and answers what it says', async () => {
  const { call, claims } = setup();
  const ok = await call('POST', '/pro', { body: JSON.stringify({ transaction: 'good' }) });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { pro: true });
  assert.equal((await call('POST', '/pro', { body: 'not json' })).statusCode, 400);
  assert.deepEqual(claims, [{ u: 'u1', jws: 'good' }, { u: 'u1', jws: undefined }]);
  assert.equal((await call('POST', '/pro', { body: '{}', user: null })).statusCode, 401);
});

test('photos are for Bridge Pro too: Bedrock is never called without it', async () => {
  const { call, pros, looked, started } = setup();
  pros.delete('u1');
  const r = await call('POST', '/voice/photo', { body: Buffer.from('jpegjpg').toString('base64'), base64: true });
  assert.match(r.body, /need Bridge Pro/);
  assert.equal(looked.length + started.length, 0);
});
