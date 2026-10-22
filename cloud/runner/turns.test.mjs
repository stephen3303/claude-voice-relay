import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunner, spokenError, NO_ROUTINE, NO_LOGIN } from './turns.mjs';
import { WAIT_PROMPT } from '../../cloud-agents.mjs';

// One agent record with main.mjs's conditional writes, in memory.
function setup({ agent = {}, results = [] } = {}) {
  const rec = { name: 'trading bot', repo: 'stephen3303/trading-bot', branch: 'main', busy: true, run: 'r1',
    cloudId: null, cloudNew: true, pending: ['add tests'], ...agent };
  const said = [], notified = [], runs = [], prepared = [], fired = [], started = [];
  const store = {
    async take(u, k, run) {
      if (rec.run !== run || !rec.pending.length) return null;
      const { pending, ...a } = structuredClone(rec);
      rec.pending = rec.pending.slice(1);
      return { agent: a, text: pending[0] };
    },
    async finish(u, k, run) { if (rec.run !== run || rec.pending.length) return false; rec.busy = false; return true; },
    async isRun(u, k, run) { return rec.run === run; },
    async update(u, k, fields, run) { if (rec.run === run) Object.assign(rec, fields); },
  };
  const runner = makeRunner({
    store,
    prepare: async (a, dir) => prepared.push(dir),
    run: async (o) => {
      runs.push({ sessionId: o.sessionId, prompt: o.prompt });
      const r = results.shift() ?? { result: 'Done. SPOKEN: All done.', is_error: false, session_id: 'sess_1', url: 'https://claude.ai/code/sess_1' };
      if (r instanceof Error) throw r;
      if (r.hook) r.hook(rec);
      o.onSession?.(r.session_id, r.url);
      return r;
    },
    deliver: async (u, text, from) => said.push({ text, from }),
    notify: async (text) => notified.push(text),
    startSession: agent.noRoutine ? null : async (text) => { started.push(text); return { sessionId: 'sess_1', url: 'https://claude.ai/code/sess_1' }; },
    fireRoutine: agent.routine ? async () => { fired.push(1); return 'sess_r'; } : null,
    workRoot: '/work',
    exists: () => true,
  });
  return { rec, runner, said, notified, runs, prepared, fired, started };
}

test('starts a new task through the task routine, waits on its session, speaks the answer and goes idle', async () => {
  const { rec, runner, said, notified, runs, prepared, started } = setup();
  await runner('owner', 'tradingbot', 'r1');
  assert.deepEqual(started, ['Repository: stephen3303/trading-bot\nBranch: main\n\nadd tests']);
  assert.deepEqual(runs, [{ sessionId: 'sess_1', prompt: WAIT_PROMPT }]);
  assert.deepEqual(prepared, ['/work/tradingbot']);
  assert.deepEqual(said, [{ text: 'All done.', from: 'trading bot' }]);
  assert.deepEqual(notified, ['trading bot: All done.']);
  assert.equal(rec.busy, false);
  assert.equal(rec.cloudId, 'sess_1');
  assert.equal(rec.cloudNew, false);
  assert.equal(rec.awaiting, false);
});

test('a reply queued mid-turn runs next, on the same session', async () => {
  const { rec, runner, runs } = setup({ results: [
    { result: 'SPOKEN: Should I push it?', is_error: false, session_id: 'sess_1', url: 'u', hook: (r) => r.pending.push('Yes, go ahead.') },
    { result: 'SPOKEN: Pushed.', is_error: false, session_id: 'sess_1', url: 'u' },
  ] });
  await runner('owner', 'tradingbot', 'r1');
  assert.deepEqual(runs.map((r) => r.sessionId), ['sess_1', 'sess_1']);
  assert.deepEqual(runs.map((r) => r.prompt), [WAIT_PROMPT, 'Yes, go ahead.']);
  assert.equal(rec.busy, false);
  assert.equal(rec.awaiting, false);
});

test('a question leaves the agent waiting for the answer', async () => {
  const { rec, runner, said } = setup({ results: [{ result: 'SPOKEN: Should I push it?', is_error: false, session_id: 's', url: 'u' }] });
  await runner('owner', 'tradingbot', 'r1');
  assert.equal(rec.awaiting, true);
  assert.equal(rec.question, 'Should I push it?');
  assert.equal(said[0].text, 'Should I push it?');
});

test('a failed turn is spoken and the agent still goes idle', async () => {
  const { rec, runner, said } = setup({ results: [new Error('not signed in')] });
  await runner('owner', 'tradingbot', 'r1');
  assert.match(said[0].text, /trading bot failed. not signed in/);
  assert.equal(rec.busy, false);
});

test('after stop (another run took the agent) nothing is spoken or written', async () => {
  const { rec, runner, said } = setup({ results: [{ result: 'SPOKEN: Done.', is_error: false, session_id: 's', url: 'u', hook: (r) => { r.run = 'r2'; } }] });
  await runner('owner', 'tradingbot', 'r1');
  assert.deepEqual(said, []);
  assert.equal(rec.busy, true, "the new run's state is untouched");
  assert.equal(rec.cloudId, null);
});

test('a reply with no session to go to says so instead of starting one', async () => {
  const { runner, runs, said } = setup({ agent: { cloudNew: false, pending: ['yes'] } });
  await runner('owner', 'tradingbot', 'r1');
  assert.equal(runs.length, 0);
  assert.match(said[0].text, /lost track of its cloud session/);
});

test('with the project routine set up, a new session is marked and the routine fires once it is done', async () => {
  const { runner, started, fired } = setup({ agent: { routine: true } });
  await runner('owner', 'tradingbot', 'r1');
  assert.match(started[0], /\n\nBridge voice task: add tests$/);
  assert.equal(fired.length, 1);
});

test('without the task routine a new task says how to set it up, and nothing runs', async () => {
  const { rec, runner, said, runs } = setup({ agent: { noRoutine: true } });
  await runner('owner', 'tradingbot', 'r1');
  assert.deepEqual(runs, []);
  assert.equal(said[0].text, `trading bot failed. ${NO_ROUTINE}`);
  assert.equal(rec.busy, false);
});

test('spokenError keeps whole sentences instead of cutting mid-word', () => {
  assert.equal(spokenError('short.'), 'short.');
  const long = `${'First sentence is here. '.repeat(10)}Then a very long tail that would be cut`;
  const out = spokenError(long, 100);
  assert.ok(out.length <= 100);
  assert.match(out, /here\.$/);
  assert.match(spokenError('word '.repeat(50), 60), /word…$/);
  assert.equal(spokenError('Cloud sessions need a claude.ai sign-in. Run `claude auth login` (or /login in a local session), then try again.'), NO_LOGIN);
});
