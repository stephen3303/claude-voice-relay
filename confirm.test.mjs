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
    "Here's your message to Claude for Roundtable Trading, add a stop-loss check. Ready to send it?");
  assert.deepEqual(sent, []);
  assert.equal(await say('task: Send it'), 'Sent.');
  assert.deepEqual(sent, [{ repo: '/p/Roundtable_Trading', task: 'add a stop-loss check' }]);
  assert.match(await say('send it'), /nothing to send/, 'sent once only');
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
  assert.match(await say('task: in voice relay, change the voice'), /message to Claude for claude voice relay, change the voice/);
  await say('send it');
  assert.deepEqual(sent, [{ repo: '/p/claude-voice-relay', task: 'change the voice' }]);
});

test('cancel drops the task', async () => {
  const { say, sent } = setup();
  await say('task: in trading bot, add a stop loss');
  assert.equal(await say('task: cancel'), "OK, I won't send it.");
  assert.match(await say('send it'), /nothing to send/);
  assert.deepEqual(sent, []);
});

test('an expired task is dropped, and the user is told why', async () => {
  const { say, sent, advance } = setup();
  await say('task: in trading bot, add a stop loss');
  advance(11 * 60_000);
  assert.equal(await say('send it'), "That message waited over ten minutes, so I didn't send it. What do you want to send?");
  assert.match(await say('send it'), /nothing to send/);
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
  assert.equal(await say('task: In voice relay'), 'What do you want to tell claude voice relay?');
  assert.equal(await say('send it'), 'What do you want to tell claude voice relay?');
  assert.equal(await say('task: send me a Telegram if you get this'),
    "Here's your message to Claude for claude voice relay, send me a Telegram if you get this. Ready to send it?");
  assert.equal(await say('send it'), 'Sent.');
  assert.deepEqual(sent, [{ repo: '/p/claude-voice-relay', task: 'send me a Telegram if you get this' }]);
});

test('the task after a project named on its own can come without the task prefix (glasses app)', async () => {
  const { say, sent } = setup();
  await say('task: in voice relay');
  assert.equal(await say('change the voice'),
    "Here's your message to Claude for claude voice relay, change the voice. Ready to send it?");
  assert.equal(await say('send it'), 'Sent.');
  assert.deepEqual(sent, [{ repo: '/p/claude-voice-relay', task: 'change the voice' }]);
});

test('a held project is kept unless an exact project name replaces it', async () => {
  const { say, sent } = setup();
  await say('task: in voice relay');
  assert.match(await say('task: for the README, fix typos'), /Here's your message to Claude for claude voice relay, for the README, fix typos\./);
  await say('task: in voice relay');
  assert.match(await say('task: in trading bot, add a stop loss'), /message to Claude for Roundtable Trading, add a stop loss/);
  await say('send it');
  assert.deepEqual(sent, [{ repo: '/p/Roundtable_Trading', task: 'add a stop loss' }]);
});

test('a task with no project is not held', async () => {
  const { say, sent } = setup();
  assert.match(await say('task: fix the bug'), /can't tell which project.*\?/);
  assert.match(await say('send it'), /nothing to send/);
  assert.match(await say('task: in the morning, fix the bug'), /can't tell which project/);
  assert.deepEqual(sent, []);
});

test('without the task prefix, anything said is held as an answer to the agent', async () => {
  const { say, sent } = setup();
  assert.equal(await say('The voice has not changed.'), "Here's your message to Claude, The voice has not changed. Ready to send it?");
  await say('send it');
  assert.deepEqual(sent, ['The voice has not changed.']);
});

test('with nothing held, "yes" answers a waiting agent but "send it" does not', async () => {
  const waiting = setup({ awaiting: true });
  assert.equal(await waiting.say('Yes'), 'Sent.');
  assert.deepEqual(waiting.sent, ['yes']);
  assert.match(await waiting.say('send it'), /nothing to send/);

  const expired = setup({ awaiting: true });
  await expired.say('task: in trading bot, add a stop loss');
  expired.advance(11 * 60_000);
  assert.match(await expired.say('go ahead'), /waited over ten minutes/, 'meant for the expired task, not the agent');
  assert.deepEqual(expired.sent, []);

  const idle = setup();
  assert.match(await idle.say('yes'), /nothing to send/);
  assert.deepEqual(idle.sent, []);
});

test('silence asks again, and every waiting reply is a question so the Shortcut keeps listening', async () => {
  const { say, sent } = setup();
  assert.equal(await say(''), "I didn't catch that. What do you want to send?");
  assert.equal(await say('task:'), "I didn't catch that. What do you want to send?");
  for (const r of [await say('task: in trading bot, x y'), await say('change it'), await say('task: in voice relay'),
    await say('hello'), await say('task: fix the bug'), await say('send it')]) {
    assert.match(r, /\?/);
  }
  assert.deepEqual(sent, []);
  await say('hello');
  assert.doesNotMatch(await say('send it'), /\?/);
  await say('hello');
  assert.doesNotMatch(await say('cancel'), /\?/);
});

test('"change it" asks for new words and keeps the project, like Siri', async () => {
  const { say, sent } = setup();
  await say('task: in trading bot, add a stop loss');
  assert.equal(await say('task: Change it.'), 'OK. What do you want to tell Roundtable Trading?');
  assert.match(await say('send it'), /What do you want to tell Roundtable Trading\?/, 'nothing held to send');
  assert.equal(await say('task: add a trailing stop'), "Here's your message to Claude for Roundtable Trading, add a trailing stop. Ready to send it?");
  await say('send');
  assert.deepEqual(sent, [{ repo: '/p/Roundtable_Trading', task: 'add a trailing stop' }]);

  const plain = setup();
  await plain.say('The voice has not changed');
  assert.equal(await plain.say('no, change it'), 'OK. What do you want to send?');
  assert.equal(await plain.say('It changed now'), "Here's your message to Claude, It changed now. Ready to send it?");
  await plain.say('yes');
  assert.deepEqual(plain.sent, ['It changed now']);

  const idle = setup();
  assert.equal(await idle.say('change it'), "Here's your message to Claude, change it. Ready to send it?", 'with nothing held it is a message');
});

test('"no" to the read-back drops it, but with nothing held it is a message', async () => {
  const { say, sent } = setup();
  await say('task: in trading bot, add a stop loss');
  assert.equal(await say('task: No.'), "OK, I won't send it.");
  assert.match(await say('send it'), /nothing to send/);
  assert.equal(await say('no'), "Here's your message to Claude, no. Ready to send it?");
  await say('yes');
  assert.deepEqual(sent, ['no']);
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
  assert.equal(utterance('text=send+it', 'application/x-www-form-urlencoded; charset=utf-8'), 'send it');
  assert.equal(utterance('task: in relay, set timeout=30', 'application/x-www-form-urlencoded'), 'task: in relay, set timeout=30');
  assert.equal(utterance('', 'application/x-www-form-urlencoded'), '');
  assert.equal(utterance('task: send it', 'application/x-www-form-urlencoded'), 'task: send it');
  assert.equal(utterance('send it\n', 'text/plain'), 'send it');
  assert.equal(utterance('{"other":1}'), '{"other":1}');
});

test('dictation variants of cancel, no and change it', async () => {
  for (const said of ['Cancel it.', 'never mind', 'forget it', 'nope', "Don't send it", 'no.']) {
    const { say, sent } = setup();
    await say('task: in trading bot, add a stop loss');
    assert.equal(await say(`task: ${said}`), "OK, I won't send it.", said);
    assert.deepEqual(sent, [], said);
  }
  for (const said of ['change', 'Change that.', 'no, change it', 'change the message', 'edit it']) {
    const { say } = setup();
    await say('task: in trading bot, add a stop loss');
    assert.equal(await say(`task: ${said}`), 'OK. What do you want to tell Roundtable Trading?', said);
  }
  const held = setup();
  await held.say('task: in voice relay');
  assert.equal(await held.say('no'), "OK, I won't send it.", 'no also drops a held project');
  assert.match(await held.say('fix it'), /^Here's your message to Claude, fix it\./, 'the project is gone');
});

test('a bare "go" never sends: it is easily misheard from "no"', async () => {
  const { say, sent } = setup();
  await say('task: in trading bot, fix typos');
  assert.match(await say('task: go'), /\?$/);
  assert.match(await say('send it'), /nothing to send/, 'the misheard reply was not taken as a yes');
  await say('Here is a note');
  assert.match(await say('go'), /^Here's your message to Claude, go\./);
  assert.deepEqual(sent, []);
});
