// Builds the public, self-hosted copy of Bridge (the bridge-relay repo) from this private repo.
// This repo is the source of truth: the free core (relay, agent image, hooks, the sideload app) is copied,
// the paid product (Bridge Cloud, the website, the App Store flavour) is left out, and public/ is laid on top.
//
//   node export-public.mjs <dest>    writes the public tree into <dest> (emptied first, .git kept)
//
// Swift files lose their `#if APP_STORE` branches (and keep `#if !APP_STORE` ones), so the public app is
// exactly the personal flavour. The export fails if anything paid or private is left in it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OVERLAY = 'public';

// Tracked files that go public, by exact path or folder prefix (ending in /).
export const INCLUDE = [
  'relay.mjs', 'confirm.mjs', 'confirm.test.mjs', 'github-app.mjs', 'github-app.test.mjs', 'publish.mjs',
  'publish.test.mjs', 'setup-github-app.mjs', 'install-hook.mjs', 'start.ps1', 'aliases.json', 'package.json',
  '.env.example', '.gitignore', 'README.md', 'agent/', 'hooks/', 'glasses/SIDELOAD.md', 'glasses/ios/',
  '.github/workflows/glasses-release.yml', '.github/workflows/impactor-check.yml',
];
// Paid files inside an included folder: whole-file `#if APP_STORE` or App Store signing only.
export const EXCLUDE = [
  'glasses/ios/AppStore.entitlements', 'glasses/ios/GlassesRelay/Account.swift',
  'glasses/ios/GlassesRelay/Push.swift', 'glasses/ios/GlassesRelay/WelcomeView.swift',
];
// README sections about the paid product.
const PAID_SECTION = /^## .*(Bridge Cloud|custom connector)/i;
// Nothing in the public tree may match these.
export const FORBIDDEN = [
  /APP_STORE/, /import (StoreKit|AuthenticationServices|PushKit|CallKit)\b/, /execute-api/, /651325958035/,
  /cloudSession/, /talktobridge\.com/, /smitherman/i,
];

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

/** project.yml without the comment that explains how CI builds the App Store flavour. */
export function publicProject(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^\s*# The App Store flavour/.test(l));
  if (start < 0) return source;
  let end = start;
  while (end < lines.length && /^\s*#/.test(lines[end])) end++;
  lines.splice(start, end - start);
  return lines.join('\n');
}

function transform(path, text) {
  if (path.endsWith('.swift')) return stripAppStore(text);
  if (path === 'glasses/ios/project.yml') return publicProject(text);
  if (path === 'README.md') {
    const tail = join(ROOT, OVERLAY, 'README.tail.md');
    return publicReadme(text) + (existsSync(tail) ? '\n' + readFileSync(tail, 'utf8') : '');
  }
  return text;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Writes the public tree into dest and returns the paths written. */
export function exportPublic(dest, { root = ROOT } = {}) {
  const files = new Map();
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of tracked.filter(included)) {
    const buf = readFileSync(join(root, path));
    const text = buf.toString('utf8');
    // Binary files (icons) are copied as they are; text gets the transforms.
    files.set(path, buf.includes(0) || /\.(png|jpg)$/.test(path) ? buf : transform(path, text));
  }
  const overlay = join(root, OVERLAY);
  if (existsSync(overlay)) {
    for (const abs of walk(overlay)) {
      const path = relative(overlay, abs).split('\\').join('/');
      if (path === 'README.tail.md') continue;
      files.set(path, readFileSync(abs));
    }
  }
  const problems = [];
  for (const [path, body] of files) {
    if (Buffer.isBuffer(body) && body.includes(0)) continue;
    const text = body.toString();
    for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${path}: ${re}`);
  }
  if (problems.length) throw new Error(`Paid or private content in the public export:\n${problems.join('\n')}`);
  // Empty dest only once the export is known clean, so a failed check leaves a local clone untouched.
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
