// Builds the public, self-hosted copy of Bridge (the bridge-relay repo) from this private repo.
// This repo is the source of truth: the free core (relay, agent image, hooks, the sideload app) is copied,
// the paid product (Bridge Cloud, the website, the App Store flavour) is left out, and public/ is laid on top.
//
//   node export-public.mjs <dest>    writes the public tree at HEAD into <dest> (.git kept)
//
// Files come from the commit, never the working tree, so uncommitted edits and untracked files can't leak.
// Swift files lose their `#if APP_STORE` branches (and keep `#if !APP_STORE` ones), so the public app is
// exactly the personal flavour. The export fails if anything paid or private is left in it, if a file under
// glasses/ios isn't classified as public or paid, or if <dest> could be anything but the public repo.
// bridge-relay must start from a fresh `git init`: a clone of this repo would publish its history.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OVERLAY = 'public/';
// Written into every export; a non-empty <dest> without it is refused, so a mistyped path is never emptied.
export const MARKER = '.bridge-relay-export';

// Tracked files that go public, by exact path or folder prefix (ending in /). glasses/ios is listed file by file.
export const INCLUDE = [
  'relay.mjs', 'confirm.mjs', 'confirm.test.mjs', 'cloud-agents.mjs', 'cloud-agents.test.mjs', 'github-app.mjs', 'github-app.test.mjs', 'publish.mjs',
  'publish.test.mjs', 'setup-github-app.mjs', 'install-hook.mjs', 'start.ps1', 'aliases.json', 'package.json',
  '.env.example', '.gitignore', 'README.md', 'agent/', 'hooks/', 'glasses/SIDELOAD.md',
  '.github/workflows/glasses-release.yml', '.github/workflows/impactor-check.yml',
  'glasses/ios/project.yml', 'glasses/ios/icon.test.mjs', 'glasses/ios/GlassesRelay/Assets.xcassets/',
  ...['Conversation', 'ErrorReporting', 'GlassesController', 'GlassesRelayApp', 'HelpView', 'HomeView', 'Relay',
    'SettingsView', 'Shortcuts', 'Store'].map((n) => `glasses/ios/GlassesRelay/${n}.swift`),
  'glasses/ios/GlassesRelay/PrivacyInfo.xcprivacy',
];
// Paid files under glasses/ios: App Store signing, and whole-file `#if APP_STORE`.
export const EXCLUDE = [
  'glasses/ios/AppStore.entitlements', 'glasses/ios/GlassesRelay/Account.swift',
  'glasses/ios/GlassesRelay/Push.swift', 'glasses/ios/GlassesRelay/WelcomeView.swift',
];
// Every file under these folders must be in INCLUDE or EXCLUDE, so a new paid file can't slip out unnoticed.
const CLASSIFIED = ['glasses/ios/'];
// README sections about the paid product.
const PAID_SECTION = /^## .*(Bridge Cloud|custom connector)/i;
// Nothing in the public tree may match these.
export const FORBIDDEN = [
  /APP_STORE/, /import (StoreKit|AuthenticationServices|PushKit|CallKit)\b/,
  /canImport\((StoreKit|AuthenticationServices|PushKit|CallKit)\)/, /execute-api/, /651325958035/,
  /cloudSession/, /talktobridge\.com/, /com\.talktobridge\.bridge\.(pro|web)/, /smitherman/i,
  /powerspec/i, /taila78b6c/, /\.tail(?!1234\b)[0-9a-f]{6}\.ts\.net/, /[a-z0-9-]+\.ingest\.[a-z.]*sentry\.io/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /\bsk-[A-Za-z0-9_-]{30,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /C:\\Users\\(?!you\\)/i,
];
// Binary files allowed in the export (the icons); any other file must be text.
const BINARY_OK = /\.(png|jpe?g)$/i;

export const included = (path) =>
  !EXCLUDE.includes(path) && INCLUDE.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

/**
 * Resolves `#if APP_STORE` / `#if !APP_STORE` blocks for a build without APP_STORE: keeps the code a
 * personal build compiles and drops the rest. Other conditions (and their #else/#endif) pass through.
 */
export function stripAppStore(source) {
  const out = [];
  const stack = [];   // per open #if: { ours, keep } where keep says whether lines in the current branch stay
  const live = () => stack.every((f) => f.keep);
  for (const line of source.split('\n')) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#if\s+(!?)APP_STORE\s*$/))) { stack.push({ ours: true, keep: m[1] === '!' }); continue; }
    if (/^#if\b/.test(t)) { stack.push({ ours: false, keep: true }); if (live()) out.push(line); continue; }
    const top = stack.at(-1);
    if (/^#else\b/.test(t) && top) {
      if (top.ours) { top.keep = !top.keep; continue; }
    } else if (/^#elseif\b/.test(t) && top?.ours) {
      throw new Error('#elseif in an APP_STORE block is not supported');
    } else if (/^#endif\b/.test(t) && top) {
      stack.pop();
      if (top.ours) continue;
      if (live()) out.push(line);
      continue;
    }
    if (live()) out.push(line);
  }
  if (stack.length) throw new Error('unbalanced #if');
  return out.join('\n');
}

/** README.md without its paid sections (a `## ` heading through the next one). */
export function publicReadme(source) {
  const out = [];
  let skip = false;
  for (const line of source.split('\n')) {
    if (line.startsWith('## ')) skip = PAID_SECTION.test(line);
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n*$/, '\n');
}

/**
 * project.yml without the comment that explains how CI builds the App Store flavour, and without the voip
 * background mode, which only the App Store build's agent calls (Push.swift) use.
 */
export function publicProject(source) {
  const lines = source.split('\n').filter((l) => !/^\s*# voip:/.test(l))
    .map((l) => l.replace(/(UIBackgroundModes: \[.*), voip\]/, '$1]'));
  const start = lines.findIndex((l) => /^\s*# The App Store flavour/.test(l));
  if (start < 0) return lines.join('\n');
  let end = start;
  while (end < lines.length && /^\s*#/.test(lines[end])) end++;
  lines.splice(start, end - start);
  return lines.join('\n');
}

function transform(path, text) {
  if (path.endsWith('.swift')) return stripAppStore(text);
  if (path === 'glasses/ios/project.yml') return publicProject(text);
  // The public repo is bridge-relay, so its README and voice aliases point at a clone of that.
  if (path === 'README.md') return publicReadme(text).replaceAll('claude-voice-relay', 'bridge-relay');
  if (path === 'aliases.json') return text.replaceAll('claude-voice-relay', 'bridge-relay');
  return text;
}

const git = (cwd, args, encoding = 'utf8') =>
  execFileSync('git', args, { cwd, encoding, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

/** Every file in the commit: { path, mode, sha }. */
function tree(root, ref) {
  return git(root, ['ls-tree', '-r', '-z', '--full-tree', ref]).split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, , sha] = meta.split(' ');
    return { path, mode, sha };
  });
}

/** Text of a file for the forbidden check: UTF-8, or UTF-16 when it has a byte order mark; null if binary. */
export function textOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.includes(0) ? null : buf.toString('utf8');
}

// Real path with case folded on Windows, for paths that may not exist yet.
function real(p) {
  let base = resolve(p);
  const rest = [];
  while (!existsSync(base)) { rest.unshift(basename(base)); base = dirname(base); }
  const out = join(realpathSync.native(base), ...rest);
  return process.platform === 'win32' ? out.toLowerCase() : out;
}
const inside = (a, b) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);

/** Refuses a dest that overlaps this repo, holds someone's files, or shares history with this repo. */
function checkDest(dest, root) {
  const out = real(dest), src = real(root);
  if (inside(out, src) || inside(src, out)) throw new Error(`Refusing to export into ${dest}: it overlaps this repo`);
  if (!existsSync(dest)) return;
  const names = readdirSync(dest).filter((n) => n !== '.git');
  if (names.length && !names.includes(MARKER)) {
    throw new Error(`Refusing to export into ${dest}: it isn't empty and has no ${MARKER} from an earlier export`);
  }
  if (existsSync(join(dest, '.git'))) {
    for (const commit of git(root, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').filter(Boolean)) {
      try { git(dest, ['cat-file', '-e', `${commit}^{commit}`]); } catch { continue; }
      throw new Error(`Refusing to export into ${dest}: its git history contains this repo's; start it with a fresh git init`);
    }
  }
}

/** Writes the public tree at ref into dest and returns the paths written. */
export function exportPublic(dest, { root = ROOT, ref = 'HEAD' } = {}) {
  checkDest(dest, root);
  const entries = tree(root, ref);
  const problems = [];
  const files = new Map();
  const take = (entry, path) => {
    if (entry.mode === '120000') return problems.push(`${entry.path}: symlinks are not exported`);
    if (entry.mode === '160000') return problems.push(`${entry.path}: submodules are not exported`);
    const buf = git(root, ['cat-file', 'blob', entry.sha], 'buffer');
    if (BINARY_OK.test(path)) return files.set(path, buf);
    const text = textOf(buf);
    if (text === null) return problems.push(`${entry.path}: binary file`);
    files.set(path, entry.path.startsWith(OVERLAY) ? text : transform(path, text));
  };
  for (const entry of entries) {
    const { path } = entry;
    if (path.startsWith(OVERLAY)) continue;
    if (CLASSIFIED.some((c) => path.startsWith(c)) && !included(path) && !EXCLUDE.includes(path)) {
      problems.push(`${path}: not classified; add it to INCLUDE or EXCLUDE in export-public.mjs`);
    } else if (included(path)) take(entry, path);
  }
  const tail = entries.find((e) => e.path === `${OVERLAY}README.tail.md`);
  // The overlay comes from the same commit and replaces tracked files of the same name.
  for (const entry of entries) {
    if (entry.path.startsWith(OVERLAY) && entry !== tail) take(entry, entry.path.slice(OVERLAY.length));
  }
  if (tail && files.has('README.md')) {
    files.set('README.md', files.get('README.md') + '\n' + git(root, ['cat-file', 'blob', tail.sha]));
  }
  files.set(MARKER, 'Written by export-public.mjs in the private Bridge repo; this folder is replaced by each export.\n');
  for (const [path, body] of files) {
    if (BINARY_OK.test(path)) continue;
    for (const re of FORBIDDEN) if (re.test(body)) problems.push(`${path}: ${re}`);
  }
  if (problems.length) throw new Error(`The public export was refused:\n${problems.join('\n')}`);
  if (existsSync(dest)) {
    for (const name of readdirSync(dest)) if (name !== '.git') rmSync(join(dest, name), { recursive: true, force: true });
  }
  for (const [path, body] of files) {
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    writeFileSync(join(dest, path), body);
  }
  return [...files.keys()].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest) { console.error('usage: node export-public.mjs <dest>'); process.exit(2); }
  const written = exportPublic(dest);
  console.log(`Wrote ${written.length} files to ${dest}`);
}
