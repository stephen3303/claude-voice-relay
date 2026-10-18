import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cloudArgs, cloudEnv, parseCloud, runCloud, makeCloudTurn, resolveClaude, CLOUD_PROMPT } from './cloud-agents.mjs';

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
  assert.deepEqual(cloudArgs(), ['-p', '--output-format', 'json', '--setting-sources', 'user', '--append-system-prompt', CLOUD_PROMPT, '--cloud']);
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
  const r = await runCloud({ spawn, claudeBin: '/usr/bin/claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/h' },
    cwd: '/p/trading-bot', sessionId: null, prompt: 'add a stop-loss --dangerously "check"' });
  assert.equal(r.session_id, 'cse_9');
  const [c] = calls;
  assert.equal(c.cmd, '/usr/bin/claude');
  assert.equal(c.opts.cwd, '/p/trading-bot');
  assert.deepEqual(c.opts.env, { HOME: '/h' });
  assert.equal(c.input, 'add a stop-loss --dangerously "check"');
  assert.ok(!c.args.some((x) => x.includes('stop-loss')));
});

test('runCloud rejects when the CLI fails', async () => {
  const { spawn } = fakeSpawn({ stderr: 'Error: Unable to get organization UUID', code: 1 });
  await assert.rejects(runCloud({ spawn, claudeBin: '/usr/bin/claude', env: {}, cwd: '/p', prompt: 'x' }), /organization UUID/);
});

test('runCloud kills a CLI that never answers', async () => {
  const { spawn, calls } = fakeSpawn({ hang: true });
  await assert.rejects(runCloud({ spawn, claudeBin: '/usr/bin/claude', env: {}, cwd: '/p', prompt: 'x', timeoutMs: 20 }), /no answer after .*Claude app/);
  assert.equal(calls.killed, true);
});

test('runCloud rejects when claude is not installed', async () => {
  const spawn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = new EventEmitter();
    p.stdin.end = () => setImmediate(() => p.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return p;
  };
  await assert.rejects(runCloud({ spawn, claudeBin: '/usr/bin/claude', env: {}, cwd: '/p', prompt: 'x', timeoutMs: 1000 }), /ENOENT/);
});

function turnHarness({ reply = { result: 'SPOKEN: Done.', is_error: false, session_id: 'cse_1', url: 'u1' }, why = '', exists = true, unsafe = false, during } = {}) {
  const runs = [], said = [], spoken = [], checked = [], saves = [];
  const cloudTurn = makeCloudTurn({
    run: async (o) => { runs.push(o); if (during) during(o); if (reply instanceof Error) throw reply; return reply; },
    save: () => saves.push(1),
    checkRepo: async (a) => { checked.push(a.name); return why; },
    unsafe: () => unsafe,
    exists: () => exists, say: (t, o) => said.push(o?.spoken ?? t), speakResult: (a, r) => spoken.push(r.result),
  });
  return { cloudTurn, runs, said, spoken, checked, saves };
}
const newAgent = () => ({ name: 'trading bot', repoPath: '/p/trading-bot', cloudNew: true });

test('cloudTurn starts a new task as a session after the repo check, then continues it', async () => {
  const h = turnHarness();
  const a = newAgent();
  await h.cloudTurn(a, 'add a stop-loss');
  const { cwd, sessionId, prompt } = h.runs[0];
  assert.deepEqual({ cwd, sessionId, prompt }, { cwd: '/p/trading-bot', sessionId: undefined, prompt: 'add a stop-loss' });
  assert.deepEqual(h.checked, ['trading bot']);
  assert.deepEqual(h.spoken, ['SPOKEN: Done.']);
  assert.equal(a.cloudId, 'cse_1');
  assert.equal(a.cloudNew, false);
  await h.cloudTurn(a, 'Yes, go ahead.');
  assert.equal(h.runs[1].sessionId, 'cse_1');
  assert.equal(h.checked.length, 1); // the check runs once per task
});

test('cloudTurn starts nothing for a repo without the protection the relay requires', async () => {
  const h = turnHarness({ why: "its repo isn't set up for agents yet." });
  const a = newAgent();
  await assert.rejects(h.cloudTurn(a, 'x'), /isn't set up for agents/);
  assert.equal(h.runs.length, 0);
  // A later reply can't become a session's whole task, even once the repo passes.
  await assert.rejects(h.cloudTurn(a, 'Yes, go ahead.'), /Start a new task/);
  assert.equal(h.runs.length, 0);
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

test('a CLI failure after the session exists keeps its id, so a reply can reach it', async () => {
  const { spawn } = fakeSpawn({ stderr: 'Cloud session: cse_7 (https://claude.ai/code/cse_7)\nError: the cloud session stopped before it produced a result', code: 1 });
  const e = await runCloud({ spawn, claudeBin: '/usr/bin/claude', env: {}, cwd: '/p', prompt: 'x' }).catch((x) => x);
  assert.match(e.message, /stopped before/);
  assert.equal(e.sessionId, 'cse_7');
  assert.equal(e.url, 'https://claude.ai/code/cse_7');

  const h = turnHarness({ reply: e });
  const a = newAgent();
  await assert.rejects(h.cloudTurn(a, 'add a stop-loss'), /stopped before/);
  assert.equal(a.cloudId, 'cse_7');
  await assert.rejects(h.cloudTurn(a, 'Yes, go ahead.'), /stopped before/); // the harness keeps failing,
  assert.equal(h.runs[1].sessionId, 'cse_7'); // but the reply went to the same session
});

test('cloudTurn refuses the relay\'s own folder, before any check or session', async () => {
  const h = turnHarness({ unsafe: true });
  await assert.rejects(h.cloudTurn(newAgent(), 'x'), /holds the relay or its keys/);
  assert.equal(h.checked.length + h.runs.length, 0);
});

test('resolveClaude finds claude by full path on PATH only, never in the current folder', () => {
  const files = new Set(['C:\\Users\\steph\\.local\\bin\\claude.exe', '/usr/local/bin/claude']);
  const isFile = (f) => files.has(f);
  assert.equal(resolveClaude({ env: { Path: '.;relative;C:\\Users\\steph\\.local\\bin' }, platform: 'win32', isFile }),
    'C:\\Users\\steph\\.local\\bin\\claude.exe');
  assert.equal(resolveClaude({ env: { PATH: '/usr/local/bin' }, platform: 'linux', isFile }), '/usr/local/bin/claude');
  assert.equal(resolveClaude({ env: { PATH: '.' }, platform: 'linux', isFile }), null);
  assert.equal(resolveClaude({ bin: './claude', env: {}, platform: 'linux', isFile }), null);
  assert.equal(resolveClaude({ bin: '/usr/local/bin/claude', env: {}, platform: 'linux', isFile }), '/usr/local/bin/claude');
});

test('runCloud refuses a claude that is not a full path, or lives in the project folder', async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{}' });
  for (const claudeBin of [null, 'claude', '/p/trading-bot/claude', '/p/trading-bot/bin/claude']) {
    await assert.rejects(runCloud({ spawn, claudeBin, env: {}, cwd: '/p/trading-bot', prompt: 'x' }), /CLAUDE_BIN/, String(claudeBin));
  }
  assert.equal(calls.length, 0);
});

test('a new session id is saved as soon as the CLI reports it, and the child is kept for stop', async () => {
  const seen = {};
  const a = newAgent();
  const h = turnHarness({ during: (o) => {
    o.onSpawn('child');
    seen.proc = a.proc;
    o.onSession('cse_5', 'https://claude.ai/code/cse_5');
    seen.id = a.cloudId;
  } });
  await h.cloudTurn(a, 'x');
  assert.equal(seen.proc, 'child');
  assert.equal(seen.id, 'cse_5'); // before the turn finished
  assert.equal(h.saves.length, 1);
  assert.equal(a.proc, null);
});

test('runCloud passes a leading slash as words, not as a slash command, and reports the session early', async () => {
  const { spawn, calls } = fakeSpawn({ stderr: 'Cloud session: cse_8 (https://claude.ai/code/cse_8)\n',
    stdout: JSON.stringify({ is_error: false, result: 'SPOKEN: Ok.', session_id: 'cse_8' }) });
  const sessions = [];
  let child;
  await runCloud({ spawn, claudeBin: '/usr/bin/claude', env: {}, cwd: '/p', prompt: '/logout please',
    onSession: (id) => sessions.push(id), onSpawn: (p) => { child = p; } });
  assert.equal(calls[0].input, 'The user said: /logout please');
  assert.deepEqual(sessions, ['cse_8']);
  assert.ok(child);
});
