// Read-back loop for the iPhone Shortcut and the glasses app (/voice/confirm).
// Worded like Siri reading back a text: "Here's your message to Claude for <project>, <task>. Ready to send it?"
// Naming the project catches a misheard one before anything starts.
// Each utterance is held until the user says "send" or "yes"; "change it" asks for new words, and
// "cancel" or "no" drops it. Nothing is sent on silence. Every reply that expects another utterance
// is a question (contains "?"); the Shortcut's loop stops listening otherwise.
// Dependencies are passed in, so tests run it without Docker or the projects folder.

// "send it" and what dictation tends to make of it ("sent it", "send it please"). Not a bare "go":
// it is easily misheard from "no", the other natural answer to "Ready to send it?".
export const SEND = /^(?:(?:yes|yeah|ok(?:ay)?|please)[\s,]+)?(?:sen[dt](?: (?:it|that|this))?(?: (?:now|off|please))?|go ahead|do it|yes|yep|yeah)[\s.!]*$/i;
export const CANCEL = /^(?:cancel(?: it)?|never ?mind|forget it|stop)[\s.!]*$/i;
// Siri's "Change it": the next utterance replaces the held words. With nothing held it is a message.
export const CHANGE = /^(?:(?:no|nope)[\s,]+)?(?:change(?: it| that| the message| the task)?|edit(?: it)?)[\s.!]*$/i;
// A plain "no" to "Ready to send it?" drops the message. With nothing held it is an answer to an agent.
const NO = /^(?:no|nope|nah|don'?t(?: send(?: it)?)?)[\s.!]*$/i;
const ASK = 'What do you want to send?';
export const TASK_PREFIX = /^(new\s+)?task\b\s*[:,.]?\s*/i;
const PROJECT_ONLY = /^(?:in|on|for)\s+(.+)$/i;
const PROJECT_SAID = /^(?:in|on|for)\s+(.+?)\s*[,:;]\s*([\s\S]+)$/i;
export const CONFIRM_TTL = 10 * 60_000;

/**
 * deps.parseTask(body) -> { repo, task } | null
 * deps.resolveProject(spoken) -> repo | null   (a project named on its own, "in trading bot"; alias or exact name)
 * deps.spokenName(repo) -> name read aloud
 * deps.agentAwaiting() -> true when an agent asked a yes-or-no question
 * deps.dispatch(text | { repo, task }) -> starts the task or answers the agent (fire and forget);
 *   an object is a task whose project is already resolved
 * deps.now() -> ms, deps.log(...)
 */
export function makeConfirm(deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let pending = null; // { text, at } waiting for "send it", or { repo, at } waiting for the task

  function send(text) {
    log('voice confirmed:', typeof text === 'string' ? text : `${text.task} (${text.repo})`);
    Promise.resolve().then(() => deps.dispatch(text)).catch((e) => log('handler error:', e.message));
    return 'Sent.';
  }
  const readBack = (task, repo) => repo
    ? `Here's your message to Claude for ${deps.spokenName(repo)}, ${task}. Ready to send it?`
    : `Here's your message to Claude, ${task}. Ready to send it?`;

  return function confirmStep(raw) {
    raw = String(raw ?? '').trim();
    const expired = pending && now() - pending.at > CONFIRM_TTL;
    if (expired) pending = null;
    const isTask = TASK_PREFIX.test(raw);
    const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
    if (!body) return `I didn't catch that. ${ASK}`;

    if (SEND.test(body)) {
      if (pending?.text) { const { text } = pending; pending = null; return send(text); }
      if (pending?.repo) return `What do you want to tell ${deps.spokenName(pending.repo)}?`;
      // Meant for the task that just expired, so it must not approve an agent's question instead.
      if (expired) return `That message waited over ten minutes, so I didn't send it. ${ASK}`;
      // With nothing held, "yes" or "go ahead" (not "send it") answers an agent's yes-or-no question.
      if (!/^(?:\S+\s+)?sen[dt]\b/i.test(body) && deps.agentAwaiting()) { log('voice answer: yes'); return send('yes'); }
      return `There's nothing to send yet. ${ASK}`;
    }
    if (CANCEL.test(body) || (pending && NO.test(body))) { pending = null; return "OK, I won't send it."; }
    if (pending && CHANGE.test(body)) {
      // Keep the project, so the new words go where the old ones were going.
      const repo = pending?.repo ?? pending?.text?.repo;
      if (repo) { pending = { repo, at: now() }; return `OK. What do you want to tell ${deps.spokenName(repo)}?`; }
      pending = null;
      return `OK. ${ASK}`;
    }

    // Once a project is held, the next utterance is its task, prefixed or not: the glasses app
    // only adds "task:" to what starts with "in" or "on".
    if (isTask || pending?.repo) {
      // With a project held, only an exact project name ("in trading bot, ...") replaces it:
      // parseTask's loose match could route "for the README, ..." to any folder containing "the".
      const named = body.match(PROJECT_SAID);
      const parsed = !pending?.repo ? deps.parseTask(body)
        : named && deps.resolveProject(named[1]) ? { repo: deps.resolveProject(named[1]), task: named[2].trim() } : null;
      if (parsed?.task) {
        // Hold the resolved repo, so "send it" starts exactly what was read back.
        pending = { text: { repo: parsed.repo, task: parsed.task }, at: now() };
        return readBack(parsed.task, parsed.repo);
      }
      // Dictation stopped after the project name: keep the project and ask for the task.
      const alone = body.match(PROJECT_ONLY);
      const repo = alone && deps.resolveProject(alone[1]);
      if (repo) {
        pending = { repo, at: now() };
        return `What do you want to tell ${deps.spokenName(repo)}?`;
      }
      // The task that follows a project named on its own.
      if (pending?.repo) {
        const { repo: held } = pending;
        pending = { text: { repo: held, task: body }, at: now() };
        return readBack(body, held);
      }
      pending = null;
      return `I can't tell which project "${body}" is for. Start with in and the project name. ${ASK}`;
    }
    pending = { text: raw, at: now() };
    return readBack(body);
  };
}

// What was said, from a Shortcut or app request body: {"text": ...} JSON, a form with a text
// field (the Shortcut's "Form" request body), or plain text.
export function utterance(body, contentType = '') {
  const s = String(body ?? '');
  // Only a form with a text field is a form: curl -d sends plain text with the form type too,
  // and "set timeout=30" must not be split at the "=".
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const p = new URLSearchParams(s);
    if (p.has('text')) return p.get('text').trim();
  }
  try { const j = JSON.parse(s); if (j && typeof j.text === 'string') return j.text.trim(); } catch { /* plain text */ }
  return s.trim();
}
