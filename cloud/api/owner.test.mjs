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
  assert.equal(reads, 1, 'read once per container');
});

test('a session token or a short token never reads the secret', async () => {
  let reads = 0;
  const check = makeOwner({ secret: async () => { reads++; return { tokenHash: tokenHash(TOKEN) }; } });
  assert.equal(await check('eyJhbGciOi.eyJzdWIi.c2ln'), false);
  assert.equal(await check('abc123'), false);
  assert.equal(await check(''), false);
  assert.equal(reads, 0);
});

test('with no owner set up nobody is the owner, and a later setup works without a restart', async () => {
  let stored = null;
  const check = makeOwner({ secret: async () => stored });
  assert.equal(await check(TOKEN), false);
  stored = { tokenHash: tokenHash(TOKEN) };
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
