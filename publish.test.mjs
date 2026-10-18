import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makePublisher, parseRequest, validBranch, FETCH_SCRIPT, PUSH_SCRIPT } from './publish.mjs';

const agent = { name: 'voice relay', repoPath: '/p/claude-voice-relay' };
const request = (r) => JSON.stringify({ branch: 'fix/stop-loss', title: 'Fix the stop-loss check', body: 'Details', ...r });

function publisher({ text = request(), creds = { token: 'ghs_x', owner: 'stephen3303', repo: 'claude-voice-relay' },
  prExists = false, pushFails = false, defaultBranch = 'main' } = {}) {
  const calls = [], pushes = [], released = [], logs = [];
  const fetch = async (url, opts) => {
    calls.push({ url, ...opts, body: opts.body && JSON.parse(opts.body) });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    const p = url.replace('https://api.github.com', '');
    if (p === '/repos/stephen3303/claude-voice-relay' && opts.method === 'GET') {
      return reply(200, { full_name: 'stephen3303/Claude-Voice-Relay', owner: { login: 'stephen3303' }, default_branch: defaultBranch });
    }
    if (p === '/repos/stephen3303/Claude-Voice-Relay/pulls' && opts.method === 'POST') {
      return prExists ? reply(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for stephen3303:fix/stop-loss.' }] })
        : reply(201, { number: 31 });
    }
    if (p.startsWith('/repos/stephen3303/Claude-Voice-Relay/pulls?head=stephen3303%3Afix%2Fstop-loss')) return reply(200, [{ number: 30 }]);
    return reply(404, {});
  };
  const pub = makePublisher({
    readRequest: async () => text,
    agentGitHub: { credentials: async () => creds, release: async (c) => { released.push(c); } },
    push: async (p) => { pushes.push(p); if (pushFails) throw new Error('rejected'); },
    fetch, log: (m) => logs.push(m),
  });
  return { pub, calls, pushes, released, logs };
}

test('validBranch accepts ordinary branch names and refuses options, refspecs and odd paths', () => {
  for (const b of ['fix/stop-loss', 'claude/voice-1', 'a', 'feature_x.2']) assert.ok(validBranch(b), b);
  for (const b of ['', '-f', '--force', 'a..b', 'a b', 'main:main', '+main', 'refs/heads/x@{1}', 'x/', 'x.', 'x.lock', 'a//b', 'a/.b', '.x', 'a\nb', 'x'.repeat(101), 7, null]) {
    assert.equal(validBranch(b), false, String(b));
  }
});

test('parseRequest needs a valid branch and fills in a title', () => {
  assert.deepEqual(parseRequest(request()), { branch: 'fix/stop-loss', title: 'Fix the stop-loss check', body: 'Details' });
  assert.equal(parseRequest(JSON.stringify({ branch: 'x' })).title, 'Changes on x');
  assert.match(parseRequest('{nope').error, /not valid JSON/);
  assert.match(parseRequest('null').error, /not valid JSON/);
  assert.match(parseRequest(request({ branch: '--force' })).error, /valid branch/);
});

test('a request is pushed with a token for that repo, then a pull request is opened', async () => {
  const { pub, calls, pushes, released } = publisher();
  assert.equal(await pub.publish(agent), 'I pushed the work and opened pull request 31.');
  assert.deepEqual(pushes, [{ a: agent, branch: 'fix/stop-loss', repo: 'stephen3303/Claude-Voice-Relay', token: 'ghs_x' }]);
  const pr = calls.find((c) => c.method === 'POST');
  assert.deepEqual(pr.body, { title: 'Fix the stop-loss check', body: 'Details', head: 'fix/stop-loss', base: 'main' });
  assert.equal(pr.headers.Authorization, 'Bearer ghs_x');
  assert.equal(released.length, 1);
});

test('a branch that already has a pull request is just pushed', async () => {
  const { pub } = publisher({ prExists: true });
  assert.equal(await pub.publish(agent), 'I pushed the work to pull request 30.');
});

test('no request means nothing to say and no token', async () => {
  const { pub, released, calls } = publisher({ text: null });
  assert.equal(await pub.publish(agent), null);
  assert.deepEqual([released, calls], [[], []]);
});

test('the default branch is never pushed, and the token is still released', async () => {
  const { pub, pushes, released } = publisher({ text: request({ branch: 'main' }) });
  assert.match(await pub.publish(agent), /on main itself/);
  assert.deepEqual(pushes, []);
  assert.equal(released.length, 1);
});

test('a bad request, no access, or a failed push is said plainly', async () => {
  assert.match(await publisher({ text: '{' }).pub.publish(agent), /^I didn't push the work, because its push request was not valid JSON\.$/);
  assert.match(await publisher({ text: request({ body: 'x'.repeat(70_000) }) }).pub.publish(agent), /too long/);
  const broken = publisher();
  broken.pub = makePublisher({ readRequest: async () => request(), agentGitHub: { credentials: async () => { throw new Error('outage'); }, release: async () => {} },
    push: async () => {}, fetch: async () => { throw new Error('unused'); } });
  assert.match(await broken.pub.publish(agent), /no GitHub access/);
  const none = publisher({ creds: null });
  assert.match(await none.pub.publish(agent), /no GitHub access/);
  assert.deepEqual(none.pushes, []);
  const failed = publisher({ pushFails: true });
  assert.match(await failed.pub.publish(agent), /push failed/);
  assert.equal(failed.released.length, 1);
  assert.ok(!failed.calls.some((c) => c.method === 'POST'));
});

// The push script against real git: the agent's repo can carry hooks and config meant to run code where
// the token is, and none of it may run.
const hasGit = spawnSync('git', ['--version']).status === 0;
test('the push script copies the branch without running the agent repo\'s hooks or config', { skip: !hasGit }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', ...args], { cwd, encoding: 'utf8' });
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  git(src, 'init', '-q');
  git(src, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(src, 'checkout', '-q', '-b', 'fix/x');
  git(src, 'commit', '-q', '--allow-empty', '-m', 'work');
  const pwned = path.join(dir, 'pwned');
  for (const [k, v] of [['core.fsmonitor', `touch ${pwned}-fsmonitor; false`], ['uploadpack.packObjectsHook', `touch ${pwned}-hook;`],
    ['core.sshCommand', `touch ${pwned}-ssh`], ['credential.helper', `!touch ${pwned}-cred`]]) git(src, 'config', k, v);
  for (const h of ['pre-upload', 'post-checkout', 'reference-transaction']) {
    fs.writeFileSync(path.join(src, '.git', 'hooks', h), `#!/bin/sh\ntouch ${pwned}-${h}\n`, { mode: 0o755 });
  }
  // As root (a dev container), give the repo another owner, as the bind mount does on the PC.
  if (process.getuid?.() === 0) execFileSync('chown', ['-R', '65534', src]);
  const remote = path.join(dir, 'remote', 'o', 'r.git');
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare');
  // The same two scripts, piped together as the relay does, with the containers' paths moved into the
  // temp folder and github.com pointed at it. The fetch runs without the token, as in its container.
  const fetched = spawnSync('sh', ['-c', FETCH_SCRIPT.replace('file:///src', `file://${src}`).replaceAll('/tmp/r', path.join(dir, 'r'))],
    { env: { ...process.env, BRANCH: 'fix/x' } });
  assert.equal(fetched.status, 0, String(fetched.stderr));
  const pushed = spawnSync('sh', ['-c', PUSH_SCRIPT.replaceAll('/tmp/', `${dir}/`)], {
    input: fetched.stdout, encoding: 'utf8',
    env: { ...process.env, BRANCH: 'fix/x', REPO: 'o/r', GH_TOKEN: 't', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${path.join(dir, 'remote')}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' },
  });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(git(remote, 'log', '--format=%s', 'fix/x').trim(), 'work\ninit');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('pwned')), []);
});

test('the token and the agent repo never meet in one container', () => {
  assert.doesNotMatch(FETCH_SCRIPT, /GH_TOKEN|REPO/);
  assert.doesNotMatch(PUSH_SCRIPT, /\/src/);
});
