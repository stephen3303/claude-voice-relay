import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfirm, utterance } from './confirm.mjs';

const REPOS = { 'trading bot': '/p/Roundtable_Trading', 'voice relay': '/p/claude-voice-relay' };

function setup({ awaiting = false } = {}) {
  const sent = [];
  let clock = 1_000_000;
  const resolveProject = (s) => REPOS[s.toLowerCase().trim()] ?? null;
  const confirm = makeConfirm({
    // Like relay.mjs: "in <project>, <task>", or the project's name as the first words.
    parseTask(body) {
      const m = body.match(/^(?:in|on|for)\s+(.+?)\s*[,:;]\s*([\s\S]+)$/i);
      if (m && resolveProject(m[1])) return { repo: resolveProject(m[1]), task: m[2].trim() };
      const words = body.replace(/^(?:in|on|for)\s+/i, '').split(/\s+/);
      for (let k = Math.min(5, words.length - 1); k >= 1; k--) {
        const repo = resolveProject(words.slice(0, k).join(' '));
        if (repo) return { repo, task: words.slice(k).join(' ') };
      }
      return null;
    },
    resolveProject,
    spokenName: (repo) => repo.split('/').pop().replace(/[_\-.]+/g, ' '),
    agentAwaiting: () => awaiting,
    dispatch: async (text) => { sent.push(text); },
    now: () => clock,
  });
  const say = async (text) => { const r = confirm(text); await new Promise((r) => setImmediate(r)); return r; };
  return { say, sent, advance: (ms) => (clock += ms) };
}

test('a task is read back with its project, then "send it" starts it', async () => {
  const { say, sent } = setup();
  assert.equal(await say('task: in trading bot, add a stop-loss check'),
    'I heard: add a stop-loss check. That goes to Roundtable Trading. Say send it, or say the task again.');
  assert.deepEqual(sent, []);
  assert.equal(await say('task: Send it'), 'Sent.');
  assert.deepEqual(sent, ['task: in trading bot, add a stop-loss check']);
  assert.match(await say('send it'), /Nothing is waiting/, 'sent once only');
});

test('dictation variants of "send it" all confirm', async () => {
  for (const said of ['Send it.', 'sent it', 'send it please', 'Please send it', 'yes, send it', 'send that',
    'go ahead', 'Do it!', 'yes', 'OK send it', 'send it now', 'Send']) {
    const { say, sent } = setup();
    await say('task: in trading bot, add a stop-loss check');
    assert.equal(await say(`task: ${said}`), 'Sent.', said);
    assert.equal(sent.length, 1, said);
  }
});

test('saying the task again replaces it', async () => {
  const { say, sent } = setup();
  await say('task: in trading bot, add a stop loss');
  assert.match(await say('task: in voice relay, change the voice'), /That goes to claude voice relay/);
  await say('send it');
  assert.deepEqual(sent, ['task: in voice relay, change the voice']);
});

test('cancel drops the task', async () => {
  const { say, sent } = setup();
  await say('task: in trading bot, add a stop loss');
  assert.equal(await say('task: cancel'), 'Cancelled. Nothing sent.');
  assert.match(await say('send it'), /Nothing is waiting/);
  assert.deepEqual(sent, []);
});

test('an expired task is dropped, and the user is told why', async () => {
  const { say, sent, advance } = setup();
  await say('task: in trading bot, add a stop loss');
  advance(11 * 60_000);
  assert.equal(await say('send it'), 'That task waited over ten minutes, so I dropped it. Say the task again.');
  assert.match(await say('send it'), /Nothing is waiting/);
  assert.deepEqual(sent, []);
});

test('a task just under ten minutes old still sends', async () => {
  const { say, sent, advance } = setup();
  await say('task: in trading bot, add a stop loss');
  advance(9 * 60_000);
  assert.equal(await say('send it'), 'Sent.');
  assert.equal(sent.length, 1);
});

test('dictation that stops after the project name keeps the project and asks for the task', async () => {
  const { say, sent } = setup();
  assert.equal(await say('task: In voice relay'), 'That goes to claude voice relay. What should it do? Say the task again.');
  assert.equal(await say('send it'), 'I still need the task for claude voice relay. Say it again.');
  assert.equal(await say('task: send me a Telegram if you get this'),
    'I heard: send me a Telegram if you get this. That goes to claude voice relay. Say send it, or say the task again.');
  assert.equal(await say('send it'), 'Sent.');
  assert.deepEqual(sent, ['task: in claude voice relay, send me a Telegram if you get this']);
});

test('a task with no project is not held', async () => {
  const { say, sent } = setup();
  assert.match(await say('task: fix the bug'), /can't tell which project.*again/);
  assert.match(await say('send it'), /Nothing is waiting/);
  assert.match(await say('task: in the morning, fix the bug'), /can't tell which project/);
  assert.deepEqual(sent, []);
});

test('without the task prefix, anything said is held as an answer to the agent', async () => {
  const { say, sent } = setup();
  assert.equal(await say('The voice has not changed.'), 'I heard: The voice has not changed. Say send it, or say it again.');
  await say('send it');
  assert.deepEqual(sent, ['The voice has not changed.']);
});

test('with nothing held, "yes" answers a waiting agent but "send it" does not', async () => {
  const waiting = setup({ awaiting: true });
  assert.equal(await waiting.say('Yes'), 'Sent.');
  assert.deepEqual(waiting.sent, ['yes']);
  assert.match(await waiting.say('send it'), /Nothing is waiting/);

  const idle = setup();
  assert.match(await idle.say('yes'), /Nothing is waiting/);
  assert.deepEqual(idle.sent, []);
});

test('silence asks again, and every waiting reply says "again" so the Shortcut keeps listening', async () => {
  const { say } = setup();
  assert.equal(await say(''), "I didn't catch that. Say the task again.");
  assert.equal(await say('task:'), "I didn't catch that. Say the task again.");
  for (const r of [await say('task: in trading bot, x y'), await say('task: in voice relay'), await say('hello')]) {
    assert.match(r, /\bagain\b/);
  }
  assert.doesNotMatch(await say('send it'), /\bagain\b/);
  await say('hello');
  assert.doesNotMatch(await say('cancel'), /\bagain\b/);
});

test('a failing dispatch never breaks the reply', async () => {
  const logged = [];
  const confirm = makeConfirm({
    parseTask: () => ({ repo: '/p/x', task: 't' }), resolveProject: () => null, spokenName: () => 'x',
    agentAwaiting: () => false, dispatch: () => { throw new Error('docker down'); }, log: (...a) => logged.push(a.join(' ')),
  });
  confirm('task: in x, t');
  assert.equal(confirm('send it'), 'Sent.');
  await new Promise((r) => setImmediate(r));
  assert.ok(logged.some((l) => l.includes('docker down')));
});

test('the request body can be JSON, a form, or plain text', () => {
  assert.equal(utterance('{"text":" task: in x, y "}', 'application/json'), 'task: in x, y');
  assert.equal(utterance('text=task%3A+in+x%2C+y', 'application/x-www-form-urlencoded'), 'task: in x, y');
  assert.equal(utterance('said=send+it', 'application/x-www-form-urlencoded; charset=utf-8'), 'send it');
  assert.equal(utterance('', 'application/x-www-form-urlencoded'), '');
  assert.equal(utterance('task: send it', 'application/x-www-form-urlencoded'), 'task: send it');
  assert.equal(utterance('send it\n', 'text/plain'), 'send it');
  assert.equal(utterance('{"other":1}'), '{"other":1}');
});
