// The app's spoken replies (POST /api/voice/tts). The generative engine is Polly's most natural. The voice also
// has a neural engine, tried only when the generative one is throttled, stalled or unavailable (not on errors a
// retry can't fix). Each call has a time limit: 8 s + 6 s leaves room for the budget writes and a cold start
// inside the app's 20 s wait, instead of producing audio nobody hears.
// synth({ Engine, ...params }, { abortSignal }) -> MP3 bytes is passed in, so tests run it with fakes and no AWS.

const RETRY_NEURAL = new Set(['ThrottlingException', 'ServiceFailureException', 'EngineNotSupportedException', 'TimeoutError', 'AbortError']);
const CACHE_LINE = 120, CACHE_SIZE = 200;   // short fixed lines ("Sent.") are spoken again and again

export function makeSpeak({ synth, voice, timeouts = { generative: 8000, neural: 6000 }, log = console.warn }) {
  const cache = new Map();
  return async function speak(text) {
    const cached = cache.get(text);
    if (cached) return cached;
    const params = { Text: text, VoiceId: voice, OutputFormat: 'mp3', SampleRate: '24000' };
    const run = (Engine) => synth({ ...params, Engine }, { abortSignal: AbortSignal.timeout(timeouts[Engine]) });
    let mp3;
    try { mp3 = await run('generative'); }
    catch (e) {
      if (!RETRY_NEURAL.has(e.name)) throw e;
      log('generative speech failed, using neural:', e.name, e.message);
      mp3 = await run('neural');
    }
    if (text.length <= CACHE_LINE) {
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
      cache.set(text, mp3);
    }
    return mp3;
  };
}
