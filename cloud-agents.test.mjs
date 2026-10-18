import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cloudArgs, cloudEnv, parseCloud, runCloud, CLOUD_PROMPT } from './cloud-agents.mjs';

function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = new EventEmitter();
    p.stdin.end = (input) => {
      calls.push({ cmd, args, opts, input });
      setImmediate(() => {
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

test('cloudEnv drops the setup token and API key so the claude.ai sign-in is used', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat', ANTHROPIC_API_KEY: 'sk-ant-api' };
  assert.deepEqual(cloudEnv(env), { PATH: '/bin' });
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
