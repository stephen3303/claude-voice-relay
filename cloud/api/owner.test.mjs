import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOwner, tokenHash, OWNER } from './owner.mjs';
import { makeAuth } from './auth.mjs';

const TOKEN = 'ab'.repeat(32);

test('the owner token matches its stored hash, and nothing else does', async () => {
  let reads = 0;
  const check = makeOwner({ secret: async () => { reads++; return { tokenHash: tokenHash(TOKEN) }; } });
  assert.equal(await check(TOKEN), true);
  assert.equal(await check(TOKEN.toUpperCase()), false);
  assert.equal(await check('cd'.repeat(32)), false);
  assert.equal(reads, 1, 'read once, not per request');
});

test('a short token never reads the secret', async () => {
  let reads = 0;
  const check = makeOwner({ secret: async () => { reads++; return { tokenHash: tokenHash(TOKEN) }; } });
  assert.equal(await check('abc123'), false);
  assert.equal(await check(''), false);
  assert.equal(reads, 0);
});

test('any printable VOICE_TOKEN works, as on the relay (base64 with + / =)', async () => {
  const voice = 'k3J+9/aQz8PmV2xWb7Lr0tYc=';
  const check = makeOwner({ secret: async () => ({ tokenHash: tokenHash(voice) }) });
  assert.equal(await check(voice), true);
  assert.equal(await check('eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'), false);
});

test('with no owner set up nobody is the owner, and a later setup works within minutes', async () => {
  let stored = null, reads = 0, clock = 0;
  const check = makeOwner({ secret: async () => { reads++; return stored; }, now: () => clock });
  assert.equal(await check(TOKEN), false);
  assert.equal(await check(TOKEN), false);
  assert.equal(reads, 1, 'a missing secret is not read on every request');
  stored = { tokenHash: tokenHash(TOKEN) };
  clock += 5 * 60_000;
  assert.equal(await check(TOKEN), true);
});

test('a failed read refuses instead of throwing', async () => {
  const check = makeOwner({ secret: async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); } });
  assert.equal(await check(TOKEN), false);
});

test('the authorizer lets the owner token in as the owner', async () => {
  const check = makeOwner({ secret: async () => ({ tokenHash: tokenHash(TOKEN) }) });
  const { authorize } = makeAuth({ issuer: 'https://talktobridge.com', audience: 'com.talktobridge.bridge', isOwner: check,
    appleKeys: async () => ({ keys: [] }), sign: async () => Buffer.alloc(0), publicJwk: async () => null, deleteUser: async () => {} });
  assert.deepEqual(await authorize({ headers: { authorization: `Bearer ${TOKEN}` } }), { isAuthorized: true, context: { sub: OWNER } });
  assert.deepEqual(await authorize({ headers: { authorization: `Bearer ${'cd'.repeat(32)}` } }), { isAuthorized: false });
});

test("the owner's Apple account maps to OWNER; other accounts and a missing or odd appleSub don't", async () => {
  const check = makeOwner({ secret: async () => ({ tokenHash: tokenHash(TOKEN), appleSub: 'apple.001.abc' }) });
  assert.equal(await check.userFor('apple.001.abc'), OWNER);
  assert.equal(await check.userFor('apple.002.xyz'), 'apple.002.xyz');
  assert.equal(await makeOwner({ secret: async () => ({ tokenHash: tokenHash(TOKEN) }) }).userFor('apple.001.abc'), 'apple.001.abc');
  assert.equal(await makeOwner({ secret: async () => ({ appleSub: 'owner' }) }).userFor('owner'), 'owner');
  assert.equal(await makeOwner({ secret: async () => ({ appleSub: '' }) }).userFor(''), '');
  assert.equal(await makeOwner({ secret: async () => null }).userFor('apple.001.abc'), 'apple.001.abc');
  assert.equal(await makeOwner({ secret: async () => { throw Object.assign(new Error('x'), { name: 'AccessDenied' }); } }).userFor('apple.001.abc'), 'apple.001.abc');
});

test('a changed secret is picked up within minutes, and a failed read keeps the last one', async () => {
  let stored = { tokenHash: tokenHash(TOKEN) }, fail = false, clock = 0;
  const check = makeOwner({ secret: async () => { if (fail) throw Object.assign(new Error('x'), { name: 'ThrottlingException' }); return stored; }, now: () => clock });
  assert.equal(await check.userFor('apple.001.abc'), 'apple.001.abc');
  stored = { tokenHash: tokenHash(TOKEN), appleSub: 'apple.001.abc' };
  assert.equal(await check.userFor('apple.001.abc'), 'apple.001.abc', 'not before the next read');
  clock += 5 * 60_000;
  assert.equal(await check.userFor('apple.001.abc'), OWNER);
  fail = true;
  clock += 5 * 60_000;
  assert.equal(await check(TOKEN), true);
  assert.equal(await check.userFor('apple.001.abc'), OWNER);
});
