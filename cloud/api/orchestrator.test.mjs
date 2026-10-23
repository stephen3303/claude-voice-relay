import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOrchestrator, parseCommand, splitNames, spokenWhere, ago } from './orchestrator.mjs';
import { STALE_MS } from './agents.mjs';
import { OWNER } from './owner.mjs';

const HOUR = 3600_000;
const PROJECTS = [
  { name: 'trading bot', repo: 'stephen3303/trading-bot', aliases: ['the trader', 'trader'], tag: 'TB' },
  { name: 'claude voice relay', repo: 'stephen3303/claude-voice-relay', aliases: ['bridge'], tag: 'CVR' },
  { name: 'submarine program manager', repo: 'stephen3303/spm', tag: 'SPM' },
  { name: 'old notes', repo: 'stephen3303/old-notes', tag: 'ON' },
];

const clock = 100 * HOUR;
function setup({ statuses = [], agents = [] } = {}) {
  const o = makeOrchestrator({
    store: { projects: async () => PROJECTS, agents: async () => agents, statuses: async () => statuses },
    now: () => clock,
  });
  return { o, ask: (said) => o.handle(OWNER, said) };
}

test('commands are recognised however they are phrased, and anything else is left alone', () => {
  for (const s of ['Status on all programs.', 'status of all my projects', "what's the status on everything", 'all programs status'])
    assert.deepEqual(parseCommand(s), { kind: 'all' }, s);
  for (const s of ['What needs me?', 'anything need me', "what's waiting on me", 'what needs my attention'])
    assert.deepEqual(parseCommand(s), { kind: 'needs' }, s);
  assert.deepEqual(parseCommand('status on the trader and CVR'), { kind: 'some', names: ['trader', 'CVR'] });
  assert.deepEqual(parseCommand('Details on the trader'), { kind: 'details', name: 'trader' });
  assert.deepEqual(parseCommand('tell the trader to add a stop loss'), { kind: 'tell', name: 'trader', task: 'add a stop loss' });
  assert.deepEqual(parseCommand('morning briefing'), { kind: 'morning' });
  assert.deepEqual(parseCommand('give me the end of day brief'), { kind: 'evening' });
  for (const s of ['status', 'in trading bot add tests', 'yes', '']) assert.equal(parseCommand(s), null, s);
  assert.deepEqual(splitNames('a, b & the c plus d'), ['a', 'b', 'c', 'd']);
});

test('links are said, not spelled out', () => {
  assert.equal(spokenWhere('https://github.com/stephen3303/claude-voice-relay/pull/45'), 'pull request 45 in claude voice relay');
  assert.equal(spokenWhere('https://github.com/x/spm/issues/3'), 'issue 3 in spm');
  assert.equal(spokenWhere('https://github.com/x/spm/tree/feature/auth'), 'branch feature/auth in spm');
  assert.equal(spokenWhere('https://example.com/a?b=c'), 'a link in the status file');
  assert.equal(spokenWhere('PR-45'), 'pull request 45');
  assert.equal(ago(30_000), 'just now');
  assert.equal(ago(3 * HOUR), '3 hours ago');
});

test('status on all programs: blocked first, the quiet ones only counted', async () => {
  const { ask } = setup({ statuses: [
    { key: 'tradingbot', health: 'on track', done: 'Added the stop loss', updated: clock - HOUR },
    { key: 'submarineprogrammanager', health: 'blocked', needs: 'Which login provider to use', updated: clock - 2 * HOUR },
  ] });
  const { say } = await ask('status on all programs');
  assert.equal(say, '2 projects reporting: 1 blocked and 1 on track. '
    + 'submarine program manager, blocked. Needs you: Which login provider to use. '
    + 'trading bot, on track. Added the stop loss. 2 other projects with no report.');
});

test("live state outranks the file: a question or a run that went quiet needs attention", async () => {
  const { ask } = setup({
    statuses: [{ key: 'tradingbot', health: 'on track', updated: clock - HOUR }],
    agents: [
      { key: 'tradingbot', name: 'trading bot', busy: false, awaiting: true, question: 'Should I push it?' },
      { key: 'claudevoicerelay', name: 'claude voice relay', busy: true, startedAt: clock - STALE_MS - 1 },
      { key: 'oldnotes', name: 'old notes', busy: true, startedAt: clock - 60_000 },
    ],
  });
  const all = (await ask('status on all programs')).say;
  assert.match(all, /^2 projects reporting: 2 needs attention\. /);
  assert.match(all, /trading bot, needs attention\. Needs you: It asked: Should I push it\?/);
  assert.match(all, /claude voice relay, needs attention\. Its run went quiet without reporting\./);
  assert.match(all, /old notes, working, no report yet\. Working on it now\./);
  assert.equal((await ask('what needs me')).say, '1 project needs you. trading bot: It asked: Should I push it?');
});

test('details read the whole status file aloud; some projects give a little more than all', async () => {
  const { ask } = setup({ statuses: [{ key: 'tradingbot', health: 'needs attention', done: 'Added tests', inProgress: 'Fixing the timeout',
    id: 'TB-4', next: 'Open a pull request', needs: '', owner: 'worker', where: 'https://github.com/stephen3303/trading-bot/pull/7',
    overnight: 'A paper trading API key', updated: clock - 3 * HOUR }] });
  assert.equal((await ask('details on the trader')).say, 'trading bot. Updated 3 hours ago. Health: needs attention. Done: Added tests. '
    + 'In progress: Fixing the timeout. I D TB-4. Next: Open a pull request. Nothing needs you. Assigned to worker. '
    + 'Where: pull request 7 in trading bot. To keep going overnight: A paper trading API key.');
  assert.equal((await ask('details on nothing like it')).say, "I don't know a project called nothing like it.");
  const some = (await ask('status on the trader and zebra')).say;
  assert.equal(some, 'trading bot, needs attention. Done: Added tests. In progress: Fixing the timeout. Next: Open a pull request. I don\'t know "zebra".');
});

test('tell X to routes to the project by alias; an unknown name is not a command', async () => {
  const { ask } = setup();
  assert.deepEqual(await ask('tell the trader to add a stop loss'), { task: { project: 'trading bot', task: 'add a stop loss' } });
  assert.equal(await ask('tell me to stretch'), null);
  assert.equal(await ask('in trading bot add tests'), null);
});

test('briefings: headline, what needs a decision, then the rest; evening has the overnight plan', async () => {
  const { ask } = setup({
    statuses: [
      { key: 'tradingbot', health: 'on track', done: 'Added tests', next: 'Run the backtest', updated: clock - HOUR },
      { key: 'claudevoicerelay', health: 'needs attention', next: 'Wire the briefing', overnight: 'Approve the deploy', updated: clock - HOUR },
      { key: 'submarineprogrammanager', health: 'blocked', needs: 'Pick a login provider', updated: clock - HOUR },
    ],
  });
  assert.equal((await ask('morning briefing')).say, 'Good morning. 3 projects reporting: 1 blocked, 1 needs attention and 1 on track. '
    + 'Needs your decision: submarine program manager: Pick a login provider. '
    + 'claude voice relay, needs attention. trading bot, on track. Added tests. 1 other project with no report.');
  assert.equal((await ask('evening brief')).say, 'Good evening. Here is the overnight brief. '
    + 'Overnight plan. claude voice relay: Wire the briefing. trading bot: Run the backtest. '
    + 'Needs from you tonight. submarine program manager: Pick a login provider. claude voice relay: Approve the deploy. '
    + 'At risk of stopping overnight: submarine program manager and claude voice relay.');
});

test('only the owner has an orchestrator, and an empty registry says how to fill it', async () => {
  const { o } = setup();
  assert.equal(await o.handle('apple.1', 'status on all programs'), null);
  const empty = makeOrchestrator({ store: { projects: async () => [], agents: async () => [], statuses: async () => [] } });
  assert.match((await empty.handle(OWNER, 'what needs me')).say, /don't have any projects yet/);
});
