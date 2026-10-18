// Agents as claude.ai cloud sessions (AGENT_MODE=cloud), so every Bridge conversation shows up in the
// Claude app's Code list with its full transcript, instead of only in Bridge.
//
// `claude -p --cloud --output-format json` with the task on stdin creates a cloud session for the
// folder's GitHub remote at its current branch, waits for the session's reply and prints it as JSON
// (result, is_error, session_id, session_url). `--cloud <session id>` sends a follow-up the same way.
// Older Claude Code versions only queue a follow-up and print {ok, session_id, url}; that still
// reaches the session, but the answer is then only in the app.
//
// Cloud sessions need the PC's Claude Code signed in with a claude.ai account (`claude auth login`).
// A CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) can only make model requests, so it's
// removed from the environment here or it would take precedence over that sign-in.

export const CLOUD_PROMPT = [
  'You are running in a claude.ai cloud session started by voice from the Bridge app.',
  'The user is away from the screen, often driving, and only hears a spoken summary through headphones; they can read this session later in the Claude app.',
  "End every final message with a line that starts exactly with 'SPOKEN:' followed by one or two plain sentences for text-to-speech:",
  'no code, file paths, markdown, or symbols that read badly aloud.',
  'If you need a decision, stop and make the SPOKEN line a single yes-or-no question, then continue after the user answers.',
  'When you finish a feature or bug fix, commit it on a new branch (never the default branch), push it and open a pull request.',
].join(' ');

// argv only ever holds fixed flags and a session id from Claude's own output: what was said goes over stdin.
export function cloudArgs(sessionId) {
  if (sessionId != null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(sessionId)) throw new Error('Bad cloud session id.');
  return ['-p', '--output-format', 'json', '--append-system-prompt', CLOUD_PROMPT,
    ...(sessionId ? ['--cloud', sessionId] : ['--cloud'])];
}

export function cloudEnv(env) {
  const e = { ...env };
  delete e.CLAUDE_CODE_OAUTH_TOKEN;
  delete e.ANTHROPIC_API_KEY;
  return e;
}

// What the CLI printed -> { result, is_error, session_id, url, queued }.
export function parseCloud(out, err, code) {
  let r;
  try { r = JSON.parse(String(out).trim().split('\n').pop()); } catch { r = null; }
  if (r && typeof r === 'object') {
    const url = r.session_url || r.url || '';
    if ('result' in r || 'is_error' in r) return { result: String(r.result ?? ''), is_error: !!r.is_error, session_id: r.session_id, url };
    if (r.ok === true) return { result: '', is_error: false, session_id: r.session_id, url, queued: true };
    if (r.ok === false) throw new Error(String(r.error || 'the cloud session refused the message'));
  }
  const why = String(err || out).trim().split('\n').filter(Boolean).pop() || `claude exited ${code}`;
  throw new Error(why.slice(-300));
}

// spawn is node's; the caller supplies the folder (cwd), the session to continue, and the prompt.
export function runCloud({ spawn, claudeBin = 'claude', env, cwd, sessionId, prompt }) {
  return new Promise((resolve, reject) => {
    const p = spawn(claudeBin, cloudArgs(sessionId), { cwd, windowsHide: true, env: cloudEnv(env) });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => { try { resolve(parseCloud(out, err, code)); } catch (e) { reject(e); } });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}
