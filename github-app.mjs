// GitHub access for agent containers, as a GitHub App instead of the owner's own login.
// The relay holds the App's private key; each agent turn gets an installation token that lasts an
// hour and covers only that agent's repository, with only the App's permissions (contents and pull
// requests; no workflows, secrets or admin). A token that leaks from a container is soon useless.
import crypto from 'node:crypto';

const API = 'https://api.github.com';
// Reuse a token only while it has nearly its full hour left, so every turn gets about 55 minutes.
// A turn that runs longer than that gets a 401 on its next push.
const REUSE_MS = 55 * 60_000;

// owner/repo from a GitHub remote: https://github.com/o/r(.git), git@github.com:o/r.git, ssh://git@github.com/o/r
export function parseRemote(url) {
  const m = String(url || '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

const b64url = (b) => Buffer.from(b).toString('base64url');

// The App's own short-lived credential, used only to ask GitHub for installation tokens.
export function appJwt(appId, key, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  // iat a minute back allows for clock drift; GitHub caps exp at 10 minutes.
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

export function makeGitHubApp({ appId, privateKey, fetch = globalThis.fetch, now = Date.now, log = () => {} }) {
  const key = crypto.createPrivateKey(privateKey);
  const cache = new Map(); // "owner/repo" -> { token, expires }

  async function call(method, url, { auth = true, body } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-voice-relay',
    };
    if (auth) headers.Authorization = `Bearer ${appJwt(appId, key, now())}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${url}`, { method, headers, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`GitHub ${method} ${url}: ${res.status} ${data.message || ''}`.trim());
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // A token for one repository, or null when the App isn't installed there (or GitHub is unreachable).
  async function tokenFor(owner, repo) {
    const id = `${owner}/${repo}`.toLowerCase();
    const hit = cache.get(id);
    if (hit && hit.expires - now() > REUSE_MS) return hit.token;
    try {
      const inst = await call('GET', `/repos/${owner}/${repo}/installation`);
      const t = await call('POST', `/app/installations/${inst.id}/access_tokens`, { body: { repositories: [repo] } });
      cache.set(id, { token: t.token, expires: Date.parse(t.expires_at) });
      return t.token;
    } catch (e) {
      log(e.status === 404 ? `GitHub App is not installed on ${owner}/${repo}; the agent can't push there.`
        : `GitHub App token for ${owner}/${repo} failed: ${e.message}`);
      return null;
    }
  }

  // Commits show as the App's bot user, so agent work stands apart from the owner's.
  let who;
  async function identity() {
    if (who) return who;
    try {
      const app = await call('GET', '/app');
      const user = await call('GET', `/users/${encodeURIComponent(`${app.slug}[bot]`)}`, { auth: false });
      who = { name: `${app.slug}[bot]`, email: `${user.id}+${app.slug}[bot]@users.noreply.github.com` };
    } catch (e) { log(`GitHub App identity lookup failed: ${e.message}`); return null; }
    return who;
  }

  return { tokenFor, identity };
}
