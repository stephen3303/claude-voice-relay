import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { verifyAppleJws, makePro, LEAF_OID, INTERMEDIATE_OID } from './storekit.mjs';

// A stand-in for Apple's chain (root, intermediate, App Store leaf), built here so no key is checked in.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => der(0x30, ...p);
const oid = (hex) => Buffer.from(hex, 'hex');   // already DER (06 len ...)
const ECDSA_SHA256 = seq(oid('06082a8648ce3d040302'));
const name = (cn) => seq(der(0x31, seq(oid('0603550403'), der(0x0c, Buffer.from(cn)))));
const time = (ms) => der(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

let serial = 1;
function cert({ cn, issuer, issuerKey, key, ca, marker, from = Date.UTC(2020, 0, 1), to = Date.UTC(2040, 0, 1) }) {
  const exts = [];
  if (ca) exts.push(seq(oid('0603551d13'), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))));
  if (marker) exts.push(seq(marker, der(0x04, Buffer.from([0x05, 0x00]))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([serial++])), ECDSA_SHA256,
    name(issuer), seq(time(from), time(to)), name(cn), key.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(...exts)),
  );
  const sig = sign('sha256', tbs, issuerKey.privateKey);
  return seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sig));
}

const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rootKey = ec(), midKey = ec(), leafKey = ec();
const rootDer = cert({ cn: 'Test Root', issuer: 'Test Root', issuerKey: rootKey, key: rootKey, ca: true });
const midDer = cert({ cn: 'Test WWDR', issuer: 'Test Root', issuerKey: rootKey, key: midKey, ca: true, marker: INTERMEDIATE_OID });
const leafDer = cert({ cn: 'Test StoreKit', issuer: 'Test WWDR', issuerKey: midKey, key: leafKey, marker: LEAF_OID });
const ROOT = new X509Certificate(rootDer).fingerprint256;
const NOW = Date.UTC(2026, 9, 18);
const DAY = 86400_000;

function jws(payload, { chain = [leafDer, midDer, rootDer], key = leafKey } = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: chain.map((c) => c.toString('base64')) })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${s}`;
}

const tx = (over = {}) => ({
  bundleId: 'com.smitherman.glassesrelay', productId: 'com.smitherman.glassesrelay.pro.monthly', environment: 'Production',
  originalTransactionId: '1000', transactionId: '1001', type: 'Auto-Renewable Subscription',
  signedDate: NOW - DAY, purchaseDate: NOW - DAY, expiresDate: NOW + 29 * DAY, ...over,
});

const check = (token) => verifyAppleJws(token, { root: ROOT, now: NOW });

test('a transaction signed through the pinned root is read', () => {
  assert.equal(check(jws(tx())).productId, 'com.smitherman.glassesrelay.pro.monthly');
});

test('anything not signed by the App Store certificate under the pinned root is refused', () => {
  assert.throws(() => verifyAppleJws(jws(tx()), { now: NOW }), /not signed by Apple/, "the real Apple root isn't this test root");
  const token = jws(tx());
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify(tx({ expiresDate: NOW + 999 * DAY }))).toString('base64url')}.${s}`;
  assert.throws(() => check(forged), /bad signature/);
  assert.throws(() => check(jws(tx(), { key: ec() })), /bad signature/, 'signed with a key that is not the leaf');
  // A certificate the intermediate issued for something else (no App Store marker) can't sign transactions.
  const otherKey = ec();
  const other = cert({ cn: 'Test Developer', issuer: 'Test WWDR', issuerKey: midKey, key: otherKey });
  assert.throws(() => check(jws(tx(), { chain: [other, midDer, rootDer], key: otherKey })), /not an App Store certificate/);
  // A leaf that claims the marker but was signed by its own key, not the intermediate.
  const selfKey = ec();
  const self = cert({ cn: 'Test StoreKit', issuer: 'Test WWDR', issuerKey: selfKey, key: selfKey, marker: LEAF_OID });
  assert.throws(() => check(jws(tx(), { chain: [self, midDer, rootDer], key: selfKey })), /broken certificate chain/);
  assert.throws(() => check('a.b'), /not a signed transaction/);
  assert.throws(() => check(jws(tx(), { chain: [leafDer, rootDer] })), /unexpected header/);
});

test('certificates are checked as of when Apple signed', () => {
  assert.throws(() => check(jws(tx({ signedDate: Date.UTC(2041, 0, 1) }))), /signed in the future/);
  assert.throws(() => verifyAppleJws(jws(tx({ signedDate: Date.UTC(2041, 0, 1) })), { root: ROOT, now: Date.UTC(2042, 0, 1) }), /certificate expired/);
  assert.ok(verifyAppleJws(jws(tx()), { root: ROOT, now: Date.UTC(2041, 0, 1) }), 'an old transaction outlives its certificate');
});

function setup() {
  let clock = NOW;
  const owners = new Map(), pros = new Map();
  const store = {
    owner: async (t) => owners.get(t) ?? null,
    claim: async (t, user) => {
      const o = owners.get(t) ?? { revoked: new Set() };
      if (o.user && o.user !== user) return false;
      owners.set(t, { ...o, user }); return true;
    },
    revoke: async (t, id) => {
      const o = owners.get(t) ?? { revoked: new Set() };
      o.revoked.add(id); owners.set(t, o); return o.user ?? null;
    },
    getPro: async (u) => pros.get(u) ?? null,
    setPro: async (u, e) => { if (!(pros.get(u)?.until >= e.until)) pros.set(u, e); },
    dropPro: async (u, id) => { if (pros.get(u)?.transactionId === id) pros.delete(u); },
  };
  const pro = makePro({ store, bundleId: 'com.smitherman.glassesrelay', now: () => clock, verify: (t, o) => verifyAppleJws(t, { ...o, root: ROOT }) });
  const notice = (type, t) => JSON.stringify({ signedPayload: jws({ notificationType: type, signedDate: clock, data: { signedTransactionInfo: jws(t) } }) });
  return { pro, owners, pros, notice, advance: (ms) => (clock += ms) };
}

test("the app's transaction makes the account Pro until it expires", async () => {
  const { pro, advance } = setup();
  assert.equal(await pro.isPro('u1'), false);
  const r = await pro.claim('u1', jws(tx()));
  assert.deepEqual(r, { status: 200, body: { pro: true } });
  assert.equal(await pro.isPro('u1'), true);
  advance(30 * DAY);
  assert.equal(await pro.isPro('u1'), false);
});

test("a purchase can't be lent: another account, another app or another product is refused", async () => {
  const { pro } = setup();
  await pro.claim('u1', jws(tx()));
  assert.equal((await pro.claim('u2', jws(tx()))).status, 409);
  assert.equal(await pro.isPro('u2'), false);
  assert.equal((await pro.claim('u2', jws(tx({ originalTransactionId: '2000', bundleId: 'com.example.other' })))).status, 400);
  assert.equal((await pro.claim('u2', jws(tx({ originalTransactionId: '2000', productId: 'com.smitherman.glassesrelay.tip' })))).status, 400);
  assert.equal((await pro.claim('u2', jws(tx({ originalTransactionId: '2000', environment: 'Xcode' })))).status, 400);
  assert.equal((await pro.claim('u2', 'junk')).status, 400);
  assert.equal((await pro.claim('u2', jws(tx({ originalTransactionId: '2000', environment: 'Sandbox' })))).status, 200, 'App Review buys in the sandbox');
});

test('a renewal notification extends Pro without the app', async () => {
  const { pro, notice, advance } = setup();
  await pro.claim('u1', jws(tx()));
  advance(29 * DAY);
  assert.equal((await pro.notify(notice('DID_RENEW', tx({ transactionId: '1002', signedDate: NOW + 29 * DAY, expiresDate: NOW + 59 * DAY })))).status, 200);
  advance(2 * DAY);
  assert.equal(await pro.isPro('u1'), true);
});

test("a refund ends Pro, and the phone's old copy of the transaction can't bring it back", async () => {
  const { pro, notice } = setup();
  await pro.claim('u1', jws(tx()));
  await pro.notify(notice('REFUND', tx({ revocationDate: NOW, signedDate: NOW })));
  assert.equal(await pro.isPro('u1'), false);
  assert.deepEqual((await pro.claim('u1', jws(tx()))).body, { pro: false });
  // Subscribing again is a new transaction, and works.
  await pro.claim('u1', jws(tx({ transactionId: '1003', expiresDate: NOW + 30 * DAY })));
  assert.equal(await pro.isPro('u1'), true);
});

test("a refund before the app reported the purchase still sticks; notifications don't pick the owner", async () => {
  const { pro, notice, pros } = setup();
  await pro.notify(notice('DID_RENEW', tx()));
  assert.equal(pros.size, 0);
  await pro.notify(notice('REFUND', tx({ revocationDate: NOW })));
  assert.deepEqual((await pro.claim('u1', jws(tx()))).body, { pro: false });
});

test('notifications without a transaction are fine, and forged ones are refused', async () => {
  const { pro } = setup();
  assert.equal((await pro.notify(JSON.stringify({ signedPayload: jws({ notificationType: 'TEST', signedDate: NOW, data: {} }) }))).status, 200);
  assert.equal((await pro.notify('{"signedPayload":"x.y.z"}')).status, 400);
  assert.equal((await pro.notify('nope')).status, 400);
  assert.equal((await pro.notify(JSON.stringify({ signedPayload: 'x'.repeat(70_000) }))).status, 400);
});

test('a refund that lands while the app is reporting the same transaction still ends Pro', async () => {
  const { pro, owners, pros } = setup();
  const t = jws(tx());
  await pro.claim('u1', t);
  pros.clear();
  // Reads: the claim, the check before setPro, the check after it. The refund lands between the last two.
  const o = owners.get('1000');
  let reads = 0;
  owners.get = function (k) { reads++; if (reads === 3) o.revoked.add('1001'); return Map.prototype.get.call(this, k); };
  await pro.claim('u1', t);
  assert.equal(await pro.isPro('u1'), false);
});
