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
// A CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) can only make model requests, so it's kept out
// of the CLI's environment (cloudEnv) or it would take precedence over that sign-in.

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

// The CLI runs on the host with the repo as its folder, so it gets only what it needs to run and sign in,
// never the relay's .env (VOICE_TOKEN, GitHub App key, the setup token). Windows names are case-insensitive.
const ENV_ALLOW = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'WINDIR', 'COMSPEC', 'OS', 'COMPUTERNAME', 'ALLUSERSPROFILE', 'PUBLIC', 'COMMONPROGRAMFILES', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);
export function cloudEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => ENV_ALLOW.has(k.toUpperCase())));
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
// The CLI waits on a remote session, so a hung sign-in, network or session would keep the agent busy for
// good: after timeoutMs it's killed. The cloud session itself carries on and stays in the Claude app.
export const CLOUD_TIMEOUT_MS = 60 * 60_000;
export function runCloud({ spawn, claudeBin = 'claude', env, cwd, sessionId, prompt, timeoutMs = CLOUD_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const p = spawn(claudeBin, cloudArgs(sessionId), { cwd, windowsHide: true, env: cloudEnv(env) });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`no answer after ${Math.round(timeoutMs / 60_000)} minutes. It may still be working; check the Claude app.`));
      try { resolve(parseCloud(out, err, code)); } catch (e) { reject(e); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}

// One agent turn in cloud mode. `a` is the relay's agent record: a.cloudNew is set by a new task, and only
// a new task starts a cloud session; a reply goes to a.cloudId. checkRepo(a) resolves to why the repo
// can't have a cloud agent, or '' when it can.
export function makeCloudTurn({ run = runCloud, checkRepo, exists, say, speakResult, log = () => {} }) {
  return async function cloudTurn(a, prompt) {
    if (!exists(a.repoPath)) throw new Error(`${a.name}'s folder doesn't exist yet. Clone the repo there first.`);
    // A reply with no session to go to (its conversation ran on the PC before cloud mode, or the first turn
    // failed after the session may have started) would start one with only that one line, next to an orphan
    // that can still push.
    if (!a.cloudId && !a.cloudNew) throw new Error(`I lost track of its cloud session; it may be in the Claude app. Start a new task for ${a.name}.`);
    // Checked once per task, before the session exists: what it pushes later is held by the repo's rules.
    if (a.cloudNew) {
      const why = await checkRepo(a);
      if (why) throw new Error(why);
    }
    a.cloudNew = false; // from here the session may exist, so a failure means start over
    const r = await run({ cwd: a.repoPath, sessionId: a.cloudId, prompt });
    if (a.stopped) return;
    if (r.session_id && r.session_id !== a.cloudId) log(a.name, 'cloud session', r.session_id, r.url || '');
    a.cloudId = r.session_id || a.cloudId;
    a.cloudUrl = r.url || a.cloudUrl;
    if (r.queued) {
      a.awaiting = false; a.question = '';
      return say(`${a.name}: sent. Its answer will be in the Claude app.`, { spoken: `Sent to ${a.name}. Its answer will be in the Claude app.` });
    }
    speakResult(a, r);
  };
}
