import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_SCHEMA, agentArgs, budgetArg, quickLookArgs, QUICK_BASE, unknownFlag, describeTool, makeStreamReader, spoken, spokenReply } from './agent-turn.mjs';

test('agentArgs streams progress, asks for the structured reply and resumes the session', () => {
  const args = agentArgs({ systemPrompt: 'SP', sessionId: 'abc' });
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']);
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), REPLY_SCHEMA);
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'SP');
  assert.deepEqual(args.slice(-2), ['--resume', 'abc']);
  assert.ok(!agentArgs({ systemPrompt: 'SP' }).includes('--resume'));
  assert.ok(!args.includes('--max-budget-usd'));
});

test('a cost cap is added only for a positive AGENT_MAX_USD', () => {
  assert.deepEqual(budgetArg({ AGENT_MAX_USD: '5' }), ['--max-budget-usd', '5']);
  assert.deepEqual(agentArgs({ systemPrompt: 'SP', env: { AGENT_MAX_USD: '2.5' } }).slice(7, 9), ['--max-budget-usd', '2.5']);
  for (const v of [undefined, '', '0', '-1', 'lots']) assert.deepEqual(budgetArg({ AGENT_MAX_USD: v }), [], String(v));
});

test('the quick look runs Haiku at low effort, and falls back to the plain flags', () => {
  const args = quickLookArgs({});
  assert.deepEqual(args.slice(0, QUICK_BASE.length), QUICK_BASE);
  assert.deepEqual(args.slice(QUICK_BASE.length), ['--model', 'claude-haiku-5-5', '--effort', 'low', '--max-turns', '3']);
  assert.equal(quickLookArgs({ QUICK_LOOK_MODEL: 'claude-sonnet-5-5' })[QUICK_BASE.length + 1], 'claude-sonnet-5-5');
  assert.ok(unknownFlag("error: unknown option '--effort'"));
  assert.ok(!unknownFlag('Invalid API key'));
});

test('tool calls become words that read well aloud', () => {
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'Run the tests' }), 'run the tests');
  assert.equal(describeTool('Bash', { command: 'ls' }), 'running a command');
  assert.equal(describeTool('Bash', { description: 'Check `git status` | head' }), 'check git status head');
  assert.ok(describeTool('Bash', { description: 'word '.repeat(40) }).length <= 80);
  assert.equal(describeTool('Edit', { file_path: '/work/src/a.ts' }), 'editing files');
  assert.equal(describeTool('mcp__github__create_pr'), 'using a connected tool');
  assert.equal(describeTool('TodoWrite'), '');
  assert.equal(describeTool('Something'), 'working');
});

test('the stream reader reports tool calls and returns the result, across split chunks', () => {
  const seen = [];
  const reader = makeStreamReader((p) => seen.push(p));
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Run the tests' } }] } },
    { type: 'result', subtype: 'success', result: 'Done. SPOKEN: All good.', session_id: 's1', total_cost_usd: 0.12 },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
  for (let i = 0; i < lines.length; i += 17) reader.push(lines.slice(i, i + 17));
  assert.deepEqual(seen, ['reading the code', 'run the tests']);
  assert.equal(reader.result().session_id, 's1');
  assert.equal(reader.result().subtype, 'success');
});

test('the stream reader still reads a plain json result, and ignores junk lines', () => {
  const reader = makeStreamReader();
  reader.push('not json\n{"type":"result","result":"x","session_id":"s"}');
  assert.equal(reader.result().session_id, 's');
  assert.equal(makeStreamReader().result(), null);
});

test('a turn cut off before its result event has no result', () => {
  const reader = makeStreamReader();
  reader.push('{"type":"system","subtype":"init","session_id":"s"}\n{"type":"assistant","message":{"content":[]}}\n');
  assert.equal(reader.result(), null);
});

test('spokenReply prefers the structured reply and its needs_answer flag', () => {
  assert.deepEqual(spokenReply({ result: 'SPOKEN: ignored', structured_output: { spoken: ' Shall I  push it? ', needs_answer: true } }),
    { line: 'Shall I push it?', awaiting: true, error: false });
  // A rhetorical question mark no longer waits on the user when the agent says it doesn't need an answer.
  assert.equal(spokenReply({ structured_output: { spoken: 'Fixed, why not?', needs_answer: false } }).awaiting, false);
});

test('spokenReply falls back to the SPOKEN line, then the text', () => {
  assert.deepEqual(spokenReply({ result: 'Work.\nSPOKEN: Want me to push?' }), { line: 'Want me to push?', awaiting: true, error: false });
  assert.deepEqual(spokenReply({ result: 'oops', is_error: true, structured_output: { spoken: '' } }), { line: 'oops', awaiting: false, error: true });
  assert.equal(spoken(''), 'Finished, with no summary.');
  assert.equal(spoken('# Title\n**done**'), 'Title done');
});

test('spokenReply says why a turn stopped early', () => {
  const budget = spokenReply({ subtype: 'error_max_budget_usd', is_error: true });
  assert.match(budget.line, /cost limit/);
  assert.equal(budget.awaiting, true);
  assert.equal(spokenReply({ subtype: 'error_max_turns', is_error: true }).error, true);
});
