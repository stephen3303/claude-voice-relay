// Bridge Cloud voice API: the relay's protocol (/voice/confirm, /voice/inbox, /voice/photo, /voice/tts)
// for signed-in Pro users, plus /voice/send (no read-back) and the phone's push registration
// (push.mjs). One Lambda behind API Gateway, whose Lambda authorizer checks the Bridge session (auth.mjs).
// Dependencies are passed in, so tests run it with fakes and no AWS.

import { userOf } from './auth.mjs';

// "send it" and what dictation tends to make of it ("sent it", "send it please"), as in confirm.mjs.
const SEND = /^(?:(?:yes|yeah|ok(?:ay)?|please)[\s,]+)?(?:sen[dt](?: (?:it|that|this))?(?: (?:now|off|please))?|go ahead|do it|yes|yep|yeah)[\s.!]*$/i;
const CANCEL = /^(?:cancel(?: it)?|never ?mind|forget it|stop)[\s.!]*$/i;
const CHANGE = /^(?:(?:no|nope)[\s,]+)?(?:change(?: it| that| the message| the task)?|edit(?: it)?)[\s.!]*$/i;
const NO = /^(?:no|nope|nah|don'?t(?: send(?: it)?)?)[\s.!]*$/i;
const ASK = 'What do you want to send?';
const TASK_PREFIX = /^(new\s+)?task\b\s*[:,.]?\s*/i;
const PROJECT = /^(?:in|on|for)\s+(.+?)\s*[,:;]\s*([\s\S]+)$/i;
// "in trading bot add tests" said without "task": dictation drops the comma, so a known project name after
// in, on or for still makes it a task. A reply can't start that way by mistake: it starts with the agent's name.
const IN_PROJECT = /^(?:in|on|for)\s/i;
const SEND_TO = /^(?:send|give|show)\s+(?:this|it|that)(?:\s+(?:photo|picture))?\s+to\s+(.+?)(?:\s*[,:;.]\s*([\s\S]*))?$/i;
const HOLD_MS = 10 * 60_000;          // an unconfirmed task expires, as on the relay
const INBOX_KEEP_S = 7 * 24 * 3600;   // inbox messages are kept a week (DynamoDB TTL)
const PHOTO_MAX = 10 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{32,200}$/i;   // APNs device tokens are hex
const SPEAK_MAX = 3000;               // Polly's SynthesizeSpeech limit, in characters
const SPEECH_USER_DAY = 60_000;       // characters of natural voice per account per day (about $1.80 of Polly)
const SPEECH_ALL_DAY = 1_000_000;     // and across every account (about $30): a hard ceiling on the bill
// Sandbox Pro is free (App Review and TestFlight buy in the sandbox), so it gets much less: enough to try it.
const SPEECH_SANDBOX_USER_DAY = 5_000;     // about 15 cents of Polly per account per day
const SPEECH_SANDBOX_ALL_DAY = 100_000;    // about $3 across every sandbox account
const PHOTOS_SANDBOX_USER_DAY = 5;         // Bedrock photo answers per sandbox account per day
const PHOTOS_SANDBOX_ALL_DAY = 50;
const TEST_CALL = 'This is Bridge, checking that I can reach you. Say goodbye to hang up.';

export const LOOK_PROMPT = [
  'The user is wearing smart glasses, may be driving, and just took this photo.',
  'Answer what they said. Your answer is read aloud: at most three short sentences, plain words,',
  'no markdown, lists or symbols. If text in the photo matters (an error message, a sign, a label), say the key part.',
].join(' ');

/**
 * deps.store: { getHeld(user), setHeld(user, held|null), addMessage(user, text), messagesAfter(user, id) }
 * deps.look(jpegBytes, said) -> spoken answer (Claude on Bedrock)
 * deps.startTask(user, { project, task, photo? }) -> spoken line ("Sent." or why not); with no project, the
 *   words are for the user's agents (agents.mjs: a reply, status or stop)
 * deps.agentAwaiting(user) -> true when an agent asked a question (optional)
 * deps.splitTask(user, body) -> { project, task } for a task said without a comma after the project, or null (optional)
 * deps.orchestrate(user, said) -> { say } (a status report or briefing), { task: { project, task } } ("tell X to ..."),
 *   or null when it isn't one (orchestrator.mjs; optional)
 * deps.agentAnswer(bearer, body) -> { status, text }: POST /api/agent/reply, a cloud session's spoken answer. It has
 *   no API Gateway authorizer (the session holds a reply token, not a Bridge session) and checks its own (optional)
 * deps.devices: { save(user, device), remove(user, deviceId), markListening(user), stopListening(user) }
 * deps.deliver(user, text, from) -> posts to the inbox and pushes it to the user's phones
 * deps.speak(text) -> MP3 bytes of `text` in a natural voice (Amazon Polly)
 * deps.store.spendSpeech(key, day, n, max) -> false when that would take key's total for day past max
 *   (a daily counter: characters of speech, or photos under PHOTO# keys)
 * deps.pro: { claim(user, jws) -> { status, body }, plan(user) -> 'Production' | 'Sandbox' | null } (storekit.mjs)
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

  // Worded like Siri reading back a text, as in confirm.mjs: "Here's your message to Claude for <project>, <task>.
  // Ready to send it?" "Send" or "yes" sends, "change it" asks for new words, "cancel" or "no" drops it.
  async function confirm(user, raw) {
    let held = await deps.store.getHeld(user);
    const expired = held && now() - held.at > HOLD_MS;
    if (expired) { held = null; await deps.store.setHeld(user, null); }
    const isTask = TASK_PREFIX.test(raw);
    const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
    if (!body) return `I didn't catch that. ${ASK}`;
    if (SEND.test(body)) {
      if (held?.project) return `What do you want to tell ${held.project}?`;
      if (expired) return `That message waited over ten minutes, so I didn't send it. ${ASK}`;
      // With nothing held, "yes" or "go ahead" (not "send it") answers an agent's yes-or-no question, as in confirm.mjs.
      if (!held && !/^(?:\S+\s+)?sen[dt]\b/i.test(body) && await deps.agentAwaiting?.(user)) return deps.startTask(user, { project: null, task: 'yes' });
      if (!held) return `There's nothing to send yet. ${ASK}`;
      await deps.store.setHeld(user, null);
      return deps.startTask(user, held.parsed ?? { project: null, task: held.text });
    }
    if (CANCEL.test(body) || (held && NO.test(body))) { await deps.store.setHeld(user, null); return "OK, I won't send it."; }
    // Reports are answered at once and leave a held task as it was; "tell X to ..." is read back like a task.
    // Not after "change it", where the next words are the held project's new task whatever they say.
    const o = held?.project ? null : await deps.orchestrate?.(user, body);
    if (o?.say) return o.say;
    if (o?.task) {
      await deps.store.setHeld(user, { text: body, parsed: o.task, at: now() });
      return `Here's your message to Claude for ${o.task.project}, ${o.task.task}. Ready to send it?`;
    }
    if (held && CHANGE.test(body)) {
      // Keep the project, so the new words go where the old ones were going.
      const project = held.project ?? held.parsed?.project;
      await deps.store.setHeld(user, project ? { project, at: now() } : null);
      return project ? `OK. What do you want to tell ${project}?` : `OK. ${ASK}`;
    }
    const m = body.match(PROJECT);
    const said = !isTask && !held?.project && !m && IN_PROJECT.test(body) ? (await deps.splitTask?.(user, body)) ?? null : null;
    if (said) {
      await deps.store.setHeld(user, { text: body, parsed: said, at: now() });
      return `Here's your message to Claude for ${said.project}, ${said.task}. Ready to send it?`;
    }
    if (isTask || held?.project) {
      // After "change it", the next words are the task for the project that was held, whatever they
      // start with: "for the README, fix typos" must not re-target it. "Cancel" lets you pick another.
      const parsed = held?.project ? { project: held.project, task: body } : m ? { project: m[1].trim(), task: m[2].trim() }
        : (await deps.splitTask?.(user, body)) ?? null;
      if (!parsed) {
        await deps.store.setHeld(user, null);
        return `I can't tell which project "${body}" is for. Start with in and the project name. ${ASK}`;
      }
      await deps.store.setHeld(user, { text: body, parsed, at: now() });
      return `Here's your message to Claude for ${parsed.project}, ${parsed.task}. Ready to send it?`;
    }
    await deps.store.setHeld(user, { text: body, at: now() });
    return `Here's your message to Claude, ${body}. Ready to send it?`;
  }

  // Read-back off in the app: start the task as said.
  async function send(user, raw) {
    const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
    if (!body) return "I didn't catch that. Say it again.";
    const o = await deps.orchestrate?.(user, body);
    if (o?.say) return o.say;
    if (o?.task) return deps.startTask(user, o.task);
    const m = body.match(PROJECT);
    if (m) return deps.startTask(user, { project: m[1].trim(), task: m[2].trim() });
    const split = TASK_PREFIX.test(raw) || IN_PROJECT.test(body) ? await deps.splitTask?.(user, body) : null;
    return deps.startTask(user, split ?? { project: null, task: body });
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

  // Spends n of each [key, max] in turn for today; if one is full, gives back what was spent and returns false.
  async function spend(limits, n) {
    const day = new Date(now()).toISOString().slice(0, 10);
    const done = [];
    // A negative spend with a huge max always passes (MAX_SAFE_INTEGER would overflow the marshaller).
    const refund = () => Promise.all(done.map((key) => deps.store.spendSpeech(key, day, -n, 1e15).catch((e) => console.error('refund', e))));
    for (const [key, max] of limits) {
      if (!await deps.store.spendSpeech(key, day, n, max)) { await refund(); return null; }
      done.push(key);
    }
    return refund;
  }

  async function photo(user, jpeg, said) {
    const plan = await deps.pro.plan(user);
    if (!plan) return 'Photos need Bridge Pro. Open Bridge to start a free trial.';
    if (!jpeg?.length) return 'The photo was empty. Try again.';
    if (jpeg.length > PHOTO_MAX) return 'That photo is too large.';
    const m = said.match(SEND_TO);
    if (m) return deps.startTask(user, { project: m[1].trim(), task: (m[2] || '').trim(), photo: jpeg });
    if (plan === 'Production') return deps.look(jpeg, said || 'What am I looking at?');
    const refund = await spend([[`PHOTO#${user}`, PHOTOS_SANDBOX_USER_DAY], ['PHOTO#SANDBOX', PHOTOS_SANDBOX_ALL_DAY]], 1);
    if (!refund) return "That's all the photo answers for test accounts today. Try again tomorrow.";
    try { return await deps.look(jpeg, said || 'What am I looking at?'); }
    catch (e) { await refund(); throw e; }   // nothing was answered
  }

  return async function handler(event) {
    if (deps.agentAnswer && event.requestContext?.http?.method === 'POST' && event.rawPath === '/api/agent/reply') {
      let body = null;
      try { body = JSON.parse(event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8').toString('utf8') : ''); } catch {}
      try {
        const r = await deps.agentAnswer(event.headers?.authorization ?? '', body);
        return text(r.status, r.text);
      } catch (e) { console.error('agent reply', e); return text(500, 'Bridge Cloud hit an error.'); }
    }
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
        // The natural voice is part of Bridge Pro, as Apple's signed transaction says, not as the app says.
        const plan = await deps.pro.plan(user);
        if (!plan) return text(402, 'The natural voice needs Bridge Pro.');
        const chars = [...said].length;
        if (chars > SPEAK_MAX) return text(413, 'Too long for the cloud voice.');
        const limits = plan === 'Production'
          ? [[`SPEECH#${user}`, SPEECH_USER_DAY]]
          : [[`SPEECH#${user}`, SPEECH_SANDBOX_USER_DAY], ['SANDBOX', SPEECH_SANDBOX_ALL_DAY]];
        const refund = await spend([...limits, ['ALL', SPEECH_ALL_DAY]], chars);
        if (!refund) return text(429, 'Cloud voice budget used up today.');
        let mp3;
        try { mp3 = await deps.speak(said); }
        catch (e) { await refund(); throw e; }   // nothing was spoken
        return { statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from(mp3).toString('base64'), isBase64Encoded: true };
      }
      if (route === 'POST /pro') {
        // The app's StoreKit 2 transaction (JWS), whenever its entitlements change and after signing in.
        let b = null;
        try { b = JSON.parse(raw.toString('utf8')); } catch { /* bad JSON */ }
        const r = await deps.pro.claim(user, b?.transaction);
        return json(r.status, r.body);
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
      if (/^\S+ \/(push\/|voice\/listening|voice\/tts|pro$)/.test(route)) return json(500, { error: 'Bridge Cloud hit an error.' });
      return text(200, "Sorry, Bridge Cloud hit an error. Try again in a moment.");
    }
  };
}

const text = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'text/plain' }, body });
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export { INBOX_KEEP_S };
