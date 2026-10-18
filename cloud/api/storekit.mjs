// Bridge Pro, checked by Bridge Cloud rather than taken on the app's word. The app sends StoreKit 2's signed
// transaction (a JWS) to POST /api/pro; App Store Server Notifications v2 report renewals and refunds. Both are
// signed by Apple with an x5c chain ending at Apple Root CA - G3, so checking them needs no App Store Connect
// key: only Apple's root, pinned here by fingerprint (public, https://www.apple.com/certificateauthority/).
// Dependencies are passed in, so tests run with their own root and no network.
import { X509Certificate, verify as cryptoVerify } from 'node:crypto';

export const APPLE_ROOT_CA_G3 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
// Marker extensions Apple puts on the App Store signing certificate and on its intermediate (DER of the OIDs
// 1.2.840.113635.100.6.11.1 and 1.2.840.113635.100.6.2.1), so no other certificate under Apple's root passes.
export const LEAF_OID = Buffer.from('060a2a864886f76364060b01', 'hex');
export const INTERMEDIATE_OID = Buffer.from('060a2a864886f76364060201', 'hex');
const PRO_PRODUCT = /^com\.smitherman\.glassesrelay\.pro\./;
const ENVIRONMENTS = new Set(['Production', 'Sandbox']);   // App Review and TestFlight buy in the sandbox

const parse = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** The payload of a JWS Apple signed (a transaction, or a notification), after checking its chain and signature. */
export function verifyAppleJws(jws, { root = APPLE_ROOT_CA_G3, now = Date.now() } = {}) {
  const [h, p, s, extra] = String(jws || '').split('.');
  if (!s || extra !== undefined) throw new Error('not a signed transaction');
  const header = parse(h);
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw new Error('unexpected header');
  const [leaf, mid, top] = header.x5c.map((c) => new X509Certificate(Buffer.from(String(c), 'base64')));
  if (top.fingerprint256 !== root) throw new Error('not signed by Apple');
  if (!mid.ca || !top.ca || !leaf.raw.includes(LEAF_OID) || !mid.raw.includes(INTERMEDIATE_OID)) throw new Error('not an App Store certificate');
  if (!leaf.checkIssued(mid) || !leaf.verify(mid.publicKey) || !mid.checkIssued(top) || !mid.verify(top.publicKey)) {
    throw new Error('broken certificate chain');
  }
  if (!cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) {
    throw new Error('bad signature');
  }
  const payload = parse(p);
  // A transaction can be a year old (a yearly plan), so the certificates are checked as of when Apple signed it.
  const at = Number(payload.signedDate) || now;
  if (at > now + 5 * 60_000) throw new Error('signed in the future');
  if (![leaf, mid, top].every((c) => Date.parse(c.validFrom) <= at && at <= Date.parse(c.validTo))) throw new Error('certificate expired');
  return payload;
}

/**
 * deps.bundleId: the app's bundle ID
 * deps.store: {
 *   owner(tx) -> { user?, revoked?: Set|array of transaction IDs } | null   (pk PRO#<originalTransactionId>)
 *   claim(tx, user) -> false when another account holds tx
 *   revoke(tx, transactionId) -> the user holding tx, or null
 *   getPro(user) -> { until, tx, transactionId } | null
 *   setPro(user, entitlement)   (keeps the latest `until`)
 *   dropPro(user, transactionId)   (only while that transaction is the stored one)
 * }
 * deps.verify(jws, { now }) -> payload (verifyAppleJws), deps.now() -> ms
 */
export function makePro(deps) {
  const now = deps.now ?? Date.now;
  const verify = deps.verify ?? verifyAppleJws;

  function entitlement(t) {
    if (t.bundleId !== deps.bundleId) throw new Error('another app');
    if (!PRO_PRODUCT.test(t.productId ?? '')) throw new Error('not Bridge Pro');
    if (!ENVIRONMENTS.has(t.environment)) throw new Error('unexpected environment');
    if (!t.originalTransactionId || !t.transactionId) throw new Error('no transaction ID');
    return {
      tx: String(t.originalTransactionId), transactionId: String(t.transactionId), product: t.productId,
      env: t.environment, until: t.revocationDate ? 0 : Number(t.expiresDate) || 0,
    };
  }

  const revokedIn = (owner, id) => [...(owner?.revoked ?? [])].includes(id);

  /** POST /api/pro: the app's latest Bridge Pro transaction, for this account. */
  async function claim(user, jws) {
    let e;
    try { e = entitlement(verify(jws, { now: now() })); }
    catch (err) { return { status: 400, body: { error: `That isn't a Bridge Pro purchase: ${err.message}.` } }; }
    // One subscription, one Bridge account: a signed transaction handed to someone else doesn't unlock theirs.
    if (!await deps.store.claim(e.tx, user)) {
      return { status: 409, body: { error: 'That subscription belongs to another Bridge account.' } };
    }
    // A refunded transaction stays refunded, even though the copy on the phone still says it's paid.
    if (e.until && !revokedIn(await deps.store.owner(e.tx), e.transactionId)) {
      await deps.store.setPro(user, e);
      // A refund that landed between the check and the write: undo the write.
      if (revokedIn(await deps.store.owner(e.tx), e.transactionId)) await deps.store.dropPro(user, e.transactionId);
    }
    const pro = await isPro(user);
    return { status: 200, body: { pro } };
  }

  /** App Store Server Notifications v2: renewals extend Pro, refunds and revocations end it. */
  async function notify(body) {
    let n, t;
    try {
      n = verify(JSON.parse(body).signedPayload, { now: now() });
      if (!n.data?.signedTransactionInfo) return { status: 200, body: { ignored: n.notificationType } };   // TEST, and others with no transaction
      t = entitlement(verify(n.data.signedTransactionInfo, { now: now() }));
    } catch (err) { return { status: 400, body: { error: err.message } }; }
    if (!t.until) {
      const user = await deps.store.revoke(t.tx, t.transactionId);
      if (user) await deps.store.dropPro(user, t.transactionId);
    } else {
      const owner = await deps.store.owner(t.tx);
      // No owner yet: the app hasn't reported this purchase. It will, and the claim decides whose it is.
      if (owner?.user && !revokedIn(owner, t.transactionId)) await deps.store.setPro(owner.user, t);
    }
    return { status: 200, body: { ok: true } };
  }

  async function isPro(user) {
    const p = await deps.store.getPro(user);
    return Boolean(p && p.until > now());
  }

  return { claim, notify, isPro };
}
