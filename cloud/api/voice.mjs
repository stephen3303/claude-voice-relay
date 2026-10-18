// Bridge Cloud voice API: the relay's protocol (/voice/confirm, /voice/inbox, /voice/photo, /voice/tts)
// for signed-in Pro users, plus /voice/send (no read-back) and the phone's push registration
// (push.mjs). One Lambda behind API Gateway, whose Lambda authorizer checks the Bridge session (auth.mjs).
// Dependencies are passed in, so tests run it with fakes and no AWS.

import { userOf } from './auth.mjs';

// "send it" and what dictation tends to make of it ("sent it", "send it please"), as in confirm.mjs.
const SEND = /^(?:(?:yes|yeah|ok(?:ay)?|please)[\s,]+)?(?:sen[dt](?: (?:it|that|this))?(?: (?:now|off|please))?|go(?: ahead)?|do it|yes|yep|yeah)[\s.!]*$/i;
const CANCEL = /^(?:cancel|never ?mind|forget it|stop)[\s.!]*$/i;
const TASK_PREFIX = /^(new\s+)?task\b\s*[:,.]?\s*/i;
const PROJECT = /^(?:in|on|for)\s+(.+?)\s*[,:;]\s*([\s\S]+)$/i;
const SEND_TO = /^(?:send|give|show)\s+(?:this|it|that)(?:\s+(?:photo|picture))?\s+to\s+(.+?)(?:\s*[,:;.]\s*([\s\S]*))?$/i;
const HOLD_MS = 10 * 60_000;          // an unconfirmed task expires, as on the relay
const INBOX_KEEP_S = 7 * 24 * 3600;   // inbox messages are kept a week (DynamoDB TTL)
const PHOTO_MAX = 10 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{32,200}$/i;   // APNs device tokens are hex
const SPEAK_MAX = 3000;               // Polly's SynthesizeSpeech limit, in characters
const SPEECH_USER_DAY = 60_000;       // characters of natural voice per account per day (about $1.80 of Polly)
const SPEECH_ALL_DAY = 1_000_000;     // and across every account (about $30): a hard ceiling on the bill
const TEST_CALL = 'This is Bridge, checking that I can reach you. Say goodbye to hang up.';

export const LOOK_PROMPT = [
  'The user is wearing smart glasses, may be driving, and just took this photo.',
  'Answer what they said. Your answer is read aloud: at most three short sentences, plain words,',
  'no markdown, lists or symbols. If text in the photo matters (an error message, a sign, a label), say the key part.',
].join(' ');

/**
 * deps.store: { getHeld(user), setHeld(user, held|null), addMessage(user, text), messagesAfter(user, id) }
 * deps.look(jpegBytes, said) -> spoken answer (Claude on Bedrock)
 * deps.startTask(user, { project, task, photo? }) -> spoken line ("Sent." or why not)
 * deps.devices: { save(user, device), remove(user, deviceId), markListening(user), stopListening(user) }
 * deps.deliver(user, text, from) -> posts to the inbox and pushes it to the user's phones
 * deps.speak(text) -> MP3 bytes of `text` in a natural voice (Amazon Polly)
 * deps.store.spendSpeech(key, day, chars, max) -> false when that would take key's total for day past max
 * deps.now() -> ms, deps.sleep(ms)
 */
// What was said: the body's JSON "text", or the plain-text body. null for JSON without a string "text".
function saidOf(raw) {
  const body = raw.toString('utf8');
  let j;
  try { j = JSON.parse(body); } catch { return body.trim(); }
  if (j === null || typeof j === 'object') return typeof j?.text === 'string' ? j.text.trim() : null;
  return body.trim();   // a bare number or string that happens to parse as JSON
}

export function makeHandler(deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function confirm(user, raw) {
    let held = await deps.store.getHeld(user);
    const expired = held && now() - held.at > HOLD_MS;
    if (expired) { held = null; await deps.store.setHeld(user, null); }
    const isTask = TASK_PREFIX.test(raw);
    const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
    if (!body) return "I didn't catch that. Say the task again.";
    if (SEND.test(body)) {
      if (!held) return expired ? 'That task waited over ten minutes, so I dropped it. Say the task again.' : 'Nothing is waiting to send. Say the task again.';
      await deps.store.setHeld(user, null);
      return deps.startTask(user, held.parsed ?? { project: null, task: held.text });
    }
    if (CANCEL.test(body)) { await deps.store.setHeld(user, null); return 'Cancelled. Nothing sent.'; }
    if (isTask) {
      const m = body.match(PROJECT);
      if (!m) {
        await deps.store.setHeld(user, null);
        return `I heard: ${body}. I can't tell which project that's for. Say the task again, starting with in and the project name.`;
      }
      await deps.store.setHeld(user, { text: body, parsed: { project: m[1].trim(), task: m[2].trim() }, at: now() });
      return `I heard: ${m[2].trim()}. That goes to ${m[1].trim()}. Say send it, or say the task again.`;
    }
    await deps.store.setHeld(user, { text: body, at: now() });
    return `I heard: ${body}. Say send it, or say it again.`;
  }

  // Read-back off in the app: start the task as said.
  async function send(user, raw) {
    const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
    if (!body) return "I didn't catch that. Say it again.";
    const m = body.match(PROJECT);
    return deps.startTask(user, m ? { project: m[1].trim(), task: m[2].trim() } : { project: null, task: body });
  }

  async function inbox(user, query) {
    const after = Number(query?.after) || 0;
    const wait = query?.wait !== '0';
    // Short polls inside one invocation (up to ~20s) instead of a held connection: Lambda can't be woken.
    for (let i = 0; ; i++) {
      const messages = await deps.store.messagesAfter(user, after);
      if (messages.length || !wait || i >= 10) {
        const last = messages.reduce((m, x) => Math.max(m, x.id), after);
        return { boot: 1, last, messages: messages.map(({ id, text, at }) => ({ id, text, age: Math.round((now() - at) / 1000) })) };
      }
      await sleep(2000);
    }
  }

  // The app reports its push tokens, and whether headphones or glasses are connected, whenever they change.
  async function register(user, b) {
    const device = typeof b?.device === 'string' && /^[\w-]{1,64}$/.test(b.device) ? b.device : null;
    const token = TOKEN.test(b?.token ?? '') ? b.token.toLowerCase() : undefined;
    const voipToken = TOKEN.test(b?.voipToken ?? '') ? b.voipToken.toLowerCase() : undefined;
    if (!device || (!token && !voipToken)) return json(400, { error: 'Need a device ID and a push token.' });
    await deps.devices.save(user, {
      device, token, voipToken, env: b.env === 'sandbox' ? 'sandbox' : 'production',
      headset: b.headset === true, calls: b.calls === true, at: now(),
    });
    return json(200, { ok: true });
  }

  async function photo(user, jpeg, said) {
    if (!jpeg?.length) return 'The photo was empty. Try again.';
    if (jpeg.length > PHOTO_MAX) return 'That photo is too large.';
    const m = said.match(SEND_TO);
    if (m) return deps.startTask(user, { project: m[1].trim(), task: (m[2] || '').trim(), photo: jpeg });
    return deps.look(jpeg, said || 'What am I looking at?');
  }

  return async function handler(event) {
    const user = userOf(event);
    if (!user) return text(401, 'Sign in to Bridge first.');
    const route = `${event.requestContext.http.method} ${event.rawPath.replace(/^\/api/, '')}`;
    const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);
    try {
      if (route === 'POST /voice/confirm') return text(200, await confirm(user, saidOf(raw) ?? ''));
      if (route === 'POST /voice/send') return text(200, await send(user, saidOf(raw) ?? ''));
      if (route === 'GET /voice/inbox') {
        // A conversation is open while the app long-polls, so agents' messages need no push.
        // A one-off check (wait=0, e.g. Settings > Test connection) isn't a conversation.
        if (event.queryStringParameters?.wait !== '0') await deps.devices.markListening(user);
        return json(200, await inbox(user, event.queryStringParameters));
      }
      if (route === 'DELETE /voice/listening') {
        // The conversation ended: push again right away instead of after the listening window.
        await deps.devices.stopListening(user);
        return json(200, { ok: true });
      }
      if (route === 'POST /push/register') {
        let b = null;
        try { b = JSON.parse(raw.toString('utf8')); } catch { /* bad JSON */ }
        return await register(user, b);
      }
      if (route === 'DELETE /push/register') {
        const device = event.queryStringParameters?.device;
        if (device) await deps.devices.remove(user, device);
        return json(200, { ok: true });
      }
      if (route === 'POST /push/test') {
        // "Test call" in the app: waits, so there's time to lock the phone, then rings like an agent would.
        let delay = 0;
        try { delay = Math.min(20, Math.max(0, Number(JSON.parse(raw.toString('utf8')).delay) || 0)); } catch { /* none */ }
        if (delay) await sleep(delay * 1000);
        await deps.deliver(user, TEST_CALL, 'Bridge');
        return json(200, { ok: true });
      }
      if (route === 'POST /voice/tts') {
        // The line the app is about to speak, as MP3. Anything but a 200 makes the app use the phone's voice,
        // so a line too long for one Polly call, or past the day's budget, is read whole by the phone instead.
        const said = saidOf(raw);
        if (!said) return text(400, 'Nothing to say.');
        const chars = [...said].length;
        if (chars > SPEAK_MAX) return text(413, 'Too long for the cloud voice.');
        const day = new Date(now()).toISOString().slice(0, 10);
        // A negative spend with a huge max always passes (MAX_SAFE_INTEGER would overflow the marshaller).
        const refund = (key) => deps.store.spendSpeech(key, day, -chars, 1e15).catch((e) => console.error('refund', e));
        if (!await deps.store.spendSpeech(`SPEECH#${user}`, day, chars, SPEECH_USER_DAY)) return text(429, 'Cloud voice budget used up today.');
        if (!await deps.store.spendSpeech('ALL', day, chars, SPEECH_ALL_DAY)) {
          await refund(`SPEECH#${user}`);
          return text(429, 'Cloud voice budget used up today.');
        }
        let mp3;
        try { mp3 = await deps.speak(said); }
        catch (e) { await Promise.all([refund(`SPEECH#${user}`), refund('ALL')]); throw e; }   // nothing was spoken
        return { statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from(mp3).toString('base64'), isBase64Encoded: true };
      }
      if (route === 'POST /voice/photo') {
        let said = '';
        try { said = decodeURIComponent(event.headers?.['x-question'] || '').trim(); } catch { /* keep empty */ }
        return text(200, await photo(user, raw, said));
      }
      return text(404, 'Not found.');
    } catch (e) {
      console.error(route, e);
      // The app retries push registration and falls back to the phone's voice on a failure, so those must see
      // one; the other voice routes speak the error instead.
      if (/^\S+ \/(push\/|voice\/listening|voice\/tts)/.test(route)) return json(500, { error: 'Bridge Cloud hit an error.' });
      return text(200, "Sorry, Bridge Cloud hit an error. Try again in a moment.");
    }
  };
}

const text = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'text/plain' }, body });
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export { INBOX_KEEP_S };
