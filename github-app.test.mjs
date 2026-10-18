import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRemote, appJwt, makeGitHubApp, makeAgentGitHub } from './github-app.mjs';

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

function fakeGitHub({ installed = true } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, opts) => {
    calls.push({ url, ...opts, body: opts.body && JSON.parse(opts.body) });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (url.endsWith('/installation')) return installed ? reply(200, { id: 42 }) : reply(404, { message: 'Not Found' });
    if (url.endsWith('/app/installations/42/access_tokens')) {
      return reply(201, { token: `ghs_${++n}`, expires_at: new Date(clock + 3600_000).toISOString() });
    }
    if (url.endsWith('/app')) return reply(200, { slug: 'bridge-agents' });
    if (url.includes('/users/bridge-agents%5Bbot%5D')) return reply(200, { id: 999 });
    return reply(404, {});
  };
  let clock = 1_700_000_000_000;
  const logs = [];
  const app = makeGitHubApp({ appId: 7, privateKey: pem, fetch, now: () => clock, log: (m) => logs.push(m) });
  return { app, calls, logs, advance: (ms) => (clock += ms) };
}

test('tokenFor asks for a token scoped to the one repository, and reuses it while fresh', async () => {
  const { app, calls, advance } = fakeGitHub();
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_1');
  const mint = calls.find((c) => c.url.endsWith('/access_tokens'));
  assert.equal(mint.method, 'POST');
  assert.deepEqual(mint.body, { repositories: ['claude-voice-relay'] });
  assert.match(mint.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  advance(4 * 60_000);
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_1');
  advance(2 * 60_000); // 54 minutes left: a long turn could outlive it
  assert.equal(await app.tokenFor('stephen3303', 'claude-voice-relay'), 'ghs_2');
});

test('tokenFor returns null when the App is not installed on the repository', async () => {
  const { app, logs } = fakeGitHub({ installed: false });
  assert.equal(await app.tokenFor('stephen3303', 'other'), null);
  assert.match(logs[0], /not installed on stephen3303\/other/);
});

test('identity is the App bot user, with its noreply address', async () => {
  const { app, calls } = fakeGitHub();
  const who = await app.identity();
  assert.deepEqual(who, { name: 'bridge-agents[bot]', email: '999+bridge-agents[bot]@users.noreply.github.com' });
  assert.equal(calls.find((c) => c.url.includes('/users/')).headers.Authorization, undefined);
  await app.identity();
  assert.equal(calls.length, 2); // looked up once
});

function agentGitHub({ remote = 'https://github.com/stephen3303/claude-voice-relay.git', pinsJson, ghApp, fallbackToken } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
  const pinsFile = path.join(dir, 'github-pins.json');
  if (pinsJson !== undefined) fs.writeFileSync(pinsFile, pinsJson);
  const minted = [];
  const app = ghApp === null ? null : {
    tokenFor: async (owner, repo) => { minted.push(`${owner}/${repo}`); return 'ghs_x'; },
    identity: async () => ({ name: 'bridge-agents[bot]', email: '9+bridge-agents[bot]@users.noreply.github.com' }),
  };
  const logs = [];
  const state = { remote };
  const gh = makeAgentGitHub({
    ghApp: app, fallbackToken, hostGit: { name: 'Stephen', email: 's@example.com' },
    getRemote: async () => state.remote, pinsFile, log: (m) => logs.push(m),
  });
  return { gh, minted, logs, state, pinsFile };
}
const agent = { name: 'voice relay', repoPath: '/p/claude-voice-relay' };

test('an agent gets a token for its pinned repo and commits as the App bot', async () => {
  const { gh, minted, pinsFile } = agentGitHub();
  const env = await gh.env(agent);
  assert.equal(env.GH_TOKEN, 'ghs_x');
  assert.equal(env.GIT_AUTHOR_NAME, 'bridge-agents[bot]');
  assert.deepEqual(minted, ['stephen3303/claude-voice-relay']);
  assert.ok(gh.isPinned(agent.repoPath));
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(pinsFile, 'utf8'))), ['stephen3303/claude-voice-relay']);
});

test('a changed origin gets no token and is not re-pinned', async () => {
  const { gh, minted, logs, state } = agentGitHub();
  await gh.env(agent);
  state.remote = 'https://github.com/stephen3303/other-repo.git';
  const env = await gh.env(agent);
  assert.equal(env.GH_TOKEN, '');
  assert.deepEqual(minted, ['stephen3303/claude-voice-relay']);
  assert.match(logs.at(-1), /origin changed/);
});

test('no GitHub origin, or an unreadable pins file, gets no token', async () => {
  const none = agentGitHub({ remote: '' });
  assert.equal((await none.gh.env(agent)).GH_TOKEN, '');
  assert.deepEqual(none.minted, []);
  const broken = agentGitHub({ pinsJson: '{not json' });
  assert.equal((await broken.gh.env(agent)).GH_TOKEN, '');
  assert.deepEqual(broken.minted, []);
  assert.equal(fs.readFileSync(broken.pinsFile, 'utf8'), '{not json'); // not rebuilt from live config
});

test('a pin made for an agent that ran before pinning is a warning', async () => {
  const { gh, logs } = agentGitHub();
  await gh.env({ ...agent, ranBeforePins: true });
  assert.match(logs[0], /^WARNING: pinned/);
});

test('without the App, AGENT_GH_TOKEN and the host git identity are used', async () => {
  const { gh } = agentGitHub({ ghApp: null, fallbackToken: 'github_pat_x' });
  const env = await gh.env(agent);
  assert.equal(env.GH_TOKEN, 'github_pat_x');
  assert.equal(env.GIT_COMMITTER_EMAIL, 's@example.com');
  assert.equal((await agentGitHub({ ghApp: null }).gh.env(agent)).GH_TOKEN, '');
});
