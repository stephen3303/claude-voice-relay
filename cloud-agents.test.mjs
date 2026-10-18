import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cloudArgs, cloudEnv, parseCloud, runCloud, makeCloudTurn, CLOUD_PROMPT } from './cloud-agents.mjs';

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const p = new EventEmitter();
    p.kill = () => { calls.killed = true; setImmediate(() => p.emit('close', null)); };
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = new EventEmitter();
    p.stdin.end = (input) => {
      calls.push({ cmd, args, opts, input });
      if (!hang) setImmediate(() => {
        if (stdout) p.stdout.emit('data', stdout);
        if (stderr) p.stderr.emit('data', stderr);
        p.emit('close', code);
      });
    };
    return p;
  };
  return { spawn, calls };
}

test('cloudArgs starts a new cloud session, or continues one by id, with only fixed flags', () => {
  assert.deepEqual(cloudArgs(), ['-p', '--output-format', 'json', '--append-system-prompt', CLOUD_PROMPT, '--cloud']);
  assert.deepEqual(cloudArgs('cse_01ABC-x_9').slice(-2), ['--cloud', 'cse_01ABC-x_9']);
  for (const bad of ['--resume', 'a b', 'x;rm', '', 'x'.repeat(101)]) assert.throws(() => cloudArgs(bad), /Bad cloud session id/, bad);
});

test('cloudEnv passes only what the CLI needs, never the relay\'s secrets or the setup token', () => {
  const env = { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\steph', APPDATA: 'x', SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'p',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat', ANTHROPIC_API_KEY: 'sk-ant-api', VOICE_TOKEN: 'v', AGENT_GH_TOKEN: 'g',
    GITHUB_APP_KEY_FILE: 'k.pem', OPENAI_API_KEY: 'o' };
  assert.deepEqual(Object.keys(cloudEnv(env)).sort(), ['APPDATA', 'HTTPS_PROXY', 'Path', 'SystemRoot', 'USERPROFILE']);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat'); // the relay's own environment is untouched
});

test('parseCloud reads a waited-for reply, a queued follow-up and failures', () => {
  const reply = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.\nSPOKEN: All done.',
    session_id: 'cse_1', session_url: 'https://claude.ai/code/cse_1' });
  assert.deepEqual(parseCloud(`noise\n${reply}\n`, '', 0),
    { result: 'Done.\nSPOKEN: All done.', is_error: false, session_id: 'cse_1', url: 'https://claude.ai/code/cse_1' });
  assert.equal(parseCloud(JSON.stringify({ is_error: true, result: 'Execution error', session_id: 'cse_1' }), '', 1).is_error, true);
  assert.deepEqual(parseCloud(JSON.stringify({ ok: true, session_id: 'cse_2', url: 'https://claude.ai/code/cse_2' }), '', 0),
    { result: '', is_error: false, session_id: 'cse_2', url: 'https://claude.ai/code/cse_2', queued: true });
  assert.throws(() => parseCloud(JSON.stringify({ ok: false, session_id: 'cse_2', error: 'session is archived' }), '', 1), /archived/);
  assert.throws(() => parseCloud('', 'Error: Run `claude auth login`\n', 1), /claude auth login/);
  assert.throws(() => parseCloud('', '', 2), /claude exited 2/);
});

test('runCloud sends the prompt over stdin from the project folder and returns the reply', async () => {
  const { spawn, calls } = fakeSpawn({ stdout: JSON.stringify({ is_error: false, result: 'SPOKEN: Hi.', session_id: 'cse_9' }) });
  const r = await runCloud({ spawn, claudeBin: 'claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/h' },
    cwd: '/p/trading-bot', sessionId: null, prompt: 'add a stop-loss --dangerously "check"' });
  assert.equal(r.session_id, 'cse_9');
  const [c] = calls;
  assert.equal(c.cmd, 'claude');
  assert.equal(c.opts.cwd, '/p/trading-bot');
  assert.deepEqual(c.opts.env, { HOME: '/h' });
  assert.equal(c.input, 'add a stop-loss --dangerously "check"');
  assert.ok(!c.args.some((x) => x.includes('stop-loss')));
});

test('runCloud rejects when the CLI fails', async () => {
  const { spawn } = fakeSpawn({ stderr: 'Error: Unable to get organization UUID', code: 1 });
  await assert.rejects(runCloud({ spawn, env: {}, cwd: '/p', prompt: 'x' }), /organization UUID/);
});

test('runCloud kills a CLI that never answers', async () => {
  const { spawn, calls } = fakeSpawn({ hang: true });
  await assert.rejects(runCloud({ spawn, env: {}, cwd: '/p', prompt: 'x', timeoutMs: 20 }), /no answer after .*Claude app/);
  assert.equal(calls.killed, true);
});

test('runCloud rejects when claude is not installed', async () => {
  const spawn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = new EventEmitter();
    p.stdin.end = () => setImmediate(() => p.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return p;
  };
  await assert.rejects(runCloud({ spawn, env: {}, cwd: '/p', prompt: 'x', timeoutMs: 1000 }), /ENOENT/);
});

function turnHarness({ reply = { result: 'SPOKEN: Done.', is_error: false, session_id: 'cse_1', url: 'u1' }, creds = { token: 't' }, exists = true } = {}) {
  const runs = [], said = [], spoken = [], released = [];
  const agentGitHub = {
    pinNow: async () => {},
    credentials: async () => creds,
    release: async (c) => { released.push(c); },
  };
  const cloudTurn = makeCloudTurn({
    run: async (o) => { runs.push(o); if (reply instanceof Error) throw reply; return reply; },
    agentGitHub, exists: () => exists, say: (t, o) => said.push(o?.spoken ?? t), speakResult: (a, r) => spoken.push(r.result),
  });
  return { cloudTurn, runs, said, spoken, released };
}
const newAgent = () => ({ name: 'trading bot', repoPath: '/p/trading-bot', cloudNew: true });

test('cloudTurn starts a new task as a session after the repo check, then continues it', async () => {
  const h = turnHarness();
  const a = newAgent();
  await h.cloudTurn(a, 'add a stop-loss');
  assert.deepEqual(h.runs[0], { cwd: '/p/trading-bot', sessionId: undefined, prompt: 'add a stop-loss' });
  assert.deepEqual(h.released, [{ token: 't' }]);
  assert.deepEqual(h.spoken, ['SPOKEN: Done.']);
  assert.equal(a.cloudId, 'cse_1');
  assert.equal(a.cloudNew, false);
  await h.cloudTurn(a, 'Yes, go ahead.');
  assert.equal(h.runs[1].sessionId, 'cse_1');
  assert.equal(h.released.length, 1); // the check runs once per task
});

test('cloudTurn starts nothing for a repo without the protection the relay requires', async () => {
  const h = turnHarness({ creds: null });
  const a = newAgent();
  await assert.rejects(h.cloudTurn(a, 'x'), /isn't set up for agents/);
  assert.equal(h.runs.length, 0);
  assert.equal(a.cloudNew, true); // nothing started, so the task can be retried
});

test('cloudTurn refuses a reply with no session to go to', async () => {
  for (const a of [{ name: 'bot', repoPath: '/p', sessionId: 'docker-1' }, { name: 'bot', repoPath: '/p' }]) {
    const h = turnHarness();
    await assert.rejects(h.cloudTurn(a, 'Yes, go ahead.'), /Start a new task/);
    assert.equal(h.runs.length, 0);
  }
});

test('a failed first turn is not retried as a new session by the next reply', async () => {
  const h = turnHarness({ reply: new Error('no answer after 60 minutes') });
  const a = newAgent();
  await assert.rejects(h.cloudTurn(a, 'add a stop-loss'), /no answer/);
  await assert.rejects(h.cloudTurn(a, 'Yes, go ahead.'), /Start a new task/);
  assert.equal(h.runs.length, 1);
});

test('cloudTurn says when a follow-up was only queued, and stays quiet once stopped', async () => {
  const q = turnHarness({ reply: { result: '', is_error: false, session_id: 'cse_1', url: 'u1', queued: true } });
  const a = { name: 'bot', repoPath: '/p', cloudId: 'cse_1' };
  await q.cloudTurn(a, 'and the tests');
  assert.deepEqual(q.said, ['Sent to bot. Its answer will be in the Claude app.']);
  assert.equal(q.spoken.length, 0);
  const s = turnHarness();
  const b = { ...newAgent(), stopped: true };
  await s.cloudTurn(b, 'x');
  assert.equal(s.spoken.length + s.said.length, 0);
});

test('cloudTurn refuses a folder that does not exist', async () => {
  const h = turnHarness({ exists: false });
  await assert.rejects(h.cloudTurn(newAgent(), 'x'), /doesn't exist yet/);
});
