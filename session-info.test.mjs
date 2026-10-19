import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infoCommand, infoArgs, spokenUsage, spokenContext } from './session-info.mjs';

// Copied from Claude Code 2.1 print-mode output.
const USAGE = 'Total cost:            $0.4127\nTotal duration (API):  2m 31.4s\nTotal duration (wall): 9m 3s\n' +
  'Total code changes:    12 lines added, 3 lines removed\nUsage by model:\n    claude-opus-5-5:  1.2k input, 21 output ($0.4127)';
const CONTEXT = '## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 171k / 500k (34%)\n\n### Estimated usage by category\n';

const bot = { name: 'trading bot' };
const find = (rest) => (rest.toLowerCase() === 'trading bot' ? bot : null);

test('usage and context are commands, alone or with an agent name', () => {
  assert.deepEqual(infoCommand('usage', find), { kind: 'usage', agent: null });
  assert.deepEqual(infoCommand('Cost.', find), { kind: 'usage', agent: null });
  assert.deepEqual(infoCommand('/context', find), { kind: 'context', agent: null });
  assert.deepEqual(infoCommand('usage for trading bot?', find), { kind: 'usage', agent: bot });
  assert.deepEqual(infoCommand('Context trading bot', find), { kind: 'context', agent: bot });
});

test('a longer sentence stays a message to the agent', () => {
  assert.equal(infoCommand('context is in the README', find), null);
  assert.equal(infoCommand('usage of the API should drop', find), null);
  assert.equal(infoCommand('contextual help please', find), null);
  assert.equal(infoCommand('what is the usage', find), null);
});

test('the session is resumed on a fork that is not saved', () => {
  const args = infoArgs('abc-123');
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'abc-123']);
  assert.ok(args.includes('--fork-session') && args.includes('--no-session-persistence') && args.includes('-p'));
});

test('usage is spoken in dollars and minutes', () => {
  assert.equal(spokenUsage('Trading bot', USAGE), 'Trading bot has used 41 cents at API prices on this task, with 3 minutes of model time.');
  assert.equal(spokenUsage('X', 'Total cost: $0.0041\nTotal duration (API):  1s'), 'X has used less than a cent at API prices on this task, with 1 second of model time.');
  assert.equal(spokenUsage('X', 'Total cost: $12.5'), 'X has used 12.50 dollars at API prices on this task.');
  assert.equal(spokenUsage('X', 'Total cost: $3.00\nTotal duration (API): 1h 2m'), 'X has used 3 dollars at API prices on this task, with 62 minutes of model time.');
  assert.equal(spokenUsage('X', 'Unknown command'), "I couldn't read X's usage.");
});

test('context is spoken as a percentage of the window', () => {
  assert.equal(spokenContext('Trading bot', CONTEXT), 'Trading bot is using 34 percent of its context, out of 500 thousand tokens.');
  assert.equal(spokenContext('X', '**Tokens:** 400k / 1m (40%)'), 'X is using 40 percent of its context, out of 1 million tokens.');
  assert.equal(spokenContext('X', ''), "I couldn't read X's context.");
});
