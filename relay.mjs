// claude-voice-relay
// Telegram <-> containerized Claude Code agents, plus a localhost endpoint
// that host-side Claude Code hooks post "needs you" notifications to.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, 'state.json');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const cfg = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  voicePort: Number(process.env.VOICE_PORT || 47879),
  voiceToken: process.env.VOICE_TOKEN || '',
  // Read every Shortcut task back and wait for "send it"; VOICE_CONFIRM=0 sends immediately.
  voiceConfirm: process.env.VOICE_CONFIRM !== '0',
  projectsRoot: process.env.PROJECTS_ROOT || path.resolve(ROOT, '..'),
  hookPort: Number(process.env.HOOK_PORT || 47878),
  image: process.env.AGENT_IMAGE || 'claude-voice-agent:latest',
};

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'relay.log'), line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

if (!cfg.token) { log('TELEGRAM_BOT_TOKEN is missing from .env'); process.exit(1); }
if (!cfg.oauth) log('WARNING: CLAUDE_CODE_OAUTH_TOKEN missing; agents cannot run until it is set.');

// The agent's final message is read aloud, so it must end with a short, speakable line.
const VOICE_PROMPT = [
  'You are running unattended in a Docker container with full permissions; the repository is mounted at /work.',
  'The user is away from the screen, often driving, and only hears a spoken summary through headphones.',
  'When you finish a feature or bug fix, commit and push it.',
  "End every final message with a line that starts exactly with 'SPOKEN:' followed by one or two plain sentences for text-to-speech:",
  'no code, file paths, markdown, or symbols that read badly aloud.',
  'If you need a decision, stop and make the SPOKEN line a single yes-or-no question, then continue after the user answers.',
  'Everything above the SPOKEN line may be as detailed as you like; the user reads it later.',
].join(' ');

// ---------- Telegram ----------
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}
// Everything said is also held briefly for the glasses app, which long-polls /voice/inbox
// and reads new messages aloud. Ids restart with the relay, so replies carry BOOT too.
const BOOT = Date.now();
const outbox = []; // { id, at, text }
let outboxId = 0;
const inboxWaiters = new Set();
async function say(text, { voice = true } = {}) {
  if (voice) {
    outbox.push({ id: ++outboxId, at: Date.now(), text: String(text) });
    if (outbox.length > 50) outbox.shift();
    for (const wake of [...inboxWaiters]) wake();
  }
  if (!cfg.chatId) return log('(no TELEGRAM_CHAT_ID yet) would send:', text);
  try { await tg('sendMessage', { chat_id: cfg.chatId, text: String(text).slice(0, 4000) }); }
  catch (e) { log('send failed:', e.message); }
}

// ---------- host values passed into agent containers ----------
async function hostValue(cmd, args) { try { return (await run(cmd, args)).stdout.trim(); } catch { return ''; } }
const hostEnv = {
  GH_TOKEN: await hostValue('gh', ['auth', 'token']),
  GIT_NAME: await hostValue('git', ['config', '--global', 'user.name']),
  GIT_EMAIL: await hostValue('git', ['config', '--global', 'user.email']),
};

// ---------- agent state ----------
const agents = new Map(); // spoken name -> agent
function save() {
  const data = [...agents.values()].map(({ name, repoPath, container, sessionId, awaiting, lastFull, lastAt }) =>
    ({ name, repoPath, container, sessionId, awaiting, lastFull, lastAt }));
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
    .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
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
const PASS_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'];
async function ensureContainer(a) {
  const { stdout } = await run('docker', ['ps', '-a', '--filter', `name=^${a.container}$`, '--format', '{{.State}}']);
  if (stdout.trim() === 'running') return;
  if (stdout.trim()) await run('docker', ['rm', '-f', a.container]);
  // Secrets go through the docker CLI's environment ("-e NAME"), not argv.
  const env = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.oauth || '',
    GH_TOKEN: hostEnv.GH_TOKEN,
    GIT_AUTHOR_NAME: hostEnv.GIT_NAME, GIT_COMMITTER_NAME: hostEnv.GIT_NAME,
    GIT_AUTHOR_EMAIL: hostEnv.GIT_EMAIL, GIT_COMMITTER_EMAIL: hostEnv.GIT_EMAIL,
  };
  await run('docker', ['run', '-d', '--name', a.container, '--label', 'claude-voice-relay=1',
    '-v', `${a.repoPath}:/work`, '-v', `${a.container}-home:/home/node/.claude`,
    ...PASS_ENV.flatMap((k) => ['-e', k]), cfg.image], { env });
}

function runClaude(a, prompt) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-i', '-w', '/work', a.container, 'claude', '-p', '--output-format', 'json',
      '--dangerously-skip-permissions', '--append-system-prompt', VOICE_PROMPT];
    if (a.sessionId) args.push('--resume', a.sessionId);
    const p = spawn('docker', args, { windowsHide: true });
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

// `photo` (optional) is a host file copied into the container for this turn only, then deleted.
// It goes in /tmp, never /work, so an agent can't commit it to the repo.
async function turn(a, prompt, photo) {
  a.busy = true; a.awaiting = false; a.lastAt = Date.now(); save();
  const photoIn = photo && `/tmp/${path.basename(photo)}`;
  try {
    await ensureContainer(a);
    if (photo) {
      await run('docker', ['cp', photo, `${a.container}:${photoIn}`]);
      fs.rmSync(photo, { force: true });
    }
    const r = await runClaude(a, photo ? prompt.replace('{photo}', photoIn) : prompt);
    a.sessionId = r.session_id || a.sessionId;
    a.lastFull = r.result || '';
    fs.writeFileSync(path.join(LOG_DIR, `${a.container}.last.md`), a.lastFull);
    const line = spoken(r.result);
    a.awaiting = line.endsWith('?');
    await say(`${a.name}: ${r.is_error ? 'hit an error. ' : ''}${line}`);
  } catch (e) {
    if (a.stopped) return;
    log(a.name, 'turn failed:', e.message);
    await say(`${a.name} failed. ${e.message.slice(0, 200)}`);
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

async function startTask(body) {
  const parsed = parseTask(body);
  if (!parsed || !parsed.task) return say("I couldn't tell which project. Say task, in, the project name, a pause, then the task.");
  const name = spokenName(parsed.repo);
  let a = agents.get(name);
  if (a?.busy) return say(`${name} is still working. Say stop ${name} first, or wait for it.`);
  if (!a) { a = { name, repoPath: parsed.repo, container: `claude-agent-${norm(name)}`, queue: [] }; agents.set(name, a); }
  a.sessionId = null; // a new task gets fresh context
  await say(`Starting ${name}.`);
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
    return `${a.name} ${a.busy ? `is working, ${mins} minutes in` : a.awaiting ? 'is waiting for your answer' : 'is idle'}.`;
  }).join(' '));
}

async function stopAgent(text) {
  const a = findAgentPrefix(text);
  if (!a) return say('Say stop, then the agent name.');
  a.stopped = true;
  await run('docker', ['rm', '-f', a.container]).catch(() => {});
  agents.delete(a.name); save();
  say(`Stopped ${a.name}.`);
}

async function full(text) {
  const a = findAgentPrefix(text) || [...agents.values()].sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0))[0];
  if (!a?.lastFull) return say('Nothing to show yet.');
  say(a.lastFull, { voice: false }); // screen-only: too long to read aloud
}

async function onMessage(m) {
  if (!m?.text) return;
  const from = String(m.chat.id);
  if (!cfg.chatId) return log(`Message from chat ${from}. If that's you, set TELEGRAM_CHAT_ID=${from} in .env and restart.`);
  if (from !== cfg.chatId) return log('ignored message from chat', from);
  return dispatch(m.text.trim());
}

// Shared by Telegram and the iPhone Shortcut endpoint.
const TASK_PREFIX = /^(new\s+)?task\b\s*[:,.]?\s*/i;
async function dispatch(text) {
  if (TASK_PREFIX.test(text)) return startTask(text.replace(TASK_PREFIX, ''));
  if (/^\/?status\b/i.test(text)) return status();
  if (/^\/?(stop|kill)\b/i.test(text)) return stopAgent(text.replace(/^\/?(stop|kill)\s*/i, ''));
  if (/^\/?full\b/i.test(text)) return full(text.replace(/^\/?full\s*/i, ''));
  if (/^\/start\b/i.test(text)) return say('Relay online.');
  return reply(text);
}

// ---------- read-back loop for the iPhone Shortcut (/voice/confirm) ----------
// Each utterance is held and read back until the user says "send it". Every reply that
// expects another utterance contains the word "again"; the Shortcut stops listening otherwise.
const SEND = /^(?:(?:yes|yeah|ok(?:ay)?)[\s,]+)?(?:send(?: it)?|go(?: ahead)?|do it|yes|yep|yeah)[\s.!]*$/i;
const CANCEL = /^(?:cancel|never ?mind|forget it|stop)[\s.!]*$/i;
const CONFIRM_TTL = 10 * 60000;
let pending = null; // { text, at }

function confirmStep(raw) {
  if (pending && Date.now() - pending.at > CONFIRM_TTL) pending = null;
  const isTask = TASK_PREFIX.test(raw);
  const body = raw.replace(TASK_PREFIX, '').replace(/[\s.!?]+$/, '').trim();
  if (!body) return "I didn't catch that. Say the task again.";
  if (SEND.test(body)) {
    if (!pending) {
      // With nothing held, a bare "yes" answers an agent's yes-or-no question.
      if (YES.test(body) && [...agents.values()].some((a) => a.awaiting)) {
        log('voice answer: yes');
        dispatch('yes').catch((e) => { log('handler error:', e.message); say(`Relay error. ${e.message}`); });
        return 'Sent.';
      }
      return 'Nothing is waiting to send. Say the task again.';
    }
    const { text } = pending;
    pending = null;
    log('voice confirmed:', text);
    dispatch(text).catch((e) => { log('handler error:', e.message); say(`Relay error. ${e.message}`); });
    return 'Sent.';
  }
  if (CANCEL.test(body)) { pending = null; return 'Cancelled. Nothing sent.'; }
  if (isTask) {
    const parsed = parseTask(body);
    if (!parsed?.task) {
      pending = null;
      return `I heard: ${body}. I can't tell which project that's for. Say the task again, starting with in and the project name.`;
    }
    pending = { text: raw, at: Date.now() };
    return `I heard: ${body}. That goes to ${spokenName(parsed.repo)}. Say send it, or say the task again.`;
  }
  pending = { text: raw, at: Date.now() };
  return `I heard: ${body}. Say send it, or say it again.`;
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await onMessage(u.message).catch((e) => { log('handler error:', e.message); say(`Relay error. ${e.message}`); });
      }
    } catch (e) {
      // fetch hides the network reason (DNS, timeout, refused) in e.cause
      log('poll error:', e.message, e.cause ? `(${e.cause.code || e.cause.message})` : '');
      await sleep(5000);
    }
  }
}

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

// ---------- voice endpoint for the iPhone Shortcut (firewalled to Tailscale) ----------
if (cfg.voiceToken) {
  const want = Buffer.from(`Bearer ${cfg.voiceToken}`);
  http.createServer((req, res) => {
    const got = Buffer.from(String(req.headers.authorization || ''));
    const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    const h = String(req.headers.authorization || '');
    if (!ok) { log(`voice 401 from ${req.socket.remoteAddress}: ${req.method} ${req.url}, auth len ${h.length} (want ${want.length}), starts '${h.slice(0, 7)}', ends '${h.slice(-3)}'`); res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url.startsWith('/voice/inbox')) { inbox(req, res); return; }
    if (req.method === 'POST' && req.url === '/voice/photo') { photo(req, res); return; }
    if (req.method !== 'POST' || (req.url !== '/voice' && req.url !== '/voice/confirm')) { log(`voice 404: ${req.method} ${req.url}`); res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let text = body;
      try { const j = JSON.parse(body); if (j && typeof j.text === 'string') text = j.text; } catch { /* plain-text body */ }
      text = String(text).trim();
      if (req.url === '/voice/confirm' || cfg.voiceConfirm) {
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
  }).listen(cfg.voicePort, '0.0.0.0', () => log(`voice endpoint on 0.0.0.0:${cfg.voicePort}`));
} else log('VOICE_TOKEN not set; voice endpoint disabled.');

load();
log(`relay up. projects root: ${cfg.projectsRoot}. ${agents.size} saved agent(s).`);
poll();
