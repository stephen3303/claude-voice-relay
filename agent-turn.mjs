// How the relay talks to Claude Code in a Docker agent's turn and in a quick photo look: the flags it
// passes, the live progress it reads while the turn runs, and the spoken line it takes from the result.
// Kept apart from relay.mjs so tests run without Docker.

// The reply Claude Code validates before the turn ends (`--json-schema`; it lands in `structured_output`).
// The agent's final message still ends with a SPOKEN: line, so an older CLI or a reply without the
// structured part still has something to read aloud.
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    spoken: { type: 'string', description: 'One or two plain sentences read aloud: no code, file paths, markdown or symbols.' },
    needs_answer: { type: 'boolean', description: 'True only when the spoken line is a yes-or-no question you need answered before you continue.' },
  },
  required: ['spoken', 'needs_answer'],
  additionalProperties: false,
};

// `AGENT_MAX_USD` caps a turn at that estimated cost; the turn then ends with error_max_budget_usd.
export function budgetArg(env) {
  const usd = Number(env.AGENT_MAX_USD);
  return Number.isFinite(usd) && usd > 0 ? ['--max-budget-usd', String(usd)] : [];
}

// The arguments after `claude` for one Docker agent turn. stream-json (which needs --verbose) prints each
// step as a line of JSON, so the relay can say what the agent is doing; the last line is the same result
// `--output-format json` prints.
export function agentArgs({ systemPrompt, sessionId, env = {} }) {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    '--json-schema', JSON.stringify(REPLY_SCHEMA), ...budgetArg(env), '--append-system-prompt', systemPrompt,
    ...(sessionId ? ['--resume', sessionId] : [])];
}

// The quick "what am I looking at" photo answer: Haiku at low effort, a few turns at most (read the photo,
// answer). QUICK_LOOK_MODEL changes the model. An older CLI that doesn't know these flags gets the plain ones.
export const QUICK_BASE = ['-p', '--output-format', 'json', '--allowedTools', 'Read'];
export function quickLookArgs(env = {}) {
  return [...QUICK_BASE, '--model', env.QUICK_LOOK_MODEL || 'claude-haiku-5-5', '--effort', 'low', '--max-turns', '3'];
}
export const unknownFlag = (text) => /unknown option|unknown argument|unrecognized option/i.test(String(text));

// What a tool call means, said aloud: "Trading bot is working, 6 minutes in, running the tests."
// Bash calls carry a short description the model writes in plain words; other tools get a fixed phrase.
const TOOL_WORDS = {
  Read: 'reading the code', Grep: 'searching the code', Glob: 'looking through the files', LS: 'looking through the files',
  Edit: 'editing files', MultiEdit: 'editing files', Write: 'writing files', NotebookEdit: 'editing a notebook',
  WebSearch: 'searching the web', WebFetch: 'reading a web page', Task: 'working with a helper agent', Agent: 'working with a helper agent',
};
const IGNORED = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'StructuredOutput']);
export function describeTool(name, input = {}) {
  if (IGNORED.has(name)) return '';
  if (name === 'Bash') {
    const d = String(input?.description || '').replace(/[`*_#<>|{}[\]\\$]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!d) return 'running a command';
    const words = d.length > 80 ? `${d.slice(0, 80).replace(/\s+\S*$/, '')}` : d;
    return words.charAt(0).toLowerCase() + words.slice(1);
  }
  return TOOL_WORDS[name] || (name.startsWith('mcp__') ? 'using a connected tool' : 'working');
}

// Reads stream-json from stdout chunk by chunk. onActivity(phrase) gets each tool call in words; the
// result event (or, for a CLI that printed plain json, the last JSON line) is returned by result().
export function makeStreamReader(onActivity = () => {}) {
  let buf = '', last = null, final = null;
  const line = (l) => {
    l = l.trim();
    if (!l) return;
    let ev;
    try { ev = JSON.parse(l); } catch { return; }
    last = ev;
    if (ev?.type === 'result') final = ev;
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type !== 'tool_use') continue;
        const phrase = describeTool(b.name, b.input);
        if (phrase) onActivity(phrase);
      }
    }
  };
  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(line);
    },
    result() { line(buf); buf = ''; return final || last; },
  };
}

// The agent's text with its SPOKEN: line, or a cleaned-up start of it when the line is missing.
export function spoken(result) {
  const text = String(result || '');
  const i = text.lastIndexOf('SPOKEN:');
  const s = i >= 0 ? text.slice(i + 7)
    : text.replace(/```[\s\S]*?```/g, '').replace(/[#*`_>|]/g, '').slice(0, 300);
  return s.replace(/\s+/g, ' ').trim() || 'Finished, with no summary.';
}

// What to say after a turn and whether it waits on the user. The structured reply wins when it's there;
// otherwise the SPOKEN: line, and a question mark at its end, as before.
const BUDGET_SAID = 'It stopped at the cost limit for one task before finishing. Say continue to let it carry on.';
export function spokenReply(r = {}) {
  if (r.subtype === 'error_max_budget_usd') return { line: BUDGET_SAID, awaiting: true, error: false };
  if (r.subtype === 'error_max_turns') return { line: 'It ran out of turns before finishing.', awaiting: false, error: true };
  const s = r.structured_output;
  if (s && typeof s === 'object' && typeof s.spoken === 'string' && s.spoken.trim()) {
    return { line: s.spoken.replace(/\s+/g, ' ').trim(), awaiting: s.needs_answer === true, error: !!r.is_error };
  }
  const line = spoken(r.result);
  return { line, awaiting: line.endsWith('?'), error: !!r.is_error };
}
