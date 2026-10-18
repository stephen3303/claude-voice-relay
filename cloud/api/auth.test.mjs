import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify, createPublicKey } from 'node:crypto';
import { makeAuth, APPLE_ISSUER } from './auth.mjs';

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
  const auth = makeAuth({
    issuer: ISSUER, audience: AUD, now: () => NOW,
    appleKeys: async () => ({ keys: [{ ...apple.publicKey.export({ format: 'jwk' }), kid: 'apple-1' }] }),
    sign: async (bytes) => createSign('RSA-SHA256').update(bytes).sign(bridge.privateKey),
    publicJwk: async () => bridge.publicKey.export({ format: 'jwk' }),
    deleteUser: async (sub) => deleted.push(sub),
  });
  const call = (method, rawPath, { body, sub } = {}) => auth({
    requestContext: { http: { method }, authorizer: sub ? { jwt: { claims: { sub } } } : undefined },
    rawPath, body: body && JSON.stringify(body),
  });
  return { call, deleted };
}

test('an Apple token becomes a Bridge session the published key verifies', async () => {
  const { call } = setup();
  const r = await call('POST', '/api/auth/apple', { body: { identityToken: appleToken() } });
  assert.equal(r.statusCode, 200);
  const { token, expires } = JSON.parse(r.body);
  const [h, p, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual([claims.iss, claims.aud, claims.sub], [ISSUER, AUD, 'apple.001.abc']);
  assert.equal(expires, claims.exp);

  const jwks = JSON.parse((await call('GET', '/.well-known/jwks.json')).body);
  const key = createPublicKey({ key: jwks.keys[0], format: 'jwk' });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).kid, jwks.keys[0].kid);

  const discovery = JSON.parse((await call('GET', '/.well-known/openid-configuration')).body);
  assert.equal(discovery.issuer, ISSUER);
  assert.equal(discovery.jwks_uri, `${ISSUER}/.well-known/jwks.json`);
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
