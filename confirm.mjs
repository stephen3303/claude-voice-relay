// Read-back loop for the iPhone Shortcut and the glasses app (/voice/confirm).
// Each utterance is held and read back until the user says "send it". Every reply that expects
// another utterance contains the word "again"; the Shortcut's loop stops listening otherwise.
// Dependencies are passed in, so tests run it without Telegram, Docker or the projects folder.

// "send it" and what dictation tends to make of it ("sent it", "send it please").
export const SEND = /^(?:(?:yes|yeah|ok(?:ay)?|please)[\s,]+)?(?:sen[dt](?: (?:it|that|this))?(?: (?:now|off|please))?|go(?: ahead)?|do it|yes|yep|yeah)[\s.!]*$/i;
export const CANCEL = /^(?:cancel|never ?mind|forget it|stop)[\s.!]*$/i;
export const TASK_PREFIX = /^(new\s+)?task\b\s*[:,.]?\s*/i;
const PROJECT_ONLY = /^(?:in|on|for)\s+(.+)$/i;
export const CONFIRM_TTL = 10 * 60_000;

/**
 * deps.parseTask(body) -> { repo, task } | null
 * deps.resolveProject(spoken) -> repo | null   (a project named on its own, "in trading bot"; alias or exact name)
 * deps.spokenName(repo) -> name read aloud
 * deps.agentAwaiting() -> true when an agent asked a yes-or-no question
 * deps.dispatch(text) -> starts the task or answers the agent (fire and forget)
 * deps.now() -> ms, deps.log(...)
 */
export function makeConfirm(deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let pending = null; // { text, at } waiting for "send it", or { repo, at } waiting for the task

  function send(text) {
    log('voice confirmed:', text);
    Promise.resolve().then(() => deps.dispatch(text)).catch((e) => log('handler error:', e.message));
    return 'Sent.';
  }

  return function confirmStep(raw) {
    raw = String(raw ?? '').trim();
    const expired = pending && now() - pending.at > CONFIRM_TTL;
    if (expired) pending = null;
    const isTask = TASK_PREFIX.test(raw);
    const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
    if (!body) return "I didn't catch that. Say the task again.";

    if (SEND.test(body)) {
      if (pending?.text) { const { text } = pending; pending = null; return send(text); }
      if (pending?.repo) return `I still need the task for ${deps.spokenName(pending.repo)}. Say it again.`;
      // With nothing held, "yes" or "go ahead" (not "send it") answers an agent's yes-or-no question.
      if (!/^(?:\S+\s+)?sen[dt]\b/i.test(body) && deps.agentAwaiting()) { log('voice answer: yes'); return send('yes'); }
      if (expired) return 'That task waited over ten minutes, so I dropped it. Say the task again.';
      return 'Nothing is waiting to send. Say the task again.';
    }
    if (CANCEL.test(body)) { pending = null; return 'Cancelled. Nothing sent.'; }

    if (isTask) {
      const parsed = deps.parseTask(body);
      if (parsed?.task) {
        pending = { text: `task: ${body}`, at: now() };
        return `I heard: ${parsed.task}. That goes to ${deps.spokenName(parsed.repo)}. Say send it, or say the task again.`;
      }
      // Dictation stopped after the project name: keep the project and ask for the task.
      const named = body.match(PROJECT_ONLY);
      const repo = named && deps.resolveProject(named[1]);
      if (repo) {
        pending = { repo, at: now() };
        return `That goes to ${deps.spokenName(repo)}. What should it do? Say the task again.`;
      }
      // The task that follows a project named on its own.
      if (pending?.repo) {
        const { repo: held } = pending;
        pending = { text: `task: in ${deps.spokenName(held)}, ${body}`, at: now() };
        return `I heard: ${body}. That goes to ${deps.spokenName(held)}. Say send it, or say the task again.`;
      }
      pending = null;
      return `I heard: ${body}. I can't tell which project that's for. Say the task again, starting with in and the project name.`;
    }
    pending = { text: raw, at: now() };
    return `I heard: ${body}. Say send it, or say it again.`;
  };
}

// What was said, from a Shortcut or app request body: {"text": ...} JSON, a form with a text
// field (the Shortcut's "Form" request body), or plain text.
export function utterance(body, contentType = '') {
  const s = String(body ?? '');
  // A form body with no "=" is plain text sent with the form type (curl -d does this).
  if (/application\/x-www-form-urlencoded/i.test(contentType) && s.includes('=')) {
    const p = new URLSearchParams(s);
    return (p.get('text') ?? [...p.values()].find(Boolean) ?? '').trim();
  }
  try { const j = JSON.parse(s); if (j && typeof j.text === 'string') return j.text.trim(); } catch { /* plain text */ }
  return s.trim();
}
