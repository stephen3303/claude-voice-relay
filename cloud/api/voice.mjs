// Bridge Cloud voice API: the relay's protocol (/voice/confirm, /voice/inbox, /voice/photo)
// for signed-in Pro users, plus /voice/send (no read-back). One Lambda behind API Gateway, whose
// Lambda authorizer checks the Bridge session (auth.mjs).
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

export const LOOK_PROMPT = [
  'The user is wearing smart glasses, may be driving, and just took this photo.',
  'Answer what they said. Your answer is read aloud: at most three short sentences, plain words,',
  'no markdown, lists or symbols. If text in the photo matters (an error message, a sign, a label), say the key part.',
].join(' ');

/**
 * deps.store: { getHeld(user), setHeld(user, held|null), addMessage(user, text), messagesAfter(user, id) }
 * deps.look(jpegBytes, said) -> spoken answer (Claude on Bedrock)
 * deps.startTask(user, { project, task, photo? }) -> spoken line ("Sent." or why not)
 * deps.now() -> ms, deps.sleep(ms)
 */
export function makeHandler(deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function confirm(user, raw) {
    let held = await deps.store.getHeld(user);
    const expired = held && now() - held.at > HOLD_MS;
    if (expired) held = null;
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
      if (route === 'POST /voice/confirm') {
        let said = raw.toString('utf8');
        try { const j = JSON.parse(said); if (typeof j?.text === 'string') said = j.text; } catch { /* plain text */ }
        return text(200, await confirm(user, said.trim()));
      }
      if (route === 'POST /voice/send') {
        let said = raw.toString('utf8');
        try { const j = JSON.parse(said); if (typeof j?.text === 'string') said = j.text; } catch { /* plain text */ }
        return text(200, await send(user, said.trim()));
      }
      if (route === 'GET /voice/inbox') return json(200, await inbox(user, event.queryStringParameters));
      if (route === 'POST /voice/photo') {
        let said = '';
        try { said = decodeURIComponent(event.headers?.['x-question'] || '').trim(); } catch { /* keep empty */ }
        return text(200, await photo(user, raw, said));
      }
      return text(404, 'Not found.');
    } catch (e) {
      console.error(route, e);
      return text(200, "Sorry, Bridge Cloud hit an error. Try again in a moment.");
    }
  };
}

const text = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'text/plain' }, body });
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export { INBOX_KEEP_S };
