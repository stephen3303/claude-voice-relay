// Each project's status file (the orchestrator's standard format): a STATUS#<project key> item under the owner,
// next to the project's PROJECT# and AGENT# items. Workers write it with each spoken answer (agents.mjs, answer),
// any Claude session can write it through the connector (update_status), and Bridge Cloud writes "needs attention"
// itself when a run fails (cloud/runner), so a report never goes stale silently. orchestrator.mjs reads them.
// Shared by the Voice Lambda (index.mjs) and the agent runner. No AWS SDK import, so tests run without it: callers
// send statusUpdate's input as an UpdateCommand.

export const HEALTH = ['blocked', 'needs attention', 'on track'];
// The fields a worker reports. Each is a short line, read aloud, so they're capped.
export const FIELDS = {
  health: 'On track, needs attention, or blocked',
  done: 'Done since the last report, one to three short lines',
  inProgress: 'The current task',
  id: 'The problem identifier, such as PR-45',
  next: 'What the worker will do next',
  needs: 'Decisions or input needed from the owner; empty when none',
  owner: 'Who must act next: worker, orchestrator, or the owner',
  where: 'Link to the branch, pull request, issue or file',
  overnight: 'What the worker needs to keep working overnight; empty when nothing',
};
const MAX = { id: 40, owner: 40, where: 300 };
const LINE = 300;

// "On Track", "needs-attention", "BLOCKED." -> one of HEALTH, or null.
export function healthOf(said) {
  const n = String(said ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/^(blocked|stuck)$/.test(n)) return 'blocked';
  if (/^(needs attention|attention|at risk|warning)$/.test(n)) return 'needs attention';
  if (/^(on track|ok|okay|good|green|fine|done)$/.test(n)) return 'on track';
  return null;
}

/** The known fields of a report, trimmed and capped; unknown or empty-health input is dropped, never refused. */
export function cleanStatus(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const f of Object.keys(FIELDS)) {
    if (!(f in input) || input[f] == null) continue;
    if (f === 'health') { const h = healthOf(input.health); if (h) out.health = h; continue; }
    const v = Array.isArray(input[f]) ? input[f].map(String).join('. ') : String(input[f]);
    const s = v.replace(/\s+/g, ' ').trim();
    const max = MAX[f] ?? LINE;
    out[f] = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }
  return out;
}

/**
 * The UpdateCommand input that merges fields into the project's status file and stamps it. `note` is Bridge Cloud's
 * own remark (a failed run); a worker's report clears it, since the worker has spoken since.
 */
export function statusUpdate(table, user, key, fields, { by = 'worker', now = Date.now() } = {}) {
  const set = { ...fields, updated: now, by };
  if (by === 'worker' && !('note' in set)) set.note = '';
  const names = {}, values = {};
  const parts = Object.entries(set).map(([f, v], i) => { names[`#f${i}`] = f; values[`:v${i}`] = v; return `#f${i} = :v${i}`; });
  return { TableName: table, Key: { pk: `USER#${user}`, sk: `STATUS#${key}` },
    UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}

/** Bridge Cloud's own "needs attention", when a run fails before the worker could report. */
export const failedStatus = (why) => ({ health: 'needs attention', note: `Its last run failed: ${String(why).slice(0, 250)}` });
