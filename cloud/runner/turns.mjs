// The agent runner's loop (cloud/runner/main.mjs wires it to AWS): one Fargate task per busy spell of one agent.
// It takes the agent's pending turns from DynamoDB one at a time and runs each with makeCloudTurn from
// cloud-agents.mjs, the same code the relay on the PC runs in AGENT_MODE=cloud: `claude -p --cloud` starts or
// continues a claude.ai cloud session on the project's GitHub repo and waits for its answer, which is spoken
// through the owner's inbox. When nothing is pending it marks the agent idle and exits, so nothing runs (or
// costs) between turns. A reply that arrives mid-turn is queued by the API (cloud/api/agents.mjs) and taken here.
// Dependencies are passed in, so tests run with fakes and no AWS, git or Claude Code.
import path from 'node:path';
import { makeCloudTurn } from '../../cloud-agents.mjs';
import { spokenReply } from '../../agent-turn.mjs';

export const NO_ROUTINE = "New tasks need the Bridge task routine, and it isn't set up yet. Run the owner setup script on your PC.";

// What the task routine's session gets: the repo to work in, then the task (the routine's prompt says so).
export const routineText = (a, task) => `Repository: ${a.repo}\nBranch: ${a.branch || 'the default branch'}\n\n${task}`;

export const NO_LOGIN = "The claude.ai login for cloud agents was signed out. Run the deploy script on your PC once without SkipLogin to sign in again. The task may still have started; check the Claude app.";

// An error said aloud and shown in the history: whole sentences, so it isn't cut off mid-word.
export function spokenError(message, max = 400) {
  const m = String(message ?? '').replace(/\s+/g, ' ').trim();
  // Claude Code's own wording points at a terminal the owner doesn't have here.
  if (/claude\.ai sign-in|claude auth login/i.test(m)) return NO_LOGIN;
  if (m.length <= max) return m;
  const cut = m.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/**
 * deps.store: {
 *   take(user, key, run) -> { agent, text } for the next pending turn, or null (none, or no longer this run)
 *   finish(user, key, run) -> true when the agent was marked idle (nothing pending, still this run)
 *   isRun(user, key, run) -> true while the agent is still on this run (not stopped or restarted)
 *   update(user, key, fields, run)
 * }
 * deps.prepare(agent, dir) -> makes dir a git folder whose current branch tracks the agent's GitHub repo
 * deps.run(opts) -> runCloud's result (cloud-agents.mjs), with spawn and the CLI already bound
 * deps.startSession(text) -> { sessionId, url }: fires the owner's task routine with text (optional; without it a new
 *   task can't start, since Claude Code's print mode can only message an existing cloud session)
 * deps.deliver(user, spoken, from), deps.notify(text) (ntfy, optional), deps.fireRoutine() (optional)
 * deps.workRoot: where repo folders go; deps.exists(dir); deps.log(...)
 */
export function makeRunner(deps) {
  const log = deps.log ?? (() => {});

  return async function runAgent(user, key, run) {
    let a = null;
    let writes = Promise.resolve();
    // makeCloudTurn saves synchronously (the relay writes state.json); here each save is a conditional
    // DynamoDB write, chained so they land in order, and awaited after the turn.
    const save = () => {
      if (!a) return;
      const fields = { cloudId: a.cloudId ?? null, cloudUrl: a.cloudUrl ?? null, cloudNew: !!a.cloudNew,
        awaiting: !!a.awaiting, question: a.question || '', toRecord: !!a.cloudToRecord, lastAt: Date.now() };
      writes = writes.then(() => deps.store.update(user, key, fields, run)).catch((e) => log('save failed', e.message));
    };
    // Spoken only while this is still the agent's run: after "stop", its answer isn't wanted.
    let spoken = Promise.resolve();
    const say = (text, { spoken: line } = {}) => {
      log('say:', text);
      spoken = spoken.then(async () => {
        if (!await deps.store.isRun(user, key, run)) return;
        await deps.deliver(user, String(line ?? text), a?.name ?? 'Bridge');
        await deps.notify?.(text);
      }).catch((e) => log('deliver failed', e.message));
    };
    const speakResult = (agent, r) => {
      const { line, awaiting, error } = spokenReply(r);
      agent.awaiting = awaiting;
      agent.question = awaiting ? line : '';
      say(`${agent.name}: ${error ? 'hit an error. ' : ''}${line}`, { spoken: error ? `${agent.name} hit an error. ${line}` : line });
    };
    const cloudTurn = makeCloudTurn({
      run: deps.run,
      // The relay checks the repo's branch rules before a session that will push; that check needs the relay's
      // GitHub App key, which Bridge Cloud doesn't hold. The session pushes through the Claude GitHub app.
      checkRepo: async () => '',
      unsafe: () => false,   // a fresh folder in the container, never the relay's own
      exists: deps.exists,
      say, speakResult, save, log,
      mark: !!deps.fireRoutine,
      onDone: () => deps.fireRoutine?.().then((id) => log('project routine started', id)).catch((e) => log('project routine failed:', e.message)),
      startSession: async (agent, task) => {
        if (!deps.startSession) throw new Error(NO_ROUTINE);
        return deps.startSession(routineText(agent, task));
      },
    });

    let prepared = false;
    for (;;) {
      const next = await deps.store.take(user, key, run);
      if (!next) {
        await writes;
        if (await deps.store.finish(user, key, run)) break;
        if (!await deps.store.isRun(user, key, run)) break;   // stopped, or a new task took the name
        continue;   // a reply was queued just now
      }
      const dir = path.join(deps.workRoot, key);
      // The record is re-read each turn (a reply may come after the session started), but `a` keeps its object
      // identity within a turn, as makeCloudTurn expects.
      a = { ...next.agent, repoPath: dir, cloudToRecord: !!next.agent.toRecord, stopped: false };
      try {
        if (!prepared) { await deps.prepare(a, dir); prepared = true; }
        await cloudTurn(a, next.text);
      } catch (e) {
        log(a.name, 'turn failed:', e.message);
        say(`${a.name} failed. ${spokenError(e.message)}`);
      }
      save();
      await writes;
      await spoken;
    }
    await spoken;
  };
}
