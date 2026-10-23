// The owner's account: Stephen's own use of Bridge Cloud in place of the relay on his PC.
// The sideloaded app has no Sign in with Apple, so it sends a long random owner token as its "relay token": by
// default the relay's own VOICE_TOKEN, so the app keeps its token and only its address changes
// (cloud/setup/setup-owner.ps1 keeps only the token's SHA-256 in Secrets Manager, as bridge/owner).
// The authorizer turns that token into the fixed user OWNER (so does the Claude connector for the owner's Apple
// account), and only OWNER gets agent tasks, which run on
// the owner's claude.ai subscription: the Agent SDK terms keep subscription sign-in out of products for others.
// Dependencies are passed in, so tests run with fakes and no AWS.
import { createHash, timingSafeEqual } from 'node:crypto';

export const OWNER = 'owner';
// As the relay's VOICE_TOKEN: at least 24 characters, any printable ones (the relay never limited them).
const TOKEN = /^[\x21-\x7e]{24,512}$/;
// Bridge account ids from Sign in with Apple (auth.mjs, connector.mjs).
const APPLE_SUB = /^apple\.[\x21-\x7e]{1,255}$/;
const RETRY_MS = 5 * 60_000;   // the secret is read again after this, so a change needs no deploy

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * deps.secret() -> { tokenHash, appleSub? } (bridge/owner), or null when the owner account isn't set up.
 *   appleSub: the owner's Bridge account id from Sign in with Apple ("apple.<sub>"), so the Claude connector,
 *   which signs in that way, reaches the owner's agents too.
 * Returns check(bearer) -> true for the owner's token, and check.userFor(sub) -> OWNER for the owner's Apple
 * account, else sub. The secret is read at most every few minutes, so setting it up or changing it needs no
 * deploy; a failed read keeps what was read before.
 * deps.now() -> ms (optional)
 */
export function makeOwner(deps) {
  const now = deps.now ?? Date.now;
  let owner = null;     // null: not read yet, or no owner set up
  let lookedAt = -Infinity;
  async function load() {
    if (now() - lookedAt >= RETRY_MS) {
      try { owner = (await deps.secret()) ?? null; lookedAt = now(); }
      catch (e) { console.warn('Owner token unreadable:', e.name); }
    }
    return owner;
  }
  async function check(bearer) {
    const token = String(bearer || '');
    if (!TOKEN.test(token)) return false;
    const hash = (await load())?.tokenHash;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
    return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(hash, 'hex'));
  }
  check.userFor = async (sub) => {
    const apple = (await load())?.appleSub;
    return typeof apple === 'string' && APPLE_SUB.test(apple) && sub === apple ? OWNER : sub;
  };
  return check;
}
