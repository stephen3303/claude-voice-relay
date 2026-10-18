import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpeak } from './speech.mjs';

const fail = (name) => Object.assign(new Error(name), { name });

function setup(behave) {
  const calls = [];
  const speak = makeSpeak({
    voice: 'Ruth', log: () => {},
    synth: async (params, { abortSignal }) => {
      calls.push({ engine: params.Engine, text: params.Text, voice: params.VoiceId, signal: abortSignal instanceof AbortSignal });
      return behave(params.Engine, calls.length);
    },
  });
  return { speak, calls };
}

test('speaks with the generative engine, with a time limit', async () => {
  const { speak, calls } = setup(() => new Uint8Array([1]));
  assert.deepEqual([...await speak('Hello.')], [1]);
  assert.deepEqual(calls, [{ engine: 'generative', text: 'Hello.', voice: 'Ruth', signal: true }]);
});

test('falls back to neural only on throttling, a stall or an unavailable engine', async () => {
  for (const name of ['ThrottlingException', 'TimeoutError', 'EngineNotSupportedException']) {
    const { speak, calls } = setup((engine) => { if (engine === 'generative') throw fail(name); return new Uint8Array([2]); });
    assert.deepEqual([...await speak(`line ${name}`)], [2]);
    assert.deepEqual(calls.map((c) => c.engine), ['generative', 'neural']);
  }
  const { speak, calls } = setup(() => { throw fail('TextLengthExceededException'); });
  await assert.rejects(speak('too long'), /TextLengthExceeded/);
  assert.equal(calls.length, 1, 'no retry for an error a retry cannot fix');
});

test('caches short lines only, and only successful ones', async () => {
  let n = 0;
  const { speak, calls } = setup(() => { if (++n === 1) throw fail('ValidationException'); return new Uint8Array([n]); });
  await assert.rejects(speak('Sent.'));
  await speak('Sent.'); await speak('Sent.');
  assert.equal(calls.length, 2, 'the failure was not cached; the success was');
  const long = 'x'.repeat(121);
  await speak(long); await speak(long);
  assert.equal(calls.length, 4, 'long lines are not cached');
});

test('the cache keeps at most 200 lines, dropping the oldest', async () => {
  const { speak, calls } = setup(() => new Uint8Array([0]));
  for (let i = 0; i <= 200; i++) await speak(`line ${i}`);
  await speak('line 200');
  assert.equal(calls.length, 201, 'the newest is still cached');
  await speak('line 0');
  assert.equal(calls.length, 202, 'the oldest was dropped');
});
