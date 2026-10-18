import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { makeAuth, APPLE_ISSUER, userOf } from './auth.mjs';

const AUD = 'com.smitherman.glassesrelay';
const ISSUER = 'https://api.example.com';
const apple = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bridge = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1_800_000_000_000;

function jwt(claims, { key = apple.privateKey, kid = 'apple-1' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', kid })}.${enc(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}
const appleToken = (over = {}) => jwt({ iss: APPLE_ISSUER, aud: AUD, sub: '001.abc', exp: NOW / 1000 + 600, ...over });

function setup() {
  const deleted = [];
  let clock = NOW;
  const { auth, authorize } = makeAuth({
    issuer: ISSUER, audience: AUD, now: () => clock,
    appleKeys: async () => ({ keys: [{ ...apple.publicKey.export({ format: 'jwk' }), kid: 'apple-1' }] }),
    sign: async (bytes) => createSign('RSA-SHA256').update(bytes).sign(bridge.privateKey),
    publicJwk: async () => bridge.publicKey.export({ format: 'jwk' }),
    deleteUser: async (sub) => deleted.push(sub),
  });
  const call = (method, rawPath, { body, sub } = {}) => auth({
    requestContext: { http: { method }, authorizer: sub ? { lambda: { sub } } : undefined },
    rawPath, body: body && JSON.stringify(body),
  });
  const signIn = async () => JSON.parse((await call('POST', '/api/auth/apple', { body: { identityToken: appleToken() } })).body);
  return { call, authorize, signIn, deleted, advance: (ms) => (clock += ms) };
}

test('an Apple token becomes a Bridge session the authorizer accepts', async () => {
  const { authorize, signIn } = setup();
  const { token, expires } = await signIn();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.deepEqual([claims.iss, claims.aud, claims.sub], [ISSUER, AUD, 'apple.001.abc']);
  assert.equal(expires, claims.exp);
  assert.deepEqual(await authorize({ headers: { authorization: `Bearer ${token}` } }),
    { isAuthorized: true, context: { sub: 'apple.001.abc' } });
});

test('the authorizer refuses missing, forged, Apple and expired tokens', async () => {
  const { authorize, signIn, advance } = setup();
  const { token } = await signIn();
  const forged = token.slice(0, token.lastIndexOf('.')) + '.' + Buffer.from('nope').toString('base64url');
  for (const authorization of [undefined, 'Bearer junk', `Bearer ${forged}`, `Bearer ${appleToken()}`]) {
    assert.equal((await authorize({ headers: { authorization } })).isAuthorized, false, String(authorization));
  }
  advance(31 * 86400_000);
  assert.equal((await authorize({ headers: { authorization: `Bearer ${token}` } })).isAuthorized, false);
});

test('bad Apple tokens are refused', async () => {
  const { call } = setup();
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const identityToken of [
    undefined, 'junk',
    appleToken({ aud: 'com.someone.else' }),
    appleToken({ iss: 'https://evil.example' }),
    appleToken({ exp: NOW / 1000 - 1 }),
    jwt({ iss: APPLE_ISSUER, aud: AUD, sub: 'x', exp: NOW / 1000 + 600 }, { key: other.privateKey }),
    jwt({ iss: APPLE_ISSUER, aud: AUD, sub: 'x', exp: NOW / 1000 + 600 }, { kid: 'nope' }),
  ]) {
    assert.equal((await call('POST', '/api/auth/apple', { body: { identityToken } })).statusCode, 401, String(identityToken));
  }
});

test('refresh and delete need a session', async () => {
  const { call, deleted } = setup();
  assert.equal((await call('POST', '/api/auth/refresh')).statusCode, 401);
  assert.equal((await call('POST', '/api/auth/refresh', { sub: 'apple.1' })).statusCode, 200);
  assert.equal((await call('DELETE', '/api/account', { sub: 'apple.1' })).statusCode, 200);
  assert.deepEqual(deleted, ['apple.1']);
});

test('userOf reads either authorizer', () => {
  assert.equal(userOf({ requestContext: { authorizer: { lambda: { sub: 'a' } } } }), 'a');
  assert.equal(userOf({ requestContext: { authorizer: { jwt: { claims: { sub: 'b' } } } } }), 'b');
  assert.equal(userOf({ requestContext: {} }), undefined);
});
