// GitHub access for agent containers, as a GitHub App instead of the owner's own login.
// The relay holds the App's private key; each agent turn gets an installation token that lasts an
// hour and covers only that agent's repository, with only the App's permissions (contents and pull
// requests; no workflows, secrets or admin). A token that leaks from a container is soon useless.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
// Reuse a token only while it has nearly its full hour left, so every turn gets about 55 minutes.
// A turn that runs longer than that gets a 401 on its next push.
const REUSE_MS = 55 * 60_000;
// Asked for explicitly, so widening the App later doesn't widen agent tokens.
const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' };

// owner/repo from a GitHub remote: https://github.com/o/r(.git), git@github.com:o/r.git, ssh://git@github.com/o/r.
// Only GitHub's own name characters, so a crafted remote can't steer the App's API calls to another path.
export function parseRemote(url) {
  const m = String(url || '').trim().match(/(?:^|[/@])github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!m || [m[1], m[2]].some((s) => s === '.' || s === '..')) return null;
  return { owner: m[1], repo: m[2] };
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
      const inst = await call('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
      const t = await call('POST', `/app/installations/${inst.id}/access_tokens`, { body: { repositories: [repo], permissions: TOKEN_PERMISSIONS } });
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

// What each agent turn gets: GH_TOKEN plus the git identity to commit as. Agents never get the owner's
// own login: with the App, a token for the agent's pinned repo only; else `fallbackToken` (AGENT_GH_TOKEN).
//
// Agents can rewrite their repo's .git/config, so each folder's GitHub repo is pinned in `pinsFile` the
// first time it's read (before any agent has run there) and kept across agents and restarts: a changed
// origin must not get a token for another repo the App is installed on. A pins file that exists but
// can't be read stops all tokens rather than being rebuilt from live config.
export function makeAgentGitHub({ ghApp, fallbackToken = '', hostGit, getRemote, pinsFile, log = () => {} }) {
  let pins = {};
  try { pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { pins = null; log(`WARNING: ${pinsFile} is unreadable (${e.message}); agents get no GitHub token until it's fixed or deleted.`); }
  }
  const keyOf = (repoPath) => path.resolve(repoPath).toLowerCase();

  function pin(a, slug) {
    if (!pins) return null;
    const key = keyOf(a.repoPath);
    if (!pins[key]) {
      pins[key] = slug;
      fs.writeFileSync(pinsFile, JSON.stringify(pins, null, 2));
      // An agent from before pinning may already have changed origin, so this pin is only as good as that config.
      log(a.ranBeforePins ? `WARNING: pinned ${a.repoPath} to ${slug} after an agent already ran there; check it's right, or fix it in ${path.basename(pinsFile)}.`
        : `Pinned ${a.repoPath} to GitHub repo ${slug}.`);
    }
    return pins[key];
  }

  async function env(a) {
    let token = fallbackToken, who = hostGit;
    if (ghApp) {
      const remote = parseRemote(await getRemote(a.repoPath));
      const slug = remote && `${remote.owner}/${remote.repo}`.toLowerCase();
      const pinned = slug && pin(a, slug);
      if (!slug) log(`${a.name} has no GitHub origin remote, so no GitHub token.`);
      else if (pinned && slug !== pinned) log(`${a.name}: origin changed from ${pinned} to ${slug}; no GitHub token. Delete its line in ${path.basename(pinsFile)} if that was you.`);
      token = slug && slug === pinned ? await ghApp.tokenFor(remote.owner, remote.repo) : '';
      who = (await ghApp.identity()) || hostGit;
    }
    return {
      GH_TOKEN: token || '',
      GIT_AUTHOR_NAME: who.name, GIT_COMMITTER_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_EMAIL: who.email,
    };
  }

  return { env, isPinned: (repoPath) => !!pins?.[keyOf(repoPath)] };
}
