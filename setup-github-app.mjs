// Creates the "Bridge agents" GitHub App that agent containers push with, instead of your own login.
// Run on the PC from the repo folder:  node setup-github-app.mjs  ["Optional App name"]
// Your browser opens GitHub; click "Create GitHub App", then pick the repositories agents may use.
// The App's private key is saved under your user folder (never in the repo) and .env is updated.
// Permissions: contents and pull requests read/write, metadata read. No workflows, secrets,
// administration or webhooks, so agents can't edit CI, read secrets or change repo settings.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRemote } from './github-app.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
const name = (process.argv[2] || `Bridge agents ${os.hostname()}`).slice(0, 34);
const state = crypto.randomBytes(16).toString('hex');

let homepage = 'https://github.com';
try {
  const r = parseRemote(execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }));
  if (r) homepage = `https://github.com/${r.owner}/${r.repo}`;
} catch { /* no git; any URL will do */ }

function open(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* the URL is printed too */ }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = (body) => `<!doctype html><meta charset="utf-8"><title>Bridge agents</title>
<body style="font:16px system-ui;max-width:40em;margin:3em auto">${body}</body>`;

// Sets KEY=value in .env, replacing an existing line, keeping everything else as it was.
function setEnv(text, key, value) {
  // Single quotes: node --env-file reads them literally, so a # or a \n in a Windows path survives.
  const line = `${key}='${value}'`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // Only this machine's own browser tab: a page on another site rebinding a hostname to 127.0.0.1 is refused.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403).end(); return; }
  if (url.pathname === '/') {
    const { port } = server.address();
    const manifest = {
      name,
      url: homepage,
      redirect_url: `http://127.0.0.1:${port}/done`,
      public: false,
      hook_attributes: { url: 'https://example.com/unused', active: false },
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      default_events: [],
    };
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(`<p>Sending you to GitHub to create <b>${esc(name)}</b>…</p>
<form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script>`));
    return;
  }
  if (url.pathname !== '/done') { res.writeHead(404).end(); return; }
  if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('<p>That link is not from this setup run. Start again.</p>'));
    return;
  }
  try {
    const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get('code'))}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'claude-voice-relay' },
    });
    const app = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${app.message || ''}`);
    const dir = path.join(os.homedir(), '.bridge');
    fs.mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, `${app.slug}.pem`);
    fs.writeFileSync(keyFile, app.pem, { mode: 0o600 });
    // Windows ignores the mode, so the key would inherit the home folder's access: limit it to this user.
    if (process.platform === 'win32') {
      try { execFileSync('icacls', [keyFile, '/inheritance:r', '/grant:r', `${os.userInfo().username}:R`], { stdio: 'ignore' }); }
      catch { console.warn(`Couldn't restrict access to ${keyFile}; do it in its Properties > Security.`); }
      if (/onedrive/i.test(keyFile)) console.warn(`${keyFile} is in a OneDrive folder, so the key will sync to the cloud. Move it and update GITHUB_APP_KEY_FILE.`);
    }
    let env = '';
    try { env = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* new file */ }
    env = setEnv(setEnv(env, 'GITHUB_APP_ID', app.id), 'GITHUB_APP_KEY_FILE', keyFile);
    fs.writeFileSync(ENV_FILE, env);
    const install = `${app.html_url}/installations/new`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(`<p>Created <b>${esc(app.name)}</b>. Key saved to ${esc(keyFile)}; .env updated.</p>
<p>Last step: <a href="${esc(install)}">install it</a>, choose <b>Only select repositories</b>, and pick the repos agents may push to.</p>`));
    console.log(`Created ${app.name} (App ID ${app.id}).`);
    console.log(`Private key: ${keyFile}`);
    console.log(`.env now has GITHUB_APP_ID and GITHUB_APP_KEY_FILE.`);
    console.log(`Last step, in the browser: install it on only the repositories agents may use:\n  ${install}`);
    console.log('Then restart the relay (stop the node relay.mjs process; start.ps1 brings it back).');
    open(install);
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html' }).end(page(`<p>Setup failed: ${esc(e.message)}</p>`));
    console.error('Setup failed:', e.message);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500);
  }
});

server.listen(0, '127.0.0.1', () => {
  const start = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Creating the GitHub App "${name}". If the browser doesn't open, go to ${start}`);
  open(start);
});
setTimeout(() => { console.error('Gave up after 15 minutes; run it again.'); process.exit(1); }, 15 * 60_000).unref();
