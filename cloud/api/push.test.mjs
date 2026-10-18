import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { makeApns, makeNotifier, APNS_HOSTS, LISTENING_MS } from './push.mjs';

const BUNDLE = 'com.talktobridge.bridge';
const apnsKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = apnsKey.privateKey.export({ type: 'pkcs8', format: 'pem' });
const TOKEN = 'ab'.repeat(32), VOIP = 'cd'.repeat(32);

function setupApns(answer = () => ({ status: 200 })) {
  let clock = 1_800_000_000_000;
  const sent = [];
  const apns = makeApns({
    teamId: 'TEAM123', keyId: 'KEY123', key: PEM, bundleId: BUNDLE, now: () => clock,
    send: async (host, path, headers, body) => { sent.push({ host, path, headers, body: JSON.parse(body) }); return answer(host, sent.length); },
  });
  return { apns, sent, advance: (ms) => (clock += ms) };
}

test('pushes carry a provider token Apple can verify, renewed after 50 minutes', async () => {
  const { apns, sent, advance } = setupApns();
  await apns(TOKEN, 'production', 'alert', { aps: { alert: 'hi' } });
  await apns(TOKEN, 'production', 'alert', { aps: { alert: 'hi' } });
  const [h, p, s] = sent[0].headers.authorization.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, 'TEAM123');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: apnsKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(sent[1].headers.authorization, sent[0].headers.authorization);   // reused, not re-signed per push
  advance(51 * 60_000);
  await apns(TOKEN, 'production', 'alert', {});
  assert.notEqual(sent[2].headers.authorization, sent[0].headers.authorization);
});

test('a call is a VoIP push on the .voip topic that never waits; a notification is an alert', async () => {
  const { apns, sent } = setupApns();
  assert.deepEqual(await apns(VOIP, 'production', 'call', { from: 'app' }), { result: 'ok', env: 'production' });
  await apns(TOKEN, 'sandbox', 'alert', {});
  assert.equal(sent[0].host, APNS_HOSTS.production);
  assert.equal(sent[0].path, `/3/device/${VOIP}`);
  assert.equal(sent[0].headers['apns-topic'], `${BUNDLE}.voip`);
  assert.equal(sent[0].headers['apns-push-type'], 'voip');
  assert.equal(sent[0].headers['apns-expiration'], '0');
  assert.equal(sent[1].host, APNS_HOSTS.sandbox);
  assert.equal(sent[1].headers['apns-topic'], BUNDLE);
  assert.equal(sent[1].headers['apns-push-type'], 'alert');
  assert.ok(Number(sent[1].headers['apns-expiration']) > 0);
});

test('a token from the other environment is retried there; dead tokens come back gone', async () => {
  const wrongEnv = setupApns((host) => (host === APNS_HOSTS.sandbox ? { status: 200 } : { status: 400, reason: 'BadDeviceToken' }));
  assert.deepEqual(await wrongEnv.apns(TOKEN, 'production', 'alert', {}), { result: 'ok', env: 'sandbox' });
  assert.deepEqual(wrongEnv.sent.map((s) => s.host), [APNS_HOSTS.production, APNS_HOSTS.sandbox]);

  const unregistered = setupApns(() => ({ status: 410, reason: 'Unregistered' }));
  assert.equal((await unregistered.apns(TOKEN, 'production', 'alert', {})).result, 'gone');
  assert.equal(unregistered.sent.length, 1);

  const bad = setupApns(() => ({ status: 400, reason: 'BadDeviceToken' }));
  assert.equal((await bad.apns(TOKEN, 'production', 'alert', {})).result, 'gone');

  const otherApp = setupApns(() => ({ status: 400, reason: 'DeviceTokenNotForTopic' }));
  assert.equal((await otherApp.apns(TOKEN, 'production', 'alert', {})).result, 'gone');
  assert.equal(otherApp.sent.length, 1);

  const down = setupApns(() => ({ status: 500, reason: 'InternalServerError' }));
  assert.equal((await down.apns(TOKEN, 'production', 'alert', {})).result, 'error');
});

function setupNotifier(list, { listenedAt = 0, answer = () => ({ result: 'ok', env: 'production' }) } = {}) {
  const pushes = [], saved = [], removed = [];
  const notify = makeNotifier({
    now: () => 1_000_000_000,
    devices: {
      list: async () => list,
      patch: async (u, id, p) => saved.push({ id, ...p }),
      remove: async (u, id, expect) => removed.push({ id, expect }),
      lastListened: async () => listenedAt,
    },
    apns: async (token, env, kind, payload) => { pushes.push({ token, kind, payload }); return answer(token, kind); },
  });
  return { notify, pushes, saved, removed };
}

const phone = (over = {}) => ({ device: 'p1', token: TOKEN, voipToken: VOIP, env: 'production', headset: true, calls: true, ...over });

test('with glasses or headphones connected and calls allowed, the phone rings', async () => {
  const { notify, pushes } = setupNotifier([phone()]);
  assert.deepEqual(await notify('u1', { text: 'trading bot: done. Merge it?', from: 'trading bot', id: 7 }), [{ device: 'p1', got: 'call' }]);
  assert.deepEqual(pushes, [{ token: VOIP, kind: 'call', payload: { from: 'trading bot', text: 'trading bot: done. Merge it?', id: 7 } }]);
});

test('otherwise it gets a notification that opens a conversation', async () => {
  for (const d of [phone({ headset: false }), phone({ calls: false }), phone({ voipToken: undefined })]) {
    const { notify, pushes } = setupNotifier([d]);
    await notify('u1', { text: 'done', from: 'app', id: 1 });
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].kind, 'alert');
    assert.equal(pushes[0].token, TOKEN);
    assert.deepEqual(pushes[0].payload.aps.alert, { title: 'app', body: 'done' });
    assert.equal(pushes[0].payload.aps.category, 'AGENT_MESSAGE');
  }
});

test('long messages are cut for the notification', async () => {
  const { notify, pushes } = setupNotifier([phone({ headset: false })]);
  await notify('u1', { text: 'x'.repeat(500), id: 1 });
  assert.equal(pushes[0].payload.aps.alert.body.length, 180);
  assert.equal(pushes[0].payload.aps.alert.title, 'Bridge');
});

test('nothing is pushed while a conversation is open', async () => {
  const { notify, pushes } = setupNotifier([phone()], { listenedAt: 1_000_000_000 - LISTENING_MS + 1000 });
  assert.deepEqual(await notify('u1', { text: 'done', id: 1 }), []);
  assert.equal(pushes.length, 0);
});

test('a dead VoIP token falls back to a notification and is forgotten', async () => {
  const { notify, pushes, saved } = setupNotifier([phone()], { answer: (t, kind) => ({ result: kind === 'call' ? 'gone' : 'ok', env: 'production' }) });
  assert.deepEqual(await notify('u1', { text: 'done', id: 1 }), [{ device: 'p1', got: 'alert' }]);
  assert.deepEqual(pushes.map((p) => p.kind), ['call', 'alert']);
  // Only the dead token is dropped, and only if it's still the stored one; nothing else is written back.
  assert.deepEqual(saved, [{ id: 'p1', drop: { voipToken: VOIP } }]);
});

test('a phone whose tokens are all dead is removed; a corrected environment is kept', async () => {
  const dead = setupNotifier([phone()], { answer: () => ({ result: 'gone', env: 'production' }) });
  await dead.notify('u1', { text: 'done', id: 1 });
  assert.deepEqual(dead.removed, [{ id: 'p1', expect: { token: TOKEN, voipToken: VOIP } }]);

  const moved = setupNotifier([phone({ headset: false })], { answer: () => ({ result: 'ok', env: 'sandbox' }) });
  await moved.notify('u1', { text: 'done', id: 1 });
  assert.deepEqual(moved.saved, [{ id: 'p1', env: 'sandbox', drop: {} }]);

  const fine = setupNotifier([phone()]);
  await fine.notify('u1', { text: 'done', id: 1 });
  assert.deepEqual([fine.saved, fine.removed], [[], []]);   // a push that learned nothing writes nothing
});

test('a connection failure for one phone still lets the others get the message', async () => {
  const pushes = [];
  const notify = makeNotifier({
    now: () => 1_000_000_000,
    devices: { list: async () => [phone({ device: 'p1' }), phone({ device: 'p2', headset: false })], patch: async () => {}, remove: async () => {}, lastListened: async () => 0 },
    apns: async (token, env, kind) => {
      pushes.push(kind);
      if (kind === 'call') throw new Error('stream reset');
      return { result: 'ok', env };
    },
  });
  assert.deepEqual(await notify('u1', { text: 'done', id: 1 }), [{ device: 'p1', got: 'alert' }, { device: 'p2', got: 'alert' }]);
  assert.deepEqual(pushes, ['call', 'alert', 'alert']);
});

test('phones are pushed at the same time, not one after another', async () => {
  let inFlight = 0, most = 0;
  const notify = makeNotifier({
    now: () => 1_000_000_000,
    devices: { list: async () => [phone({ device: 'a', headset: false }), phone({ device: 'b', headset: false })], patch: async () => {}, remove: async () => {}, lastListened: async () => 0 },
    apns: async (token, env) => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { result: 'ok', env }; },
  });
  await notify('u1', { text: 'done', id: 1 });
  assert.equal(most, 2);
});
