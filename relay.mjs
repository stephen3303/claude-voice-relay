// claude-voice-relay
// Voice (Bridge app, iPhone Shortcut) <-> containerized Claude Code agents, plus a localhost
// endpoint that host-side Claude Code hooks post "needs you" notifications to.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeConfirm, utterance, TASK_PREFIX } from './confirm.mjs';
import { makeGitHubApp, makeAgentGitHub, unsafeMount } from './github-app.mjs';
import { makePublisher, REQUEST_FILE, MAX_REQUEST, FETCH_SCRIPT, PUSH_SCRIPT } from './publish.mjs';
import { runCloud, makeCloudTurn, resolveClaude } from './cloud-agents.mjs';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, 'state.json');
const OUTBOX_FILE = path.join(ROOT, 'outbox.json');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const cfg = {
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  voicePort: Number(process.env.VOICE_PORT || 47879),
  voiceToken: process.env.VOICE_TOKEN || '',
  // Read every Shortcut task back ("Ready to send it?") and wait for a yes; VOICE_CONFIRM=0 sends immediately.
  voiceConfirm: process.env.VOICE_CONFIRM !== '0',
  projectsRoot: process.env.PROJECTS_ROOT || path.resolve(ROOT, '..'),
  // Natural-sounding speech for the glasses app: set OPENAI_API_KEY to enable POST /voice/tts.
  openaiKey: process.env.OPENAI_API_KEY || '',
  ttsModel: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
  ttsVoice: process.env.TTS_VOICE || 'coral',
  hookPort: Number(process.env.HOOK_PORT || 47878),
  image: process.env.AGENT_IMAGE || 'claude-voice-agent:latest',
  githubAppId: process.env.GITHUB_APP_ID || '',
  githubAppKeyFile: process.env.GITHUB_APP_KEY_FILE || '',
  agentGhToken: process.env.AGENT_GH_TOKEN || '',
  // AGENT_MODE=cloud runs tasks as claude.ai cloud sessions (cloud-agents.mjs) instead of Docker on this PC.
  cloud: process.env.AGENT_MODE === 'cloud',
};

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'relay.log'), line + '\n');
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// The voice endpoint is the only way in and can start agents that push to GitHub, so it needs a
// strong token. Without one the relay stays up with the voice endpoint off (exiting would only
// make start.ps1 restart it every 10 seconds).
const voiceOff = !cfg.voiceToken ? 'VOICE_TOKEN is missing from .env'
  : cfg.voiceToken.length < 24 ? 'VOICE_TOKEN is shorter than 24 characters' : '';
if (cfg.cloud) log('Agents run as claude.ai cloud sessions (AGENT_MODE=cloud).');
else if (!cfg.oauth) log('WARNING: CLAUDE_CODE_OAUTH_TOKEN missing; agents cannot run until it is set.');

// The agent's final message is read aloud, so it must end with a short, speakable line.
const VOICE_PROMPT = [
  'You are running unattended in a Docker container with full permissions; the repository is mounted at /work.',
  'The user is away from the screen, often driving, and only hears a spoken summary through headphones.',
  "End every final message with a line that starts exactly with 'SPOKEN:' followed by one or two plain sentences for text-to-speech:",
  'no code, file paths, markdown, or symbols that read badly aloud.',
  'If you need a decision, stop and make the SPOKEN line a single yes-or-no question, then continue after the user answers.',
  'Everything above the SPOKEN line may be as detailed as you like; the user reads it later.',
].join(' ');
// Agents hold no GitHub credentials: the relay pushes for them after the turn (publish.mjs).
const PUBLISH = [
  'You have no GitHub credentials, so never push or use gh. When you finish a feature or bug fix, commit it on a new branch',
  '(never the default branch), then ask for it to be pushed by writing',
  `${REQUEST_FILE} as JSON: {"branch": "<your branch>", "title": "<pull request title>", "body": "<pull request description>"}.`,
  'After your turn the relay pushes that branch, opens its pull request (or updates the open one) and tells the user,',
  'so your SPOKEN line should not say it was pushed.',
].join(' ');
// Used instead when the relay has no GitHub access at all, so the user hears that work wasn't pushed.
const NO_GITHUB = 'There is no GitHub access: commit locally, do not push or open a pull request, and say in the SPOKEN line that the work is committed but not pushed.';

// ---------- what the relay says ----------
// Everything said is held for the glasses app, which long-polls /voice/inbox and reads new
// messages aloud. It's kept in outbox.json so a restart doesn't lose what the app hasn't heard;
// replies carry BOOT, so the app starts over if that file is lost and the ids restart.
let BOOT = Date.now();
let outbox = []; // { id, at, text }
let outboxId = 0;
try {
  const o = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
  if (Number.isFinite(o.boot) && Number.isInteger(o.last) && Array.isArray(o.messages)) {
    ({ boot: BOOT, last: outboxId, messages: outbox } = o);
  }
} catch { /* first run */ }
const inboxWaiters = new Set();
// `text` goes to the log; `spoken` replaces what the glasses read aloud (e.g. the reply without the agent's name in front).
function say(text, { spoken } = {}) {
  log('say:', text);
  outbox.push({ id: ++outboxId, at: Date.now(), text: String(spoken ?? text) });
  if (outbox.length > 50) outbox.shift();
  // Write then rename, so stopping the relay mid-write can't leave a truncated file.
  try {
    fs.writeFileSync(OUTBOX_FILE + '.tmp', JSON.stringify({ boot: BOOT, last: outboxId, messages: outbox }));
    fs.renameSync(OUTBOX_FILE + '.tmp', OUTBOX_FILE);
  }
  catch (e) { log('outbox save failed:', e.message); }
  for (const wake of [...inboxWaiters]) wake();
}

// ---------- GitHub access for agents ----------
// Agents never get a GitHub token, the owner's or any other: they commit, and the relay pushes for them.
// Either a GitHub App (preferred: github-app.mjs, set up with setup-github-app.mjs) gives each push a
// token for that agent's repo only, or AGENT_GH_TOKEN holds a fine-grained token. Without either, agents
// can commit but not push.
async function hostValue(cmd, args) { try { return (await run(cmd, args)).stdout.trim(); } catch { return ''; } }
const hostGit = {
  name: await hostValue('git', ['config', '--global', 'user.name']),
  email: await hostValue('git', ['config', '--global', 'user.email']),
};
let ghApp = null;
if (cfg.githubAppId && cfg.githubAppKeyFile) {
  try { ghApp = makeGitHubApp({ appId: cfg.githubAppId, privateKey: fs.readFileSync(cfg.githubAppKeyFile), log }); }
  catch (e) { log('GitHub App key unreadable:', e.message); }
}
if (!ghApp && !cfg.agentGhToken) log('WARNING: no GitHub access for agents (GITHUB_APP_ID or AGENT_GH_TOKEN); they can commit but not push.');

const agentGitHub = makeAgentGitHub({
  // Outside the repo: the agent working on this repo mounts it and could otherwise rewrite its own pin.
  ghApp, fallbackToken: cfg.agentGhToken, hostGit, log, pinsFile: path.join(os.homedir(), '.bridge', 'github-pins.json'),
  getRemote: (repoPath) => hostValue('git', ['-C', repoPath, 'remote', 'get-url', 'origin']),
});

// The git identity each turn commits as, passed with "docker exec -e".
const GIT_ENV = ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'];

const publisher = makePublisher({
  agentGitHub, log,
  // Read inside the agent's own container, so a symlink there can only reach what the agent already sees.
  readRequest: async (a) => {
    const { stdout } = await run('docker', ['exec', a.container, 'sh', '-c',
      `[ -f "$1" ] || { echo none; exit 0; }; echo found; head -c ${MAX_REQUEST + 1} "$1"; rm -f "$1"`, 'sh', REQUEST_FILE],
    { maxBuffer: 2 * MAX_REQUEST });
    return stdout.startsWith('found\n') ? stdout.slice(6) : null;
  },
  // FETCH_SCRIPT reads the agent's repo with no token and no network; its bundle is piped straight into
  // PUSH_SCRIPT's container, the only one that gets the token. Both are named so a failure or timeout
  // (which only stops the docker clients) removes them.
  push: ({ a, branch, repo, token }) => new Promise((resolve, reject) => {
    const names = ['fetch', 'push'].map((n) => `${a.container}-${n}-${Date.now()}`);
    const fetcher = spawn('docker', ['run', '--rm', '--name', names[0], '--network', 'none', '-v', `${a.repoPath}:/src:ro`,
      '-e', 'BRANCH', cfg.image, 'sh', '-c', FETCH_SCRIPT],
    { windowsHide: true, env: { ...process.env, BRANCH: branch }, stdio: ['ignore', 'pipe', 'pipe'] });
    const pusher = spawn('docker', ['run', '--rm', '-i', '--name', names[1],
      '-e', 'GH_TOKEN', '-e', 'BRANCH', '-e', 'REPO', cfg.image, 'sh', '-c', PUSH_SCRIPT],
    { windowsHide: true, env: { ...process.env, GH_TOKEN: token, BRANCH: branch, REPO: repo }, stdio: ['pipe', 'ignore', 'pipe'] });
    pusher.stdin.on('error', () => {}); // the pusher failing first closes the pipe
    pusher.on('close', (code) => { if (code !== 0) fetcher.kill(); }); // which would leave the fetcher stalled
    fetcher.stdout.pipe(pusher.stdin);
    let err = '';
    for (const p of [fetcher, pusher]) p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const timer = setTimeout(() => { fetcher.kill(); pusher.kill(); }, 5 * 60_000);
    Promise.all([fetcher, pusher].map((p) => new Promise((done) => { p.on('error', () => done(-1)); p.on('close', done); })))
      .then(async (codes) => {
        clearTimeout(timer);
        if (codes.every((c) => c === 0)) return resolve();
        for (const n of names) await run('docker', ['rm', '-f', n]).catch(() => {});
        reject(new Error(`exit ${codes.join('/')}: ${err.trim()}`));
      });
  }),
});

// ---------- agent state ----------
const agents = new Map(); // spoken name -> agent
function save() {
  const data = [...agents.values()].map(({ name, repoPath, container, sessionId, cloudId, cloudUrl, awaiting, question, lastAt }) =>
    ({ name, repoPath, container, sessionId, cloudId, cloudUrl, awaiting, question, lastAt }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}
function load() {
  try {
    for (const a of JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) agents.set(a.name, { ...a, busy: false, queue: [] });
  } catch { /* first run */ }
}

// ---------- spoken project name -> repo folder ----------
function projectDirs() {
  return fs.readdirSync(cfg.projectsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
    // The relay's own folder is never a project, so its name falls through to its alias (the agents' clone).
    .filter((d) => !unsafeMount(path.join(cfg.projectsRoot, d), PROTECTED));
}
function aliases() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'aliases.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { log('aliases.json unreadable:', e.message); return {}; }
}
// strict = alias or exact folder name only; loose also allows a unique best word-overlap match
function resolveRepo(spoken, loose) {
  const n = norm(spoken);
  if (!n) return null;
  for (const [k, v] of Object.entries(aliases())) {
    if (norm(k) === n) return path.isAbsolute(v) ? v : path.join(cfg.projectsRoot, v);
  }
  const dirs = projectDirs();
  const exact = dirs.find((d) => norm(d) === n);
  if (exact) return path.join(cfg.projectsRoot, exact);
  if (!loose) return null;
  const words = spoken.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = dirs.map((d) => ({ d, s: words.filter((w) => norm(d).includes(w)).length }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored[1] && scored[1].s === scored[0].s)) return null; // none or ambiguous
  return path.join(cfg.projectsRoot, scored[0].d);
}
const spokenName = (repoPath) => path.basename(repoPath).replace(/[_\-.]+/g, ' ').trim();

// "in trading bot, add a stop-loss check"  (Siri doesn't always insert the comma)
function parseTask(body) {
  const m = body.match(/^(?:in|on|for)\s+(.+?)\s*[,:;]\s*([\s\S]+)$/i);
  if (m) { const repo = resolveRepo(m[1], true); if (repo) return { repo, task: m[2].trim() }; }
  const words = body.replace(/^(?:in|on|for)\s+/i, '').split(/\s+/);
  for (let k = Math.min(5, words.length - 1); k >= 1; k--) {
    const repo = resolveRepo(words.slice(0, k).join(' '), false);
    if (repo) return { repo, task: words.slice(k).join(' ').replace(/^[,:;\s]+/, '') };
  }
  return null;
}

// ---------- containers ----------
// Agents run with every permission inside their container, so what's mounted is the boundary. Never
// the relay's own folder (an agent could change the code the host runs, and read .env) or the folder
// holding the App key, nor any folder above them (an alias pointing at the home folder).
const PROTECTED = [ROOT, path.join(os.homedir(), '.bridge')];
// Bumped with agent/Dockerfile's label when the image changes in a way the relay relies on
// (version 3: no GitHub credential helper; pushes run in their own container).
const AGENT_IMAGE_VERSION = '3';
async function ensureContainer(a) {
  if (unsafeMount(a.repoPath, PROTECTED)) {
    await run('docker', ['rm', '-f', a.container]).catch(() => {});
    // An agent saved before its name had a safe folder (the relay's own name, before aliases.json pointed
    // it at the agents' clone) moves there; otherwise it can't run.
    const moved = resolveRepo(a.name, false);
    if (!moved || unsafeMount(moved, PROTECTED)) throw new Error(`${a.name}'s folder holds the relay or its keys, so no agent can work there. Clone the repo into another folder and point aliases.json at it.`);
    log(`${a.name}: moved from ${a.repoPath} to ${moved}.`);
    a.repoPath = moved;
    a.sessionId = null;   // its session belongs to the old folder
    save();
  }
  // Docker would mount a missing folder as a new empty one.
  if (!fs.existsSync(a.repoPath)) throw new Error(`${a.name}'s folder doesn't exist yet. Clone the repo there first.`);
  const [imageId, version] = await run('docker', ['image', 'inspect', '--format',
    '{{.Id}} {{index .Config.Labels "claude-voice-relay.image"}}', cfg.image]).then((r) => r.stdout.trim().split(' '), () => []);
  if (version !== AGENT_IMAGE_VERSION) throw new Error('The agent image is out of date. On the PC, run npm run build-agent.');
  // A container from another image (an older build, which may hold the owner's old full token in its
  // environment, or a credential helper) is replaced; sessions survive in the home volume.
  const [state, image] = await run('docker', ['inspect', '--format', '{{.State.Status}} {{.Image}}', a.container])
    .then((r) => r.stdout.trim().split(' '), () => []);
  if (state === 'running' && image === imageId) return;
  if (state) await run('docker', ['rm', '-f', a.container]);
  // Secrets go through the docker CLI's environment ("-e NAME"), not argv.
  await run('docker', ['run', '-d', '--name', a.container, '--label', 'claude-voice-relay=1',
    '-v', `${a.repoPath}:/work`, '-v', `${a.container}-home:/home/node/.claude`,
    '-e', 'CLAUDE_CODE_OAUTH_TOKEN', cfg.image], { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: cfg.oauth || '' } });
}

function runClaude(a, prompt, gitEnv) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-i', '-w', '/work', ...GIT_ENV.flatMap((k) => ['-e', k]), a.container,
      'claude', '-p', '--output-format', 'json', '--dangerously-skip-permissions', '--append-system-prompt',
      `${VOICE_PROMPT} ${ghApp || cfg.agentGhToken ? PUBLISH : NO_GITHUB}`];
    if (a.sessionId) args.push('--resume', a.sessionId);
    const p = spawn('docker', args, { windowsHide: true, env: { ...process.env, ...gitEnv } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch { reject(new Error(`claude exited ${code}: ${(err || out).slice(-400)}`)); }
    });
    p.stdin.end(prompt);
  });
}

function spoken(result) {
  const text = String(result || '');
  const i = text.lastIndexOf('SPOKEN:');
  const s = i >= 0 ? text.slice(i + 7)
    : text.replace(/```[\s\S]*?```/g, '').replace(/[#*`_>|]/g, '').slice(0, 300);
  return s.replace(/\s+/g, ' ').trim() || 'Finished, with no summary.';
}

function speakResult(a, r) {
  fs.writeFileSync(path.join(LOG_DIR, `${a.container}.last.md`), r.result || '');
  const line = spoken(r.result);
  a.awaiting = line.endsWith('?');
  a.question = a.awaiting ? line : ''; // "status" repeats it, in case the app missed it
  say(`${a.name}: ${r.is_error ? 'hit an error. ' : ''}${line}`,
    { spoken: r.is_error ? `${a.name} hit an error. ${line}` : line });
}

// AGENT_MODE=cloud: the turn runs in a claude.ai cloud session (cloud-agents.mjs) on the folder's GitHub
// remote, so it shows in the Claude app. The session pushes and opens its own pull request.
const cloudTurn = makeCloudTurn({
  run: (o) => runCloud({ spawn, claudeBin: resolveClaude({ bin: process.env.CLAUDE_BIN || 'claude' }), env: process.env, ...o }),
  // The session pushes through the Claude GitHub app, not the relay, so the repo must pass the check the
  // relay's GitHub App runs before it pushes (protected default branch, CODEOWNERS; README: GitHub access
  // for agents). AGENT_GH_TOKEN skips that check, so cloud mode needs the App.
  async checkRepo(a) {
    if (!ghApp) return 'cloud agents need the GitHub App set up first, as in the README. Nothing was started.';
    // The CLI works on the current branch's remote; the check below is of origin, so they must be the same.
    const branch = await hostValue('git', ['-C', a.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const remote = branch && await hostValue('git', ['-C', a.repoPath, 'config', '--get', `branch.${branch}.remote`]);
    if (remote && remote !== 'origin') return `its folder's current branch tracks ${remote}, not origin. Nothing was started.`;
    await agentGitHub.pinNow(a);
    if (!await agentGitHub.credentials(a, { checkOnly: true })) {
      return "its repo isn't set up for agents yet: its main branch needs the protection in the README, and the GitHub App installed. Nothing was started.";
    }
    return '';
  },
  unsafe: (folder) => unsafeMount(folder, PROTECTED),
  exists: fs.existsSync, say, speakResult, save, log,
});
// A cloud turn's CLI would outlive the relay (and keep its session waiting) when start.ps1 restarts it.
process.on('exit', () => { for (const a of agents.values()) a.proc?.kill(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

// `photo` (optional) is a host file copied into the container for this turn only, then deleted.
// It goes in /tmp, never /work, so an agent can't commit it to the repo.
async function turn(a, prompt, photo) {
  a.busy = true; a.awaiting = false; a.lastAt = Date.now(); save();
  const photoIn = photo && `/tmp/${path.basename(photo)}`;
  try {
    if (cfg.cloud) return await cloudTurn(a, prompt);
    await ensureContainer(a);
    // A request left by a turn that failed or was stopped belongs to that turn, not this one.
    // The folder is made here (in a git repo only) so the agent only has to write the file.
    await run('docker', ['exec', a.container, 'sh', '-c', 'rm -f "$1"; [ -d /work/.git ] && mkdir -p "$(dirname "$1")" 2>/dev/null; true', 'sh', REQUEST_FILE]);
    await agentGitHub.pinNow(a);
    if (photo) {
      await run('docker', ['cp', photo, `${a.container}:${photoIn}`]);
      fs.rmSync(photo, { force: true });
    }
    const r = await runClaude(a, photo ? prompt.replace('{photo}', photoIn) : prompt, await agentGitHub.identity());
    a.sessionId = r.session_id || a.sessionId;
    speakResult(a, r);
    const pushed = !a.stopped && await publisher.publish(a);
    if (pushed) say(`${a.name}: ${pushed}`, { spoken: pushed });
  } catch (e) {
    if (a.stopped) return;
    log(a.name, 'turn failed:', e.message);
    say(`${a.name} failed. ${e.message.slice(0, 200)}`);
  } finally {
    if (photo) {
      fs.rmSync(photo, { force: true });
      await run('docker', ['exec', a.container, 'rm', '-f', photoIn]).catch(() => {});
    }
    a.busy = false; a.lastAt = Date.now();
    if (!a.stopped) { save(); const next = a.queue.shift(); if (next) turn(a, next); }
  }
}

// ---------- commands ----------
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|approved?|do it|go ahead|go for it)\b[\s.!]*$/i;
const NO = /^(no|nope|nah|don'?t|deny|denied|cancel)\b[\s.!]*$/i;

function findAgentPrefix(text) {
  const t = norm(text);
  return [...agents.values()].sort((x, y) => norm(y.name).length - norm(x.name).length)
    .find((a) => t.startsWith(norm(a.name)));
}

// `body` is what was said after "task:", or { repo, task } already resolved by the read-back.
async function startTask(body) {
  const parsed = typeof body === 'string' ? parseTask(body) : body;
  if (!parsed || !parsed.task) return say("I couldn't tell which project. Say task, in, the project name, a pause, then the task.");
  const name = spokenName(parsed.repo);
  let a = agents.get(name);
  if (a?.busy) return say(`${name} is still working. Say stop ${name} first, or wait for it.`);
  if (!a) { a = { name, repoPath: parsed.repo, container: `claude-agent-${norm(name)}`, queue: [] }; agents.set(name, a); }
  else if (path.resolve(a.repoPath) !== path.resolve(parsed.repo)) {
    // The name now leads to another folder (aliases.json changed): its container mounts the old one.
    await run('docker', ['rm', '-f', a.container]).catch(() => {});
    a.repoPath = parsed.repo;
  }
  a.sessionId = null; a.cloudId = null; a.cloudUrl = null; // a new task gets fresh context
  a.cloudNew = true; // and, in cloud mode, a new cloud session
  say(`Starting ${name}.`);
  turn(a, parsed.task);
}

async function reply(text) {
  let a = findAgentPrefix(text);
  let msg = text;
  if (a) {
    msg = text.split(/\s+/).slice(a.name.split(/\s+/).length).join(' ').replace(/^[,:;.\s]+/, '');
  } else {
    const waiting = [...agents.values()].filter((x) => x.awaiting).sort((x, y) => y.lastAt - x.lastAt);
    a = waiting[0] || (agents.size === 1 ? [...agents.values()][0] : null);
    if (!a) return say('No agent is waiting on you. Start with task, or begin with the agent name.');
  }
  if (YES.test(msg)) msg = 'Yes, go ahead.';
  else if (NO.test(msg)) msg = "No, don't do that. Tell me what you would do instead.";
  if (a.busy) { a.queue.push(msg); return say(`${a.name} is busy. I'll pass that on when it finishes.`); }
  turn(a, msg);
}

async function status() {
  if (!agents.size) return say('No agents.');
  say([...agents.values()].map((a) => {
    const mins = Math.round((Date.now() - (a.lastAt || Date.now())) / 60000);
    return `${a.name} ${a.busy ? `is working, ${mins} minutes in.` : a.awaiting ? `is waiting for your answer: ${a.question || 'a yes or no question'}` : 'is idle.'}`;
  }).join(' '));
}

async function stopAgent(text) {
  const a = findAgentPrefix(text);
  if (!a) return say('Say stop, then the agent name.');
  a.stopped = true;
  agents.delete(a.name); save();
  // A cloud session runs on without the relay: stopping here ends the local CLI waiting for its reply.
  if (cfg.cloud) { a.proc?.kill(); return say(`Stopped listening to ${a.name}. If it's still working, stop it in the Claude app.`); }
  await run('docker', ['rm', '-f', a.container]).catch(() => {});
  say(`Stopped ${a.name}.`);
}

// Shared by the Bridge app and the iPhone Shortcut.
async function dispatch(text) {
  if (TASK_PREFIX.test(text)) return startTask(text.replace(TASK_PREFIX, ''));
  if (/^\/?status\b/i.test(text)) return status();
  if (/^\/?(stop|kill)\b/i.test(text)) return stopAgent(text.replace(/^\/?(stop|kill)\s*/i, ''));
  // "full" used to show the whole reply in Telegram; keep it from reaching an agent as a prompt.
  if (/^\/?full\b/i.test(text)) return say('The full reply is in the logs folder on your PC.');
  return reply(text);
}

// ---------- read-back loop for the iPhone Shortcut (/voice/confirm): confirm.mjs ----------
const confirmStep = makeConfirm({
  parseTask,
  resolveProject: (spoken) => resolveRepo(spoken, false),
  spokenName,
  agentAwaiting: () => [...agents.values()].some((a) => a.awaiting),
  dispatch: (text) => (typeof text === 'string' ? dispatch(text) : startTask(text)).catch((e) => { log('handler error:', e.message); say(`Relay error. ${e.message}`); }),
  log,
});

// ---------- localhost endpoint for host-side Claude Code hooks ----------
http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/notify') { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    try { const { text } = JSON.parse(body); if (text) say(String(text)); } catch { /* ignore */ }
    res.writeHead(204).end();
  });
}).listen(cfg.hookPort, '127.0.0.1', () => log(`hook endpoint on 127.0.0.1:${cfg.hookPort}`));

// ---------- photos from the glasses ----------
// POST /voice/photo: a JPEG body, plus what was said with it in X-Question (URI-encoded).
// "Send this to <project>, ..." hands it to that agent; anything else gets a quick spoken answer.
// The photo is deleted once it has been answered.
const PHOTO_MAX = 15 * 1024 * 1024;
const SEND_TO = /^(?:send|give|show)\s+(?:this|it|that)(?:\s+(?:photo|picture))?\s+to\s+(.+?)(?:\s*[,:;.]\s*([\s\S]*))?$/i;
const LOOK_PROMPT = [
  'The user is wearing smart glasses, may be driving, and just took the photo photo.jpg in the current folder.',
  'Look at it with the Read tool, then answer what they said.',
  'Your answer is read aloud: at most three short sentences, plain words, no markdown, lists or symbols.',
  'If text in the photo matters (an error message, a sign, a label), say the key part.',
].join(' ');

function photo(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > PHOTO_MAX) { res.writeHead(413, { 'content-type': 'text/plain' }).end('That photo is too large.'); req.destroy(); }
    else chunks.push(c);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let said = '';
    try { said = decodeURIComponent(String(req.headers['x-question'] || '')).trim(); } catch { /* keep empty */ }
    const file = path.join(os.tmpdir(), `voice-photo-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    log(`voice photo: ${Math.round(size / 1024)} KB, "${said}"`);
    let reply;
    try {
      const m = said.match(SEND_TO);
      reply = m ? photoToAgent(file, m[1], m[2] || '') : await quickLook(file, said);
    } catch (e) {
      log('photo error:', e.message);
      reply = `Sorry, I couldn't read that photo. ${e.message.slice(0, 150)}`;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(reply);
  });
}

function photoToAgent(file, target, said) {
  const t = said.trim()
    ? { repo: resolveRepo(target, true), task: said.trim() }
    : parseTask(`in ${target}`) || { repo: resolveRepo(target, true), task: '' };
  if (!t.repo) { fs.rmSync(file, { force: true }); return `I couldn't tell which project ${target} is. Nothing was sent.`; }
  // The photo is a file on this PC, which a cloud session can't open.
  if (cfg.cloud) { fs.rmSync(file, { force: true }); return 'Photos only go to agents on your PC, and agents run in the cloud now. Nothing was sent.'; }
  const name = spokenName(t.repo);
  let a = agents.get(name);
  if (a?.busy) { fs.rmSync(file, { force: true }); return `${name} is still working. Send the photo again when it finishes.`; }
  if (!a) {
    a = { name, repoPath: t.repo, container: `claude-agent-${norm(name)}`, queue: [] };
    agents.set(name, a);
  }
  const prompt = 'The user took a photo with their smart glasses and sent it to you. It is at {photo}; look at it with the Read tool. ' +
    (t.task ? `They said: ${t.task}` : 'They said nothing else, so say briefly what in it matters for this project and ask what they want.');
  turn(a, prompt, file);
  return `Sent the photo to ${name}.`;
}

function quickLook(file, said) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-look-'));
  fs.renameSync(file, path.join(dir, 'photo.jpg'));
  const prompt = `${LOOK_PROMPT}\n\nThey said: "${said || 'What am I looking at?'}"`;
  return new Promise((resolve, reject) => {
    // Prompt over stdin; every argv entry is fixed, so nothing said can become an argument.
    const p = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', '--output-format', 'json', '--allowedTools', 'Read'],
      { cwd: dir, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill(), 120000);
    const done = (fn) => { clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true }); fn(); };
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => done(() => reject(e)));
    p.on('close', (code) => done(() => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        if (r.is_error) return reject(new Error(r.result || 'Claude returned an error'));
        resolve(spoken(r.result));
      } catch { reject(new Error(`claude exited ${code}: ${(err || out).slice(-200)}`)); }
    }));
    p.stdin.end(prompt);
  });
}

// GET /voice/inbox?after=<id>: messages newer than <id>, waiting up to 25s for one to arrive.
// No `after` means "from now"; wait=0 answers at once (the app's connection test).
function inbox(req, res) {
  const q = new URL(req.url, 'http://relay').searchParams;
  const after = q.has('after') ? Number(q.get('after')) || 0 : outboxId;
  const fresh = () => outbox.filter((m) => m.id > after);
  let timer;
  const answer = () => {
    clearTimeout(timer);
    inboxWaiters.delete(answer);
    if (res.writableEnded) return;
    const messages = fresh().map(({ id, at, text }) => ({ id, text, age: Math.round((Date.now() - at) / 1000) }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ boot: BOOT, last: outboxId, messages }));
  };
  if (fresh().length || q.get('wait') === '0') return answer();
  timer = setTimeout(answer, 25000);
  inboxWaiters.add(answer);
  res.on('close', () => { clearTimeout(timer); inboxWaiters.delete(answer); });
}

// POST /voice/tts: body is the text (or {"text":...}); answers with MP3 audio. 503 when no key is set,
// so the app falls back to the phone's own voice.
function tts(req, res) {
  if (!cfg.openaiKey) { res.writeHead(503, { 'content-type': 'text/plain' }).end('TTS not configured.'); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
  req.on('end', async () => {
    let text = body;
    try { const j = JSON.parse(body); if (j && typeof j.text === 'string') text = j.text; } catch { /* plain-text body */ }
    text = String(text).trim().slice(0, 4000);
    if (!text) { res.writeHead(400).end(); return; }
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.openaiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.ttsModel, voice: cfg.ttsVoice, input: text, response_format: 'mp3',
          instructions: 'Speak naturally and warmly, at a relaxed conversational pace.' }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const audio = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length }).end(audio);
    } catch (e) {
      log('tts error:', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('TTS failed.');
    }
  });
}

// ---------- voice endpoint for the iPhone Shortcut (firewalled to Tailscale) ----------
if (voiceOff) log(`${voiceOff}; voice endpoint off. Set a long random VOICE_TOKEN in .env and restart.`);
else {
  // Compare hashes, so neither the comparison's timing nor a length check gives the token away.
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const want = sha(`Bearer ${cfg.voiceToken}`);
  const server = http.createServer((req, res) => {
    const ok = crypto.timingSafeEqual(sha(req.headers.authorization || ''), want);
    // Never log any of the header: a near-miss would put part of the real token in the log.
    if (!ok) { log(`voice 401 from ${req.socket.remoteAddress}: ${req.method} ${req.url}`); res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url.startsWith('/voice/inbox')) { inbox(req, res); return; }
    if (req.method === 'POST' && req.url === '/voice/tts') { tts(req, res); return; }
    if (req.method === 'POST' && req.url === '/voice/photo') { photo(req, res); return; }
    if (req.method !== 'POST' || !['/voice', '/voice/confirm', '/voice/send'].includes(req.url)) { log(`voice 404: ${req.method} ${req.url}`); res.writeHead(404).end(); return; }
    let body = '', tooBig = false;
    req.setEncoding('utf8'); // a character split across chunks stays whole
    req.on('data', (c) => {
      if (tooBig) return;
      body += c;
      if (body.length <= 20000) return;
      // Answer in words at once (a dropped connection is all the Shortcut could say otherwise),
      // then close the connection instead of reading the rest.
      tooBig = true;
      res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' })
        .end('That was too long. Can you say it shorter?', () => req.destroy());
    });
    req.on('end', () => {
      if (tooBig) return;
      const text = utterance(body, req.headers['content-type']);
      // /voice/send skips the read-back: the app's "Read back what I said" setting is off.
      if (req.url === '/voice/confirm' || (cfg.voiceConfirm && req.url !== '/voice/send')) {
        log('voice confirm:', text);
        res.writeHead(200, { 'content-type': 'text/plain' }).end(confirmStep(text));
        return;
      }
      if (!text) log(`voice empty body, content-type ${req.headers['content-type']}, raw: ${body.slice(0, 200)}`);
      if (!text) { res.writeHead(400, { 'content-type': 'text/plain' }).end('Nothing heard.'); return; }
      log('voice:', text);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Sent.');
      dispatch(text).catch((e) => { log('handler error:', e.message); say(`Relay error. ${e.message}`); });
    });
  }).on('clientError', (err, socket) => {
    // Malformed requests (e.g. a hidden character in a header) never reach the handler above.
    const raw = String(err.rawPacket || '').slice(0, 400).replace(/(authorization\s*:)[^\r\n]*/gi, '$1 ****');
    log(`voice clientError ${err.code}: ${err.message}; raw: ${JSON.stringify(raw)}`);
    try { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad request. Check the Authorization header for extra characters.'); } catch { /* socket gone */ }
  });
  // The Shortcut's loop reuses its connection after speaking the read-back and dictating the next
  // answer, often 10-30 seconds later. Node closes idle connections after 5 seconds by default, and
  // a POST sent on one that was just closed fails on the phone ("network connection was lost" or a
  // timeout) instead of being retried. Keep idle connections open longer than a turn takes.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.listen(cfg.voicePort, '0.0.0.0', () => {
    log(`voice endpoint on 0.0.0.0:${cfg.voicePort}`);
    log(cfg.openaiKey ? `natural voice on (${cfg.ttsVoice})` : 'natural voice off: no OPENAI_API_KEY, so the app speaks with the phone voice');
  });
}

load();
log(`relay up. projects root: ${cfg.projectsRoot}. ${agents.size} saved agent(s).`);
