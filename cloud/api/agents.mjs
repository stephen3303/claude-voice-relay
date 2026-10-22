// Agent tasks for the owner (owner.mjs): what the relay on the PC did with AGENT_MODE=cloud, in Bridge Cloud.
// A confirmed task starts a Fargate task (cloud/runner) that runs `claude -p --cloud` signed in with the owner's
// claude.ai account, so the work is a claude.ai cloud session that shows in the Claude app, as it did from the PC.
// This side keeps each agent's state in DynamoDB and answers at once; the runner speaks the agent's answers
// through the inbox. Other accounts still get the honest "not switched on" answer: their usage would need
// API billing (cloud/DESIGN.md, build step 4).
// Dependencies are passed in, so tests run with fakes and no AWS.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { OWNER, tokenHash } from './owner.mjs';

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|approved?|do it|go ahead|go for it)\b[\s.!]*$/i;
const NO = /^(no|nope|nah|don'?t|deny|denied|cancel)\b[\s.!]*$/i;
const STATUS = /^\/?status\b/i;
const STOP = /^\/?(?:stop|kill)\b\s*/i;
const INFO = /^\/?(?:usage|context)\b/i;
// A runner that died without saying so (the container was lost) mustn't keep its agent busy for good. The
// runner gives up on a turn after an hour (CLOUD_TIMEOUT_MS), so anything older than this is stale.
export const STALE_MS = 75 * 60_000;

// The token a task's cloud session sends its spoken answers with: cloud/runner/turns.mjs makes one per task and
// keeps only its SHA-256 on the agent (replyHash). It names its agent, so checking it is one read.
export const REPLY_TOKEN = /^brt\.([a-z0-9]{1,64})\.[A-Za-z0-9_-]{43}$/;
const MAX_SPOKEN = 600;

export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// A spoken project name -> one of the account's projects: a name or alias said exactly, else the unique best
// word overlap (as resolveRepo in relay.mjs). null when there's none or it's ambiguous.
export function resolveProject(spoken, projects) {
  const n = norm(spoken);
  if (!n) return null;
  const exact = projects.find((p) => norm(p.name) === n || (p.aliases ?? []).some((a) => norm(a) === n));
  if (exact) return exact;
  const words = String(spoken).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = projects.map((p) => ({ p, s: words.filter((w) => norm(p.name).includes(w)).length }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored[1] && scored[1].s === scored[0].s)) return null;
  return scored[0].p;
}

/**
 * deps.store: {
 *   projects(user) -> [{ name, repo: 'owner/name', branch, aliases? }]
 *   agents(user) -> [agent]   (agent: { key, name, repo, branch, busy, run, startedAt, lastAt, awaiting, question,
 *                                      cloudId, cloudNew, pending: [text], runArn })
 *   claim(user, agent, staleBefore) -> true when stored as a new task (no agent there, or it's idle or stale)
 *   wake(user, key, text, run, now, staleBefore) -> true when an idle (or stale) agent was made busy with text
 *     as its turn, under the new run id
 *   queue(user, key, text, staleBefore) -> true when text was added to a busy (not stale) agent's pending turns
 *   update(user, key, fields, run) (only while the agent is still on that run), remove(user, key)
 *   answered(user, key, fields, hash): sets fields only while the agent's replyHash is still hash
 * }
 * deps.deliver(user, text, from): posts to the inbox and pushes it (index.mjs)
 * deps.runTask(user, key, run) -> the runner's task ARN; deps.stopTask(arn)
 * `run` names one busy spell: the runner only writes to the agent while it's still its run, so a runner
 * that outlived "stop" (or a stale one) can't touch the next task under the same name.
 * deps.now() -> ms, deps.log(...)
 * Returns startTask(user, { project, task, photo }) -> the line spoken at once (voice.mjs), and
 * awaiting(user) -> true when an agent asked a question, so a bare "yes" answers it, and
 * answer(bearer, body) -> { status, text }: a cloud session sending its spoken answer (POST /api/agent/reply).
 */
export function makeAgents(deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const notOn = (project) => `Cloud agents aren't switched on yet, so ${project ?? 'your task'} didn't start. Use your PC relay for now.`;

  async function launch(user, a, run, verb) {
    try {
      const arn = await deps.runTask(user, a.key, run);
      await deps.store.update(user, a.key, { runArn: arn }, run);
      return `${verb} ${a.name}.`;
    } catch (e) {
      log('runTask failed', e);
      await deps.store.update(user, a.key, { busy: false }, run);
      return `I couldn't start ${a.name}'s runner. ${String(e.message || e).slice(0, 150)}`;
    }
  }

  async function newTask(user, { project, task, photo }) {
    const projects = await deps.store.projects(user);
    const p = resolveProject(project, projects);
    if (!p) {
      // Said aloud, so the names are what to say next time (and an empty list means the setup didn't save any).
      if (!projects.length) return "You don't have any projects yet. Run the owner setup script on your PC. Nothing was sent.";
      const names = projects.map((x) => x.name).sort();
      return `I don't know a project called ${project}. Your projects are ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', and more' : ''}. Nothing was sent.`;
    }
    // The photo would have to reach the cloud session as a file, which `claude --cloud` can't send.
    if (photo) return 'Photos only go to agents on your PC, and agents run in the cloud now. Nothing was sent.';
    if (!task) return `What do you want to tell ${p.name}?`;
    const t = now();
    // A new task gets a new cloud session (cloudNew), as on the relay.
    const run = randomUUID();
    const a = { key: norm(p.name), name: p.name, repo: p.repo, branch: p.branch || '', busy: true, run, startedAt: t, lastAt: t,
      awaiting: false, question: '', cloudId: null, cloudUrl: null, cloudNew: true, pending: [task] };
    if (!await deps.store.claim(user, a, t - STALE_MS)) return `${p.name} is still working. Say stop ${p.name} first, or wait for it.`;
    return launch(user, a, run, 'Starting');
  }

  function findPrefix(text, agents) {
    const t = norm(text);
    return [...agents].sort((x, y) => norm(y.name).length - norm(x.name).length).find((a) => t.startsWith(norm(a.name)));
  }

  async function status(user) {
    const agents = await deps.store.agents(user);
    if (!agents.length) return 'No agents.';
    return agents.map((a) => {
      const mins = Math.round((now() - (a.startedAt || now())) / 60_000);
      if (a.busy && now() - a.startedAt < STALE_MS) return `${a.name} is working, ${mins} minutes in.`;
      if (a.awaiting) return `${a.name} is waiting for your answer: ${a.question || 'a yes or no question'}`;
      return `${a.name} is idle.`;
    }).join(' ');
  }

  async function stop(user, text) {
    const a = findPrefix(text, await deps.store.agents(user));
    if (!a) return 'Say stop, then the agent name.';
    await deps.store.remove(user, a.key);
    if (a.runArn && a.busy) await deps.stopTask(a.runArn).catch((e) => log('stopTask failed', e));
    return `Stopped listening to ${a.name}. If it's still working, stop it in the Claude app.`;
  }

  async function reply(user, text) {
    const agents = await deps.store.agents(user);
    let a = findPrefix(text, agents);
    let msg = text;
    if (a) msg = text.split(/\s+/).slice(a.name.split(/\s+/).length).join(' ').replace(/^[,:;.\s]+/, '');
    else {
      a = agents.filter((x) => x.awaiting).sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0))[0] || (agents.length === 1 ? agents[0] : null);
      if (!a) return 'No agent is waiting on you. Start with task, or begin with the agent name.';
    }
    if (!msg) return `What do you want to tell ${a.name}?`;
    if (YES.test(msg)) msg = 'Yes, go ahead.';
    else if (NO.test(msg)) msg = "No, don't do that. Tell me what you would do instead.";
    // Busy: the runner takes it after the current turn. Idle: a runner starts for it. One of the two always
    // holds, since both are conditional writes on `busy`.
    for (let i = 0; i < 3; i++) {
      if (await deps.store.queue(user, a.key, msg, now() - STALE_MS)) return `${a.name} is busy. I'll pass that on when it finishes.`;
      const run = randomUUID();
      if (await deps.store.wake(user, a.key, msg, run, now(), now() - STALE_MS)) return launch(user, a, run, 'Sent to');
    }
    return `I couldn't reach ${a.name}. Try again.`;
  }

  async function startTask(user, { project, task, photo } = {}) {
    if (user !== OWNER) return notOn(project);
    const said = String(task ?? '').trim();
    if (project != null) return newTask(user, { project, task: said, photo });
    if (STATUS.test(said)) return status(user);
    if (INFO.test(said)) return 'Usage and context are only for agents on your PC. Check the Claude app for cloud sessions.';
    if (STOP.test(said)) return stop(user, said.replace(STOP, ''));
    return reply(user, said);
  }

  async function awaiting(user) {
    if (user !== OWNER) return false;
    return (await deps.store.agents(user)).some((a) => a.awaiting && !a.busy);
  }

  // "in trading bot add a stop-loss check": dictation often drops the comma after the project name, so the
  // first one to five words are tried as an exact project name or alias, longest first (as parseTask in relay.mjs).
  async function splitTask(user, body) {
    if (user !== OWNER) return null;
    const projects = await deps.store.projects(user);
    const words = String(body).replace(/^(?:in|on|for)\s+/i, '').split(/\s+/).filter(Boolean);
    for (let k = Math.min(5, words.length - 1); k >= 1; k--) {
      const n = norm(words.slice(0, k).join(' '));
      const p = projects.find((x) => norm(x.name) === n || (x.aliases ?? []).some((a) => norm(a) === n));
      if (p) return { project: p.name, task: words.slice(k).join(' ').replace(/^[,:;.\s]+/, '') };
    }
    return null;
  }

  // The session says its SPOKEN line here, and whether it's a yes-or-no question waiting on the owner. The token
  // is the session's own; a new task under the same name gets a new one, so an old session can't speak for it.
  async function answer(bearer, body) {
    const token = String(bearer || '').replace(/^Bearer\s+/i, '');
    const m = REPLY_TOKEN.exec(token);
    if (!m) return { status: 401, text: 'Not a reply token.' };
    const a = (await deps.store.agents(OWNER)).find((x) => x.key === m[1]);
    const hash = tokenHash(token);
    if (!a?.replyHash || !/^[0-9a-f]{64}$/.test(a.replyHash)
      || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.replyHash, 'hex'))) return { status: 401, text: 'Not a reply token.' };
    let said = String(body?.spoken ?? '').replace(/^\s*SPOKEN:\s*/i, '').replace(/\s+/g, ' ').trim();
    if (!said) return { status: 400, text: 'Send {"spoken": "...", "question": false}.' };
    if (said.length > MAX_SPOKEN) said = `${said.slice(0, MAX_SPOKEN - 1)}…`;
    const question = body?.question === true;
    await deps.store.answered(OWNER, a.key, { awaiting: question, question: question ? said : '', lastAt: now() }, a.replyHash);
    await deps.deliver(OWNER, said, a.name);
    return { status: 200, text: 'Said.' };
  }

  return { startTask, awaiting, splitTask, notOn, answer };
}
