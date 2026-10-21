// GitHub access for agents' work, as a GitHub App instead of the owner's own login.
// The relay holds the App's private key; each push gets a fresh installation token that covers only that
// agent's repository, with only contents and pull request access (no workflows, secrets or admin), and
// only when that repo's default branch is protected. It's revoked as soon as the push is done.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
// Asked for explicitly, so widening the App later doesn't widen agent tokens.
const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' };

// The default branch's rules must stop the bot merging or rewriting it alone: a pull request needing a
// code owner's approval of its latest push (so the bot can't approve, or push after you approved, and
// merge), and no force pushes or deletion.
export function branchProtected(rules) {
  if (!Array.isArray(rules)) return false;
  const has = (type, ok = () => true) => rules.some((r) => r.type === type && ok(r.parameters || {}));
  return has('pull_request', (p) => p.require_code_owner_review === true && p.require_last_push_approval === true
    && p.required_approving_review_count >= 1)
    && has('non_fast_forward') && has('deletion');
}

// Code owner review only means something when CODEOWNERS gives every file (`*`) a person as owner.
export function ownersCoverAll(text) {
  return String(text || '').split(/\r?\n/).some((line) => {
    const [pattern, ...owners] = line.replace(/#.*/, '').trim().split(/\s+/);
    return (pattern === '*' || pattern === '/**') && owners.some((o) => /^(@[\w.-]+(\/[\w.-]+)?|[^@\s]+@[^@\s]+\.\w+)$/.test(o));
  });
}

// True when mounting `repoPath` into a container would expose one of `protectedPaths` (the relay's own
// code, which runs on the host, or the folder holding the App key), because one contains the other.
// Symlinks and junctions are followed, so a link to either is caught too.
export function unsafeMount(repoPath, protectedPaths) {
  // The deepest part that exists is resolved, so a missing folder under a link is caught as well.
  const real = (p) => {
    const abs = path.resolve(p);
    try { return fs.realpathSync.native(abs); }
    catch { const up = path.dirname(abs); return up === abs ? abs : path.join(real(up), path.basename(abs)); }
  };
  const norm = (p) => real(p).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
  const r = norm(repoPath);
  return protectedPaths.some((p) => { const q = norm(p); return r.startsWith(q) || q.startsWith(r); });
}

// owner/repo from a GitHub remote: https://github.com/o/r(.git), git@github.com:o/r.git, ssh://git@github.com/o/r.
// Only GitHub's own name characters, so a crafted remote can't steer the App's API calls to another path.
export function parseRemote(url) {
  const m = String(url || '').trim().match(/^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/(?:[^@/\s]+@)?|[^@/\s:]+@)github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
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
  const e = encodeURIComponent;

  // auth: 'app' (the App's JWT), an installation token, or false.
  async function call(method, url, { auth = 'app', body } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-voice-relay',
    };
    if (auth) headers.Authorization = `Bearer ${auth === 'app' ? appJwt(appId, key, now()) : auth}`;
    if (body) headers['Content-Type'] = 'application/json';
    // A stalled GitHub must not hold the turn: callers treat the error as no token.
    const res = await fetch(`${API}${url}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${url}: ${res.status} ${data.message || ''}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Ends a token now rather than at its hour, so nothing the agent left running can keep using it.
  async function revoke(token) {
    try { await call('DELETE', '/installation/token', { auth: token }); }
    catch (err) { log(`GitHub token revoke failed: ${err.message}`); }
  }

  // A token for one repository, or null when the App isn't installed there, the default branch isn't
  // protected, or GitHub is unreachable. checkOnly answers true instead of minting the write token.
  async function tokenFor(owner, repo, { checkOnly = false } = {}) {
    let probe;
    try {
      const inst = await call('GET', `/repos/${e(owner)}/${e(repo)}/installation`);
      // A read-only token looks the repo up: its current name and id (the remote may predate a
      // rename, which would make a token request by name fail), its default branch's rules and CODEOWNERS.
      probe = (await call('POST', `/app/installations/${inst.id}/access_tokens`,
        { body: { permissions: { metadata: 'read', contents: 'read' } } })).token;
      const info = await call('GET', `/repos/${e(owner)}/${e(repo)}`, { auth: probe });
      const base = `/repos/${e(info.owner.login)}/${e(info.name)}`;
      const rules = await call('GET', `${base}/rules/branches/${e(info.default_branch)}`, { auth: probe });
      if (!branchProtected(rules)) {
        log(`${info.full_name}'s ${info.default_branch} branch isn't protected (see README: GitHub access for agents); no token.`);
        return null;
      }
      let owners = '';
      for (const f of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        try {
          const c = await call('GET', `${base}/contents/${f}?ref=${e(info.default_branch)}`, { auth: probe });
          owners = Buffer.from(c.content || '', 'base64').toString('utf8');
          break; // GitHub uses the first one it finds, in this order
        } catch (err) { if (err.status !== 404) throw err; }
      }
      if (!ownersCoverAll(owners)) {
        log(`${info.full_name} has no CODEOWNERS giving every file a person as owner (see README: GitHub access for agents); no token.`);
        return null;
      }
      if (checkOnly) return true;
      const t = await call('POST', `/app/installations/${inst.id}/access_tokens`,
        { body: { repository_ids: [info.id], permissions: TOKEN_PERMISSIONS } });
      return t.token;
    } catch (err) {
      log(err.status === 404 ? `GitHub App is not installed on ${owner}/${repo}; the agent can't push there.`
        : `GitHub App token for ${owner}/${repo} failed: ${err.message}`);
      return null;
    } finally {
      if (probe) await revoke(probe);
    }
  }

  // Commits show as the App's bot user, so agent work stands apart from the owner's.
  let who;
  async function identity() {
    if (who) return who;
    try {
      const app = await call('GET', '/app');
      const user = await call('GET', `/users/${e(`${app.slug}[bot]`)}`, { auth: false });
      who = { name: `${app.slug}[bot]`, email: `${user.id}+${app.slug}[bot]@users.noreply.github.com` };
    } catch (err) { log(`GitHub App identity lookup failed: ${err.message}`); return null; }
    return who;
  }

  return { tokenFor, revoke, identity };
}

// Agents never get a GitHub token: they commit, and the relay pushes for them afterwards from a separate
// container (publish.mjs). This decides which repo a push may go to and with which token: with the App, a
// token for the agent's pinned repo only; else `fallbackToken` (AGENT_GH_TOKEN). It also gives each turn
// the git identity to commit as, never the owner's when the App is set up.
//
// Agents can rewrite their repo's .git/config, so each folder's GitHub repo is pinned in `pinsFile` the
// first time it's read and kept across agents and restarts: a changed origin must not get a token for
// another repo the App is installed on. A pins file that exists but
// can't be read stops all tokens rather than being rebuilt from live config.
const AGENT_FALLBACK = { name: 'Bridge agent', email: 'bridge-agent@users.noreply.github.com' };

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
      // An agent that worked here before (before pinning existed, or one since stopped) may already have
      // pointed origin elsewhere, so a folder is only pinned to a repo of its own name, which is how a
      // clone is named; anything else waits for a pin added by hand.
      const bare = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (bare(path.basename(a.repoPath)) !== bare(slug.split('/')[1])) {
        log(`WARNING: ${a.name}'s origin ${slug} doesn't match its folder name; no GitHub token. If ${slug} is right, add ${JSON.stringify(key)}: ${JSON.stringify(slug)} to ${pinsFile}.`);
        return null;
      }
      pins[key] = slug;
      // Write then rename, so a crash mid-write can't leave a file that blocks every token.
      // A failed save (a locked file) keeps the pin in memory for this run rather than failing the turn.
      try {
        fs.mkdirSync(path.dirname(pinsFile), { recursive: true });
        fs.writeFileSync(`${pinsFile}.tmp`, JSON.stringify(pins, null, 2));
        fs.renameSync(`${pinsFile}.tmp`, pinsFile);
      } catch (e) { log(`WARNING: couldn't save ${pinsFile}: ${e.message}`); }
      log(`Pinned ${a.repoPath} to GitHub repo ${slug}.`);
    }
    return pins[key];
  }

  // The git identity a turn commits as: the App's bot user when the App is set up, else the host's.
  async function identity() {
    const who = ghApp ? (await ghApp.identity()) || AGENT_FALLBACK : hostGit;
    return {
      GIT_AUTHOR_NAME: who.name, GIT_COMMITTER_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_EMAIL: who.email,
    };
  }

  // Called before each turn, so a new folder is pinned to its origin before the agent can change it.
  async function pinNow(a) {
    if (!ghApp && !fallbackToken) return;
    const remote = parseRemote(await getRemote(a.repoPath));
    if (remote) pin(a, `${remote.owner}/${remote.repo}`.toLowerCase());
  }

  const issued = new Set(); // App tokens handed out and not yet released

  // { token, owner, repo } for pushing the agent's work to its own GitHub repo, or null.
  // checkOnly (cloud agents, which push through the Claude GitHub app) asks only whether the pinned repo
  // passes the App's checks: { owner, repo } or null, minting nothing. AGENT_GH_TOKEN never passes it.
  async function credentials(a, { checkOnly = false } = {}) {
    const remote = parseRemote(await getRemote(a.repoPath));
    if (!remote) { log(`${a.name} has no GitHub origin remote, so no GitHub token.`); return null; }
    if (!ghApp && !fallbackToken) return null;
    // Pinned with AGENT_GH_TOKEN too: it may cover more repos than this one.
    const slug = `${remote.owner}/${remote.repo}`.toLowerCase();
    // Only read here: pins are made before the turn (pinNow), never from what the agent left in .git/config.
    const pinned = pins?.[keyOf(a.repoPath)];
    if (!pinned) { log(`${a.name}'s folder isn't pinned to a GitHub repo; no GitHub token.`); return null; }
    if (slug !== pinned) {
      log(`${a.name}: origin changed from ${pinned} to ${slug}; no GitHub token. Delete its line in ${path.basename(pinsFile)} if that was you.`);
      return null;
    }
    if (!ghApp) return checkOnly ? null : { token: fallbackToken, ...remote };
    const token = await ghApp.tokenFor(remote.owner, remote.repo, { checkOnly });
    if (!token) return null;
    if (checkOnly) return { ...remote };
    issued.add(token);
    return { token, ...remote };
  }

  // Called once the push is done: an App token is revoked (AGENT_GH_TOKEN is the owner's to manage).
  async function release(creds) {
    if (!issued.delete(creds?.token)) return;
    await ghApp.revoke(creds.token);
  }

  return { identity, pinNow, credentials, release, isPinned: (repoPath) => !!pins?.[keyOf(repoPath)] };
}
