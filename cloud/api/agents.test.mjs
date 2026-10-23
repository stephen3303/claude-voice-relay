import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents, resolveProject, STALE_MS } from './agents.mjs';
import { OWNER, tokenHash } from './owner.mjs';

const PROJECTS = [
  { name: 'trading bot', repo: 'stephen3303/trading-bot', branch: 'main' },
  { name: 'claude voice relay', repo: 'stephen3303/claude-voice-relay', aliases: ['bridge'] },
];

// An in-memory version of index.mjs's agentStore, with the same conditions.
function setup({ runFails = false } = {}) {
  let clock = 10_000_000;
  const agents = new Map(), runs = [], stopped = [], statuses = [];
  const store = {
    projects: async () => PROJECTS,
    agents: async () => [...agents.values()].map((a) => structuredClone(a)),
    async claim(u, a, staleBefore) {
      const old = agents.get(a.key);
      if (old && old.busy && !(old.startedAt < staleBefore)) return false;
      agents.set(a.key, structuredClone(a)); return true;
    },
    async wake(u, key, text, run, now, staleBefore) {
      const a = agents.get(key);
      if (!a || (a.busy && !(a.startedAt < staleBefore))) return false;
      Object.assign(a, { busy: true, run, startedAt: now, lastAt: now, pending: [text], awaiting: false }); return true;
    },
    async queue(u, key, text, staleBefore) {
      const a = agents.get(key);
      if (!a?.busy || a.startedAt < staleBefore) return false;
      a.pending = [...(a.pending ?? []), text]; return true;
    },
    async update(u, key, fields, run) { const a = agents.get(key); if (a?.run === run) Object.assign(a, fields); },
    async remove(u, key) { agents.delete(key); },
    async answered(u, key, fields, hash) { const a = agents.get(key); if (a?.replyHash === hash) Object.assign(a, fields); },
    async setStatus(u, key, fields) { statuses.push({ u, key, fields }); },
  };
  const delivered = [];
  const tasks = makeAgents({
    store,
    runTask: async (u, key, run) => { if (runFails) throw new Error('no capacity'); runs.push({ u, key, run }); return `arn:task/${runs.length}`; },
    stopTask: async (arn) => stopped.push(arn),
    now: () => clock,
    deliver: async (u, text, from) => delivered.push({ u, text, from }),
  });
  const say = (text, project = null) => tasks.startTask(OWNER, { project, task: text });
  return { tasks, agents, runs, stopped, statuses, say, delivered, advance: (ms) => (clock += ms) };
}

test('projects resolve by name, alias or a unique word', () => {
  assert.equal(resolveProject('Trading Bot', PROJECTS).repo, 'stephen3303/trading-bot');
  assert.equal(resolveProject('bridge', PROJECTS).repo, 'stephen3303/claude-voice-relay');
  assert.equal(resolveProject('the voice thing', PROJECTS).repo, 'stephen3303/claude-voice-relay');
  assert.equal(resolveProject('nothing', PROJECTS), null);
});

test('only the owner gets agents', async () => {
  const { tasks, runs } = setup();
  assert.match(await tasks.startTask('apple.123', { project: 'trading bot', task: 'add tests' }), /aren't switched on yet/);
  assert.equal(runs.length, 0);
  assert.equal(await tasks.awaiting('apple.123'), false);
});

test('a new task starts a runner with a fresh cloud session', async () => {
  const { say, agents, runs } = setup();
  assert.equal(await say('add a stop-loss check', 'trading bot'), 'Starting trading bot.');
  const a = agents.get('tradingbot');
  assert.deepEqual(a.pending, ['add a stop-loss check']);
  assert.equal(a.cloudNew, true);
  assert.equal(a.busy, true);
  assert.equal(a.runArn, 'arn:task/1');
  assert.deepEqual(runs, [{ u: OWNER, key: 'tradingbot', run: a.run }]);
});

test('an unknown project or a photo sends nothing', async () => {
  const { tasks, say, runs } = setup();
  assert.match(await say('do it', 'nowhere'), /don't know a project called nowhere. Your projects are claude voice relay, trading bot\./);
  assert.match(await tasks.startTask(OWNER, { project: 'trading bot', task: 'look', photo: Buffer.from('x') }), /Nothing was sent/);
  assert.equal(runs.length, 0);
});

test('a busy agent refuses a new task until it goes stale', async () => {
  const { say, advance, runs } = setup();
  await say('one', 'trading bot');
  assert.match(await say('two', 'trading bot'), /still working/);
  advance(STALE_MS + 1);
  assert.equal(await say('two', 'trading bot'), 'Starting trading bot.');
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].run, runs[1].run);
});

test('a reply to a busy agent is queued; to an idle one it starts a runner on the same session', async () => {
  const { say, agents, runs } = setup();
  await say('one', 'trading bot');
  assert.match(await say('trading bot, also the README'), /busy. I'll pass that on/);
  assert.deepEqual(agents.get('tradingbot').pending, ['one', 'also the README']);
  Object.assign(agents.get('tradingbot'), { busy: false, pending: [], cloudId: 'sess_1', cloudNew: false, awaiting: true, question: 'Push it?' });
  assert.equal(await say('yes'), 'Sent to trading bot.');
  const a = agents.get('tradingbot');
  assert.deepEqual(a.pending, ['Yes, go ahead.']);
  assert.equal(a.cloudId, 'sess_1');
  assert.equal(runs.length, 2);
});

test('a bare reply goes to the agent waiting on you; with none it says so', async () => {
  const { say, agents, tasks } = setup();
  assert.match(await say('hello'), /No agent is waiting/);
  await say('one', 'trading bot');
  await say('two', 'bridge');
  Object.assign(agents.get('tradingbot'), { busy: false, pending: [], awaiting: true, lastAt: 1 });
  assert.equal(await tasks.awaiting(OWNER), true);
  assert.equal(await say('no'), 'Sent to trading bot.');
  assert.deepEqual(agents.get('tradingbot').pending, ["No, don't do that. Tell me what you would do instead."]);
});

test('status and stop', async () => {
  const { say, agents, stopped, advance } = setup();
  assert.equal(await say('status'), 'No agents.');
  await say('one', 'trading bot');
  advance(3 * 60_000);
  assert.equal(await say('status'), 'trading bot is working, 3 minutes in.');
  assert.match(await say('stop trading bot'), /Stopped listening to trading bot/);
  assert.deepEqual(stopped, ['arn:task/1']);
  assert.equal(agents.size, 0);
  assert.match(await say('usage'), /only for agents on your PC/);
});

test('a runner that fails to start leaves the agent idle and says why', async () => {
  const { say, agents } = setup({ runFails: true });
  assert.match(await say('one', 'trading bot'), /couldn't start trading bot's runner. no capacity/);
  assert.equal(agents.get('tradingbot').busy, false);
});

test('a task said without a comma still finds its project', async () => {
  const { tasks } = setup();
  assert.deepEqual(await tasks.splitTask(OWNER, 'in trading bot add a stop-loss check'), { project: 'trading bot', task: 'add a stop-loss check' });
  assert.deepEqual(await tasks.splitTask(OWNER, 'bridge fix the README'), { project: 'claude voice relay', task: 'fix the README' });
  assert.equal(await tasks.splitTask(OWNER, 'in nowhere do things'), null);
  assert.equal(await tasks.splitTask('apple.1', 'in trading bot add tests'), null);
});

test('with no projects saved it says to run the setup', async () => {
  const t = makeAgents({ store: { projects: async () => [] }, runTask: async () => 'arn', stopTask: async () => {} });
  assert.match(await t.startTask(OWNER, { project: 'x', task: 'y' }), /don't have any projects yet/);
});

test('a cloud session speaks its answer with its reply token, and only with it', async () => {
  const { tasks, agents, say, delivered } = setup();
  await say('add tests', 'trading bot');
  const token = `brt.tradingbot.${'A'.repeat(43)}`;
  agents.get('tradingbot').replyHash = tokenHash(token);
  assert.equal((await tasks.answer(`Bearer ${token}`, { spoken: 'SPOKEN: Should I push it?', question: true })).status, 200);
  assert.deepEqual(delivered, [{ u: OWNER, text: 'Should I push it?', from: 'trading bot' }]);
  assert.equal(agents.get('tradingbot').awaiting, true);
  assert.equal(agents.get('tradingbot').question, 'Should I push it?');
  assert.equal(await tasks.awaiting(OWNER), false, 'still busy in this fake');
  agents.get('tradingbot').busy = false;
  assert.equal(await tasks.awaiting(OWNER), true);
  assert.equal((await tasks.answer(`Bearer ${token}`, { spoken: 'Pushed.' })).status, 200);
  assert.equal(agents.get('tradingbot').awaiting, false);
  for (const bad of ['', 'Bearer x', `Bearer brt.tradingbot.${'B'.repeat(43)}`, `Bearer brt.nobody.${'A'.repeat(43)}`]) {
    assert.equal((await tasks.answer(bad, { spoken: 'hi' })).status, 401, bad);
  }
  assert.equal((await tasks.answer(`Bearer ${token}`, { spoken: '  ' })).status, 400);
  assert.equal(delivered.length, 2);
});

test("a worker's status file comes with its answer, or alone, and only with its reply token", async () => {
  const { tasks, agents, say, delivered, statuses } = setup();
  await say('add tests', 'trading bot');
  const token = `brt.tradingbot.${'A'.repeat(43)}`;
  agents.get('tradingbot').replyHash = tokenHash(token);
  const status = { health: 'On track', done: 'Added tests', inProgress: 'Opening a PR', where: 'https://github.com/x/y/pull/3', junk: 'dropped' };
  assert.equal((await tasks.answer(`Bearer ${token}`, { spoken: 'Tests added.', status })).status, 200);
  assert.deepEqual(statuses, [{ u: OWNER, key: 'tradingbot',
    fields: { health: 'on track', done: 'Added tests', inProgress: 'Opening a PR', where: 'https://github.com/x/y/pull/3' } }]);
  assert.deepEqual((await tasks.answer(`Bearer ${token}`, { status: { next: 'Merge it' } })), { status: 200, text: 'Status saved.' });
  assert.equal(delivered.length, 1, 'a status alone says nothing aloud');
  assert.equal((await tasks.answer(`Bearer brt.tradingbot.${'B'.repeat(43)}`, { status: { health: 'blocked' } })).status, 401);
  assert.equal(statuses.length, 2);
});
