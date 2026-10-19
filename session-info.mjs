// "usage" and "context" by voice: the agent's own Claude Code session answers /usage and /context, and
// these turn what it prints into one spoken sentence. The relay runs the command with --resume, a forked
// session and no persistence, so the agent's conversation is only read, never added to, even mid-turn.

// "usage", "cost", "context", optionally followed by an agent name ("usage for trading bot").
// Anything longer stays a message to the agent, so "context is in the README" isn't taken as a command.
export const INFO = /^\/?(usage|cost|context)\b(?:\s+(?:for|of|on)\b)?\s*([\s\S]*?)[\s.!?]*$/i;

export function infoCommand(text, findAgent) {
  const m = INFO.exec(String(text).trim());
  if (!m) return null;
  const kind = /context/i.test(m[1]) ? 'context' : 'usage';
  if (!m[2]) return { kind, agent: null };
  const agent = findAgent(m[2]);
  return agent ? { kind, agent } : null;
}

export const infoArgs = (sessionId) =>
  ['-p', '--output-format', 'json', '--resume', sessionId, '--fork-session', '--no-session-persistence'];

// "2m 3s", "45s", "1h 2m 3s" -> whole minutes, or seconds under a minute.
function spokenDuration(s) {
  const n = (u) => Number((new RegExp(`(\\d+(?:\\.\\d+)?)${u}\\b`).exec(s) || [])[1] || 0);
  const secs = n('h') * 3600 + n('m') * 60 + n('s');
  if (secs < 60) { const r = Math.round(secs); return r === 1 ? '1 second' : `${r} seconds`; }
  const mins = Math.round(secs / 60);
  return mins === 1 ? '1 minute' : `${mins} minutes`;
}

function spokenDollars(x) {
  if (x < 0.01) return 'less than a cent';
  if (x < 1) { const c = Math.round(x * 100); return c === 1 ? '1 cent' : `${c} cents`; }
  return `${x.toFixed(2).replace(/\.00$/, '')} dollars`;
}

// /usage in print mode: "Total cost: $0.0041\nTotal duration (API): 2m 3s\n...". It's this session's cost
// at API prices; a subscription's plan limits aren't in it.
export function spokenUsage(name, out) {
  const cost = /Total cost:\s*\$([\d.]+)/i.exec(out || '');
  if (!cost) return `I couldn't read ${name}'s usage.`;
  const api = /Total duration \(API\):\s*([^\n]+)/i.exec(out);
  return `${name} has used ${spokenDollars(Number(cost[1]))} at API prices on this task` +
    (api ? `, with ${spokenDuration(api[1])} of model time.` : '.');
}

// /context: "**Tokens:** 50k / 500k (10%)".
export function spokenContext(name, out) {
  const m = /Tokens:\**\s*([\d.]+)k?\s*\/\s*([\d.]+)(k|m)?\s*\((\d+(?:\.\d+)?)%\)/i.exec(out || '');
  if (!m) return `I couldn't read ${name}'s context.`;
  const total = m[3]?.toLowerCase() === 'm' ? `${m[2]} million` : `${m[2]} thousand`;
  return `${name} is using ${Math.round(Number(m[4]))} percent of its context, out of ${total} tokens.`;
}
