import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRemote, appJwt, makeGitHubApp, makeAgentGitHub, unsafeMount, ownersCoverAll } from './github-app.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('parseRemote reads the GitHub remotes git uses', () => {
  const want = { owner: 'stephen3303', repo: 'claude-voice-relay' };
  assert.deepEqual(parseRemote('https://github.com/stephen3303/claude-voice-relay.git'), want);
  assert.deepEqual(parseRemote('https://github.com/stephen3303/claude-voice-relay\n'), want);
  assert.deepEqual(parseRemote('git@github.com:stephen3303/claude-voice-relay.git'), want);
  assert.deepEqual(parseRemote('ssh://git@github.com/stephen3303/claude-voice-relay'), want);
  assert.deepEqual(parseRemote('https://x-access-token@github.com/stephen3303/claude-voice-relay.git'), want);
  assert.equal(parseRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(parseRemote(''), null);
  // Nothing that could steer the API path, and no look-alike hosts.
  assert.equal(parseRemote('https://github.com/../app'), null);
  assert.equal(parseRemote('https://github.com/o/r?x=1'), null);
  assert.equal(parseRemote('https://github.com/o/r#x'), null);
  assert.equal(parseRemote('https://evilgithub.com/o/r.git'), null);
  assert.equal(parseRemote('https://evil.example/github.com/o/r'), null);
});

test('appJwt is an RS256 JWT for the App, valid for under ten minutes', () => {
  const now = 1_700_000_000_000;
  const [h, b, s] = appJwt(123, crypto.createPrivateKey(pem), now).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const body = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(body.iss, '123');
  assert.ok(body.exp - body.iat <= 600);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')));
});

const PROTECTED_RULES = [
  { type: 'pull_request', parameters: { require_code_owner_review: true, require_last_push_approval: true, required_approving_review_count: 1 } },
  { type: 'non_fast_forward' },
  { type: 'deletion' },
];

function fakeGitHub({ installed = true, rules = PROTECTED_RULES, canonical = 'claude-voice-relay', codeowners = { '.github/CODEOWNERS': '* @stephen3303\n' } } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, opts) => {
    calls.push({ url, ...opts, body: opts.body && JSON.parse(opts.body) });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    const path = url.replace('https://api.github.com', '');
    if (path.endsWith('/installation') && opts.method === 'GET') return installed ? reply(200, { id: 42 }) : reply(404, { message: 'Not Found' });
    if (path === '/installation/token' && opts.method === 'DELETE') return reply(204);
    if (path === '/app/installations/42/access_tokens') return reply(201, { token: `ghs_${++n}` });
    if (path.startsWith('/repos/stephen3303/') && path.includes('/rules/branches/main')) return reply(200, rules);
    const file = path.match(/\/contents\/(.+)\?ref=main$/)?.[1];
    if (file) return codeowners[file] ? reply(200, { content: Buffer.from(codeowners[file]).toString('base64') }) : reply(404, {});
    if (/^\/repos\/stephen3303\/[\w.-]+$/.test(path)) {
      return reply(200, { id: 5, name: canonical, full_name: `stephen3303/${canonical}`, owner: { login: 'stephen3303' }, default_branch: 'main' });
    }
    if (path === '/app') return reply(200, { slug: 'bridge-agents' });
    if (path === '/users/bridge-agents%5Bbot%5D') return reply(200, { id: 999 });
    return reply(404, {});
  };
  const logs = [];
  const app = makeGitHubApp({ appId: 7, privateKey: pem, fetch, log: (m) => logs.push(m) });
  return { app, calls, logs };
}
const mints = (calls) => calls.filter((c) => c.url.endsWith('/access_tokens'));
const revokes = (calls) => calls.filter((c) => c.method === 'DELETE').map((c) => c.headers.Authorization);

test('tokenFor mints a token for the one repository by id, and revokes the lookup token', async () => {
  const { app, calls } = fakeGitHub();
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_2');
  const [probe, real] = mints(calls);
  assert.deepEqual(probe.body, { permissions: { metadata: 'read', contents: 'read' } });
  assert.match(probe.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); // the App's JWT
  assert.deepEqual(real.body, {
    repository_ids: [5],
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  });
  assert.deepEqual(revokes(calls), ['Bearer ghs_1']);
  // Each turn gets its own token.
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_4');
});

test('tokenFor follows a renamed repository to its current name', async () => {
  const { app, calls } = fakeGitHub({ canonical: 'bridge' });
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_2');
  assert.ok(calls.some((c) => c.url.endsWith('/repos/stephen3303/bridge/rules/branches/main')));
});

test('tokenFor refuses a repository whose default branch is not protected', async () => {
  for (const rules of [[], PROTECTED_RULES.slice(1),
    [{ type: 'pull_request', parameters: { require_code_owner_review: false, require_last_push_approval: true, required_approving_review_count: 1 } }, ...PROTECTED_RULES.slice(1)],
    [{ type: 'pull_request', parameters: { require_code_owner_review: true, require_last_push_approval: false, required_approving_review_count: 1 } }, ...PROTECTED_RULES.slice(1)],
    PROTECTED_RULES.filter((r) => r.type !== 'deletion')]) {
    const { app, calls, logs } = fakeGitHub({ rules });
    assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), null);
    assert.equal(mints(calls).length, 1); // only the lookup token, which is revoked
    assert.deepEqual(revokes(calls), ['Bearer ghs_1']);
    assert.match(logs.at(-1), /isn't protected/);
  }
});

test('tokenFor refuses a repository whose CODEOWNERS does not give every file a person', async () => {
  for (const codeowners of [{}, { '.github/CODEOWNERS': '/docs @stephen3303\n' }, { 'CODEOWNERS': '* @bridge-agents[bot]' }]) {
    const { app, calls, logs } = fakeGitHub({ codeowners });
    assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), null);
    assert.equal(mints(calls).length, 1);
    assert.match(logs.at(-1), /CODEOWNERS/);
  }
  // Any of GitHub's three places will do.
  assert.equal(await fakeGitHub({ codeowners: { 'docs/CODEOWNERS': '# owners\n*   @stephen3303 # me' } }).app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_2');
});

test('ownersCoverAll needs a person or team owning every file', () => {
  assert.ok(ownersCoverAll('* @stephen3303'));
  assert.ok(ownersCoverAll('/** @org/team'));
  assert.ok(ownersCoverAll('* someone@example.com'));
  for (const t of ['', '# * @stephen3303', '*.js @stephen3303', '*', '* @bridge-agents[bot]']) assert.equal(ownersCoverAll(t), false, t);
});

test('tokenFor returns null when the App is not installed on the repository', async () => {
  const { app, logs } = fakeGitHub({ installed: false });
  assert.equal(await app.tokenFor('stephen3303', 'other'), null);
  assert.match(logs[0], /not installed on stephen3303\/other/);
});

test('unsafeMount refuses the relay, the key folder and anything above them', () => {
  const guarded = ['/home/s/Projects/claude-voice-relay', '/home/s/.bridge'];
  assert.equal(unsafeMount('/home/s/Projects/trading-bot', guarded), false);
  assert.equal(unsafeMount('/home/s/Projects/voice-relay-work', guarded), false);
  assert.equal(unsafeMount('/home/s/Projects/claude-voice-relay', guarded), true);
  assert.equal(unsafeMount('/home/s/Projects/Claude-Voice-Relay/', guarded), true);
  assert.equal(unsafeMount('/home/s/Projects/claude-voice-relay/glasses', guarded), true);
  assert.equal(unsafeMount('/home/s/Projects', guarded), true);
  assert.equal(unsafeMount('/home/s', guarded), true);
  assert.equal(unsafeMount('/home/s/.bridge', guarded), true);
});

test('unsafeMount follows a symlink to a guarded folder', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-'));
  const relay = path.join(dir, 'claude-voice-relay');
  fs.mkdirSync(relay);
  fs.symlinkSync(relay, path.join(dir, 'innocent'));
  assert.equal(unsafeMount(path.join(dir, 'innocent'), [relay]), true);
  assert.equal(unsafeMount(path.join(dir, 'innocent', 'sub'), [relay]), true);
});

test('identity is the App bot user, with its noreply address', async () => {
  const { app, calls } = fakeGitHub();
  const who = await app.identity();
  assert.deepEqual(who, { name: 'bridge-agents[bot]', email: '999+bridge-agents[bot]@users.noreply.github.com' });
  assert.equal(calls.find((c) => c.url.includes('/users/')).headers.Authorization, undefined);
  await app.identity();
  assert.equal(calls.length, 2); // looked up once
});

function agentGitHub({ remote = 'https://github.com/stephen3303/claude-voice-relay.git', pinsJson, ghApp, fallbackToken, noIdentity } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
  const pinsFile = path.join(dir, 'github-pins.json');
  if (pinsJson !== undefined) fs.writeFileSync(pinsFile, pinsJson);
  const minted = [], revoked = [];
  const app = ghApp === null ? null : {
    tokenFor: async (owner, repo) => { minted.push(`${owner}/${repo}`); return 'ghs_x'; },
    revoke: async (t) => { revoked.push(t); },
    identity: async () => (noIdentity ? null : { name: 'bridge-agents[bot]', email: '9+bridge-agents[bot]@users.noreply.github.com' }),
  };
  const logs = [];
  const state = { remote };
  const gh = makeAgentGitHub({
    ghApp: app, fallbackToken, hostGit: { name: 'Stephen', email: 's@example.com' },
    getRemote: async () => state.remote, pinsFile, log: (m) => logs.push(m),
  });
  return { gh, minted, revoked, logs, state, pinsFile };
}
const agent = { name: 'voice relay', repoPath: '/p/claude-voice-relay' };

// A turn: pinned before the agent runs, credentials after.
const turn = async (gh) => { await gh.pinNow(agent); return gh.credentials(agent); };
const tok = async (gh) => (await turn(gh))?.token || '';

test('an agent gets a token for its pinned repo only, and commits as the App bot', async () => {
  const { gh, minted, pinsFile } = agentGitHub();
  assert.deepEqual(await turn(gh), { token: 'ghs_x', owner: 'stephen3303', repo: 'claude-voice-relay' });
  assert.equal((await gh.identity()).GIT_AUTHOR_NAME, 'bridge-agents[bot]');
  assert.deepEqual(minted, ['stephen3303/claude-voice-relay']);
  assert.ok(gh.isPinned(agent.repoPath));
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(pinsFile, 'utf8'))), ['stephen3303/claude-voice-relay']);
});

test('a folder pinned before the turn keeps that pin when the agent changes origin', async () => {
  const { gh, minted, state, pinsFile } = agentGitHub();
  await gh.pinNow(agent);
  assert.deepEqual(minted, []); // pinning mints nothing
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(pinsFile, 'utf8'))), ['stephen3303/claude-voice-relay']);
  state.remote = 'https://github.com/someone-else/claude-voice-relay.git'; // same name, another owner
  assert.equal(await gh.credentials(agent), null);
  assert.deepEqual(minted, []);
  // Without any GitHub access, nothing is pinned.
  const off = agentGitHub({ ghApp: null });
  await off.gh.pinNow(agent);
  assert.equal(off.gh.isPinned(agent.repoPath), false);
});

test('credentials never pin: a folder not pinned before the turn gets no token', async () => {
  const { gh, minted, logs } = agentGitHub();
  assert.equal(await gh.credentials(agent), null); // no pinNow, as if origin was set during the turn
  assert.equal(gh.isPinned(agent.repoPath), false);
  assert.deepEqual(minted, []);
  assert.match(logs.at(-1), /isn't pinned/);
});

test('the identity a turn commits as never carries a token', async () => {
  const { gh } = agentGitHub();
  assert.deepEqual(Object.keys(await gh.identity()).sort(),
    ['GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']);
});

test('a changed origin gets no token and is not re-pinned', async () => {
  const { gh, minted, logs, state } = agentGitHub();
  await turn(gh);
  state.remote = 'https://github.com/stephen3303/other-repo.git';
  assert.equal(await gh.credentials(agent), null);
  assert.deepEqual(minted, ['stephen3303/claude-voice-relay']);
  assert.match(logs.at(-1), /origin changed/);
});

test('no GitHub origin, or an unreadable pins file, gets no token', async () => {
  const none = agentGitHub({ remote: '' });
  assert.equal(await tok(none.gh), '');
  assert.deepEqual(none.minted, []);
  const broken = agentGitHub({ pinsJson: '{not json' });
  assert.equal(await tok(broken.gh), '');
  assert.deepEqual(broken.minted, []);
  assert.equal(fs.readFileSync(broken.pinsFile, 'utf8'), '{not json'); // not rebuilt from live config
});

test('a folder is only pinned to the repo of its own name', async () => {
  const other = agentGitHub({ remote: 'https://github.com/stephen3303/trading-bot.git' });
  assert.equal(await tok(other.gh), '');
  assert.deepEqual(other.minted, []);
  assert.equal(other.gh.isPinned(agent.repoPath), false);
  assert.match(other.logs[0], /doesn't match its folder name/);
  // Case and separators don't matter.
  const same = agentGitHub({ remote: 'git@github.com:stephen3303/Claude_Voice_Relay.git' });
  assert.equal(await tok(same.gh), 'ghs_x');
});

test('pins survive a restart', async () => {
  const first = agentGitHub();
  await turn(first.gh);
  const logs = [], minted = [];
  const restarted = makeAgentGitHub({
    ghApp: { tokenFor: async (o, r) => { minted.push(`${o}/${r}`); return 'ghs_y'; }, identity: async () => ({ name: 'b[bot]', email: 'b@x' }) },
    hostGit: { name: 'Stephen', email: 's@example.com' },
    getRemote: async () => 'https://github.com/stephen3303/other-repo.git',
    pinsFile: first.pinsFile, log: (m) => logs.push(m),
  });
  await restarted.pinNow(agent); // the pin on file stands
  assert.equal(await restarted.credentials(agent), null);
  assert.deepEqual(minted, []);
  assert.match(logs[0], /origin changed from stephen3303\/claude-voice-relay/);
});

test('without the App, AGENT_GH_TOKEN and the host git identity are used', async () => {
  const { gh } = agentGitHub({ ghApp: null, fallbackToken: 'github_pat_x' });
  assert.equal(await tok(gh), 'github_pat_x');
  assert.equal((await gh.identity()).GIT_COMMITTER_EMAIL, 's@example.com');
  assert.equal(await tok(agentGitHub({ ghApp: null }).gh), '');
});

test('AGENT_GH_TOKEN is pinned too, so a changed origin gets no token', async () => {
  const { gh, state, logs } = agentGitHub({ ghApp: null, fallbackToken: 'github_pat_x' });
  assert.equal(await tok(gh), 'github_pat_x');
  state.remote = 'https://github.com/stephen3303/other-repo.git';
  assert.equal(await tok(gh), '');
  assert.match(logs.at(-1), /origin changed/);
  const other = agentGitHub({ ghApp: null, fallbackToken: 'github_pat_x', remote: 'https://github.com/stephen3303/trading-bot.git' });
  assert.equal(await tok(other.gh), '');
});

test('a pin that cannot be saved still holds for this run', async () => {
  const pinsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pins-')), 'github-pins.json');
  fs.mkdirSync(`${pinsFile}.tmp`); // a folder where the temp file goes, so the save fails
  const logs = [];
  const gh = makeAgentGitHub({
    ghApp: { tokenFor: async () => 'ghs_x', identity: async () => ({ name: 'b[bot]', email: 'b@x' }) },
    hostGit: { name: 'Stephen', email: 's@example.com' },
    getRemote: async () => 'https://github.com/stephen3303/claude-voice-relay.git',
    pinsFile,
    log: (m) => logs.push(m),
  });
  assert.equal(await tok(gh), 'ghs_x');
  assert.ok(logs.some((m) => /couldn't save/.test(m)));
  assert.ok(gh.isPinned(agent.repoPath));
});

test('an App token is revoked on release; AGENT_GH_TOKEN is left alone', async () => {
  const { gh, revoked } = agentGitHub();
  const creds = await turn(gh);
  await gh.release(creds);
  await gh.release(creds); // once only
  assert.deepEqual(revoked, ['ghs_x']);
  const pat = agentGitHub({ ghApp: null, fallbackToken: 'github_pat_x' });
  await pat.gh.release(await turn(pat.gh));
  await pat.gh.release(null); // nothing was issued
});

test('without the bot identity, commits never go out as the owner', async () => {
  const { gh } = agentGitHub({ noIdentity: true });
  assert.notEqual((await gh.identity()).GIT_AUTHOR_NAME, 'Stephen');
});

test('tokenFor with checkOnly runs the same checks and mints no write token', async () => {
  const { app, calls } = fakeGitHub();
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay', { checkOnly: true }), true);
  assert.equal(mints(calls).length, 1); // the read-only probe only
  assert.deepEqual(revokes(calls), ['Bearer ghs_1']);
});

test('credentials checkOnly answers for the pinned repo without a token, and never with AGENT_GH_TOKEN', async () => {
  const { gh, minted } = agentGitHub({
    ghApp: undefined,
  });
  await gh.pinNow(agent);
  assert.deepEqual(await gh.credentials(agent, { checkOnly: true }), { owner: 'stephen3303', repo: 'claude-voice-relay' });
  assert.deepEqual(minted, ['stephen3303/claude-voice-relay']); // the fake counts the check
  const fallback = agentGitHub({ ghApp: null, fallbackToken: 'github_pat_x' });
  await fallback.gh.pinNow(agent);
  assert.equal(await fallback.gh.credentials(agent, { checkOnly: true }), null);
});
