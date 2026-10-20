// The owner's account: Stephen's own use of Bridge Cloud in place of the relay on his PC.
// The sideloaded app has no Sign in with Apple, so it sends a long random owner token as its "relay token": by
// default the relay's own VOICE_TOKEN, so the app keeps its token and only its address changes
// (cloud/setup/setup-owner.ps1 keeps only the token's SHA-256 in Secrets Manager, as bridge/owner).
// The authorizer turns that token into the fixed user OWNER, and only OWNER gets agent tasks, which run on
// the owner's claude.ai subscription: the Agent SDK terms keep subscription sign-in out of products for others.
// Dependencies are passed in, so tests run with fakes and no AWS.
import { createHash, timingSafeEqual } from 'node:crypto';

export const OWNER = 'owner';
// As the relay's VOICE_TOKEN: at least 24 characters, any printable ones (the relay never limited them).
const TOKEN = /^[\x21-\x7e]{24,512}$/;
const RETRY_MS = 5 * 60_000;   // a missing secret is looked for again after this

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * deps.secret() -> { tokenHash } (bridge/owner), or null when the owner account isn't set up
 * Returns check(bearer) -> true for the owner's token. The secret is read once per container, and while it's
 * missing at most every few minutes, so setting it up needs no deploy.
 * deps.now() -> ms (optional)
 */
export function makeOwner(deps) {
  const now = deps.now ?? Date.now;
  let hash = null;      // null: not read yet, or no owner set up
  let lookedAt = -Infinity;
  return async function check(bearer) {
    const token = String(bearer || '');
    if (!TOKEN.test(token)) return false;
    if (!hash && now() - lookedAt >= RETRY_MS) {
      try { hash = (await deps.secret())?.tokenHash ?? null; lookedAt = now(); }
      catch (e) { console.warn('Owner token unreadable:', e.name); return false; }
    }
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
    return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(hash, 'hex'));
  };
}
