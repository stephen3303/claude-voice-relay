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

import path from 'node:path';
import fs from 'node:fs';

// The CLI starts in the project folder, and on Windows a bare command name is looked up in the current
// folder before PATH: a claude.exe left in the repo would run on the host. So it's started by full path,
// found on PATH only (or CLAUDE_BIN, which must be absolute), and never from inside the project folder.
export function resolveClaude({ bin = 'claude', env = process.env, platform = process.platform, isFile = defaultIsFile } = {}) {
  if (path.isAbsolute(bin)) return isFile(bin) ? bin : null;
  if (bin.includes('/') || bin.includes('\\')) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] || '';
  const exts = platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (!dir || !p.isAbsolute(dir)) continue; // a relative PATH entry would be the project folder again
    for (const ext of exts) {
      const f = p.join(dir, bin + ext);
      if (isFile(f)) return f;
    }
  }
  return null;
}
function defaultIsFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }
export const insideFolder = (file, folder) => {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// argv only ever holds fixed flags and a session id from Claude's own output: what was said goes over stdin.
// The CLI runs on the host in the project folder, so it loads user settings only: a .claude/settings.json in
// the folder (hooks, apiKeyHelper, env) would otherwise run on the PC, outside any container.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export function cloudArgs(sessionId) {
  if (sessionId != null && !SESSION_ID.test(sessionId)) throw new Error('Bad cloud session id.');
  return ['-p', '--output-format', 'json', '--setting-sources', 'user', '--append-system-prompt', CLOUD_PROMPT,
    ...(sessionId ? ['--cloud', sessionId] : ['--cloud'])];
}

// The CLI runs on the host with the repo as its folder, so it gets only what it needs to run and sign in,
// never the relay's .env (VOICE_TOKEN, GitHub App key, the setup token). Windows names are case-insensitive.
const ENV_ALLOW = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'WINDIR', 'COMSPEC', 'OS', 'COMPUTERNAME', 'ALLUSERSPROFILE', 'PUBLIC', 'COMMONPROGRAMFILES', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CLAUDE_CODE_GIT_BASH_PATH',
  'PROGRAMW6432', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432']);
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
// The CLI notes "Cloud session: <id> (<url>)" on stderr as soon as the session exists: onSession gets it
// then (so it can be saved before the turn ends), and a later failure carries it (e.sessionId, e.url).
// onSpawn gets the child, so "stop" or the relay exiting can kill it.
// In print mode a prompt starting with "/" would run as a slash command on this PC, not reach the session.
export const asTask = (prompt) => (/^\s*\//.test(prompt) ? `The user said: ${prompt.trim()}` : prompt);
export function runCloud({ spawn, claudeBin, env, cwd, sessionId, prompt, timeoutMs = CLOUD_TIMEOUT_MS,
  onSpawn = () => {}, onSession = () => {} }) {
  return new Promise((resolve, reject) => {
    if (!claudeBin || !path.isAbsolute(claudeBin) || insideFolder(claudeBin, cwd)) {
      return reject(new Error("Claude Code wasn't found on this PC's PATH, outside the project folder. Install it, or set CLAUDE_BIN to claude.exe's full path."));
    }
    const p = spawn(claudeBin, cloudArgs(sessionId), { cwd, windowsHide: true, env: cloudEnv(env) });
    onSpawn(p);
    let out = '', err = '', timedOut = false, created = null;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
    const fail = (e) => reject(created ? Object.assign(e, created) : e);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
      const m = !created && /Cloud session: (\S+) \((https:\/\/\S+)\)/.exec(err);
      if (m && SESSION_ID.test(m[1])) { created = { sessionId: m[1], url: m[2] }; onSession(m[1], m[2]); }
    });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return fail(new Error(`no answer after ${Math.round(timeoutMs / 60_000)} minutes. It may still be working; check the Claude app.`));
      try { resolve(parseCloud(out, err, code)); } catch (e) { fail(e); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(asTask(prompt));
  });
}

// One agent turn in cloud mode. `a` is the relay's agent record: a.cloudNew is set by a new task, and only
// a new task starts a cloud session; a reply goes to a.cloudId. checkRepo(a) resolves to why the repo
// can't have a cloud agent, or '' when it can. unsafe(folder) is true for the relay's own folder, the
// folder holding its keys, or one above them: the CLI runs there on the host and may bundle it.
export function makeCloudTurn({ run = runCloud, checkRepo, unsafe, exists, say, speakResult, save = () => {}, log = () => {} }) {
  return async function cloudTurn(a, prompt) {
    // A reply with no session to go to (its conversation ran on the PC before cloud mode, or the first turn
    // failed after the session may have started) would start one with only that one line, next to an orphan
    // that can still push.
    if (!a.cloudId && !a.cloudNew) throw new Error(`I lost track of its cloud session; it may be in the Claude app. Start a new task for ${a.name}.`);
    // Only the task's own first turn may start a session, so it's used up here whatever happens next:
    // after a failed check, a later "yes" must not become a session's whole task.
    const fresh = a.cloudNew;
    a.cloudNew = false;
    if (!exists(a.repoPath)) throw new Error(`${a.name}'s folder doesn't exist yet. Clone the repo there first.`);
    if (unsafe(a.repoPath)) throw new Error(`${a.name}'s folder holds the relay or its keys, so no agent can work there. Clone the repo into another folder and point aliases.json at it.`);
    // Checked once per task, before the session exists: what it pushes later is held by the repo's rules.
    if (fresh) {
      const why = await checkRepo(a);
      if (why) throw new Error(why);
    }
    let r;
    // A new session's id is saved the moment it exists, so a relay restart mid-turn can still reach it.
    const onSession = (id, url) => {
      if (a.cloudId || a.stopped) return;
      a.cloudId = id; a.cloudUrl = url; save();
      log(a.name, 'cloud session', id, url);
    };
    try { r = await run({ cwd: a.repoPath, sessionId: a.cloudId, prompt, onSession, onSpawn: (p) => { a.proc = p; } }); }
    catch (e) {
      // The session was created before the failure: a reply can still go to it.
      if (e.sessionId) onSession(e.sessionId, e.url);
      throw e;
    } finally { a.proc = null; }
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
