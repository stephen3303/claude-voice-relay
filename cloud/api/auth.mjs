// Bridge Cloud accounts: Sign in with Apple. The app sends Apple's identity token; this checks it
// against Apple's keys and answers with a Bridge session token (RS256, 30 days), signed by a KMS
// key that never leaves AWS. `authorize` is API Gateway's Lambda authorizer: it checks sessions
// with the key's public half and hands the routes `sub`.
// Dependencies are passed in, so tests run with fakes and no network.
import { createPublicKey, createVerify } from 'node:crypto';
import { OWNER } from './owner.mjs';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const SESSION_DAYS = 30;

export const KID = 'bridge-1';   // the KMS session key, as the kid of every token Bridge signs

const b64url = (b) => Buffer.from(b).toString('base64url');
const parse = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** An RS256 token over `claims`, signed by sign(bytes) (KMS). */
export async function signJwt(claims, sign) {
  const body = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${b64url(await sign(Buffer.from(body)))}`;
}

/** Checks an RS256 token's signature with keyFor(kid), then its issuer, audience and expiry; answers its claims. */
export async function verifyJwt(token, keyFor, { issuer, audience, now = Date.now() }) {
  const [h, p, s] = String(token || '').split('.');
  if (!s) throw new Error('not a token');
  const header = parse(h), claims = parse(p);
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  const jwk = await keyFor(header.kid);
  if (!jwk) throw new Error('unknown key');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`)
    .verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (claims.iss !== issuer) throw new Error('wrong issuer');
  if (claims.aud !== audience) throw new Error('wrong audience');
  if (!(claims.exp * 1000 > now)) throw new Error('expired');
  if (!claims.sub) throw new Error('no subject');
  return claims;
}

/** The signed-in user, as either authorizer leaves it on the request. */
export const userOf = (event) =>
  event.requestContext?.authorizer?.lambda?.sub ?? event.requestContext?.authorizer?.jwt?.claims?.sub;

/**
 * deps.issuer: the session tokens' iss
 * deps.audience: the app's bundle ID (Apple tokens' aud; also the sessions' aud)
 * deps.appleKeys() -> Apple's JWK set { keys: [...] }
 * deps.sign(bytes) -> RS256 signature bytes (KMS)
 * deps.publicJwk() -> the signing key as a JWK (n, e)
 * deps.deleteUser(sub) -> removes everything stored for the account
 * deps.isOwner(bearer) -> true for the owner token (owner.mjs), optional
 * deps.now() -> ms
 */
export function makeAuth(deps) {
  const now = deps.now ?? Date.now;

  const verify = (token, keyFor, issuer) => verifyJwt(token, keyFor, { issuer, audience: deps.audience, now: now() });

  const appleKey = async (kid) => (await deps.appleKeys()).keys.find((k) => k.kid === kid);
  const sessionKey = async (kid) => (kid === KID ? deps.publicJwk() : null);

  async function session(sub) {
    const iat = Math.floor(now() / 1000);
    const exp = iat + SESSION_DAYS * 86400;
    return { token: await signJwt({ iss: deps.issuer, aud: deps.audience, sub, iat, exp }, deps.sign), expires: exp };
  }

  // API Gateway Lambda authorizer (payload 2.0, simple responses).
  async function authorize(event) {
    const header = event.headers?.authorization ?? event.identitySource?.[0] ?? '';
    try {
      const bearer = header.replace(/^Bearer\s+/i, '');
      if (deps.isOwner && await deps.isOwner(bearer)) return { isAuthorized: true, context: { sub: OWNER } };
      const claims = await verify(header.replace(/^Bearer\s+/i, ''), sessionKey, deps.issuer);
      return { isAuthorized: true, context: { sub: claims.sub } };
    } catch {
      return { isAuthorized: false };
    }
  }

  async function auth(event) {
    const route = `${event.requestContext.http.method} ${event.rawPath}`;
    try {
      if (route === 'POST /api/auth/apple') {
        let body = {};
        try { body = JSON.parse(Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8').toString('utf8')); } catch { /* empty */ }
        let claims;
        try { claims = await verify(body.identityToken, appleKey, APPLE_ISSUER); }
        catch (e) { return json(401, { error: `Sign in with Apple failed: ${e.message}` }); }
        // Apple's sub is stable per developer team; prefix it so other sign-in kinds can't collide.
        return json(200, await session(`apple.${claims.sub}`));
      }
      // The routes below sit behind the authorizer: a valid session got this far.
      const sub = userOf(event);
      if (!sub) return json(401, { error: 'Sign in to Bridge first.' });
      if (route === 'POST /api/auth/refresh') return json(200, await session(sub));
      if (route === 'DELETE /api/account') { await deps.deleteUser(sub); return json(200, { deleted: true }); }
      return json(404, { error: 'Not found.' });
    } catch (e) {
      console.error(route, e);
      return json(500, { error: 'Bridge Cloud hit an error. Try again in a moment.' });
    }
  }

  return { auth, authorize };
}

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
