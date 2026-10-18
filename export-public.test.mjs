import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripAppStore, publicReadme, publicProject, included, exportPublic, textOf, FORBIDDEN, MARKER } from './export-public.mjs';

test('keeps the personal branch of APP_STORE blocks and drops the App Store one', () => {
  const src = ['a', '#if APP_STORE', 'paid', '#else', 'free', '#endif', '  #if !APP_STORE', '  hey', '  #endif', 'b'].join('\n');
  assert.equal(stripAppStore(src), ['a', 'free', '  hey', 'b'].join('\n'));
});

test('leaves other conditions alone, including inside APP_STORE blocks', () => {
  const src = ['#if DEBUG', 'x', '#else', 'y', '#endif', '#if APP_STORE', '#if DEBUG', 'z', '#endif', '#endif'].join('\n');
  assert.equal(stripAppStore(src), ['#if DEBUG', 'x', '#else', 'y', '#endif'].join('\n'));
});

test('refuses unbalanced blocks', () => {
  assert.throws(() => stripAppStore('#if APP_STORE\nx'), /unbalanced/);
});

test('keeps an #if !APP_STORE branch and drops its #else', () => {
  const src = ['#if !APP_STORE', 'free', '#else', 'paid', '#endif'].join('\n');
  assert.equal(stripAppStore(src), 'free');
});

test('refuses #elseif inside an APP_STORE block', () => {
  assert.throws(() => stripAppStore('#if APP_STORE\na\n#elseif DEBUG\nb\n#endif'), /elseif/);
});

test('the public project drops the voip background mode', () => {
  const src = ['        # voip: an agent call', '        UIBackgroundModes: [audio, external-accessory, voip]'].join('\n');
  assert.equal(publicProject(src), '        UIBackgroundModes: [audio, external-accessory]');
});

test('drops the paid README sections', () => {
  const src = '# t\n\n## Setup\nrun it\n## Use Bridge from Claude (custom connector)\npaid\n## Bridge Cloud\nmore\n';
  assert.equal(publicReadme(src), '# t\n\n## Setup\nrun it\n');
});

test('drops the App Store comment from project.yml', () => {
  const src = 'a: 1\n        # The App Store flavour is selected with\n        # APP_STORE on the command line.\nb: 2';
  assert.equal(publicProject(src), 'a: 1\nb: 2');
});

test('keeps the paid product out', () => {
  assert.ok(included('relay.mjs'));
  assert.ok(included('glasses/ios/GlassesRelay/Relay.swift'));
  for (const path of ['cloud/api/index.mjs', 'site/index.html', 'CLAUDE.md', '.github/workflows/cloud-deploy.yml',
    'glasses/APP_STORE.md', 'glasses/ios/GlassesRelay/Account.swift', 'glasses/ios/GlassesRelay/Push.swift',
    'glasses/ios/AppStore.entitlements', 'export-public.mjs']) {
    assert.ok(!included(path), path);
  }
});

test('the whole export passes its own checks and has the public files', () => {
  const dest = mkdtempSync(join(tmpdir(), 'bridge-public-'));
  try {
    const files = exportPublic(dest);
    for (const f of ['LICENSE', 'README.md', 'relay.mjs', '.github/workflows/ci.yml', 'glasses/ios/GlassesRelay/Store.swift']) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(!existsSync(join(dest, 'cloud')));
    assert.match(readFileSync(join(dest, 'README.md'), 'utf8'), /## Licence/);
    assert.doesNotMatch(readFileSync(join(dest, 'glasses/ios/GlassesRelay/Store.swift'), 'utf8'), /StoreKit/);
    // Every local import resolves inside the export, so a new relay module can't be left behind.
    for (const f of files.filter((f) => f.endsWith('.mjs'))) {
      for (const [, spec] of readFileSync(join(dest, f), 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        assert.ok(existsSync(join(dest, dirname(f), spec)), `${f} imports ${spec}`);
      }
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

// A throwaway source repo with one commit of `files` (path -> contents), and an empty destination.
function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-src-'));
  const dest = join(mkdtempSync(join(tmpdir(), 'bridge-dest-')), 'out');
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
  g('init', '-q');
  const write = (fs) => { for (const [p, body] of Object.entries(fs)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); } };
  write(files);
  g('add', '-A');
  g('commit', '-qm', 'one');
  const done = () => { rmSync(root, { recursive: true, force: true }); rmSync(dirname(dest), { recursive: true, force: true }); };
  return { root, dest, g, write, done };
}

test('exports the commit, not uncommitted or untracked files', () => {
  const s = scratch({ 'relay.mjs': 'ok\n', 'public/LICENSE': 'MIT\n' });
  try {
    s.write({ 'relay.mjs': 'const token = "ghp_' + 'a'.repeat(36) + '";\n', 'public/.env': 'SECRET=1\n', 'hooks/new.mjs': 'x' });
    const files = exportPublic(s.dest, { root: s.root });
    assert.deepEqual(files, [MARKER, 'LICENSE', 'relay.mjs']);
    assert.equal(readFileSync(join(s.dest, 'relay.mjs'), 'utf8'), 'ok\n');
  } finally { s.done(); }
});

test('refuses symlinks, in the tree and in the overlay', () => {
  const s = scratch({ 'relay.mjs': 'ok\n' });
  try {
    symlinkSync('../relay.mjs', join(s.root, 'hooks-link'));
    mkdirSync(join(s.root, 'agent'));
    symlinkSync('../relay.mjs', join(s.root, 'agent', 'x'));
    mkdirSync(join(s.root, 'public'));
    symlinkSync('../relay.mjs', join(s.root, 'public', 'y'));
    s.g('add', '-A');
    s.g('commit', '-qm', 'links');
    assert.throws(() => exportPublic(s.dest, { root: s.root }), (e) => /agent\/x: symlinks/.test(e.message) && /public\/y: symlinks/.test(e.message));
  } finally { s.done(); }
});

test('refuses an unclassified file under glasses/ios', () => {
  const s = scratch({ 'glasses/ios/GlassesRelay/Calls.swift': 'let x = 1\n' });
  try {
    assert.throws(() => exportPublic(s.dest, { root: s.root }), /Calls\.swift: not classified/);
  } finally { s.done(); }
});

test('scans UTF-16 text and refuses other binary files', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('import StoreKit\n', 'utf16le')]);
  assert.equal(textOf(utf16), 'import StoreKit\n');
  const s = scratch({ 'hooks/notes.md': utf16, 'agent/blob.bin': Buffer.from([1, 0, 2]) });
  try {
    assert.throws(() => exportPublic(s.dest, { root: s.root }), (e) => /hooks\/notes\.md: .*StoreKit/.test(e.message) && /agent\/blob\.bin: binary/.test(e.message));
  } finally { s.done(); }
});

test('every forbidden pattern catches what it is for, and placeholders pass', () => {
  const hits = ['#if APP_STORE', 'import PushKit', '#if canImport(StoreKit)', 'x.execute-api.us-east-1', '651325958035',
    'cloudSession', 'https://talktobridge.com', 'com.talktobridge.bridge.pro.monthly', 'Smitherman', 'PowerSpec',
    'powerspec.taila78b6c.ts.net', 'pc.tail0f9e8d.ts.net', 'https://abc@o1.ingest.us.sentry.io/2',
    'ghs_' + 'a'.repeat(36), 'github_pat_' + 'a'.repeat(40), 'sk-ant-' + 'a'.repeat(40), 'AKIAABCDEFGHIJKLMNOP',
    '123456789:AA' + 'a'.repeat(33), '-----BEGIN RSA PRIVATE KEY-----', 'C:\\Users\\steph\\Projects'];
  for (const h of hits) assert.ok(FORBIDDEN.some((re) => re.test(h)), h);
  const fine = ['https://<pc>.<tailnet>.ts.net', 'https://my-pc.tail1234.ts.net', 'ghs_x', 'github_pat_x',
    'com.talktobridge.bridge', 'C:\\Users\\you\\Projects'];
  for (const f of fine) assert.ok(!FORBIDDEN.some((re) => re.test(f)), f);
});

test('refuses a destination that overlaps the repo', () => {
  const s = scratch({ 'relay.mjs': 'ok\n' });
  try {
    for (const d of [s.root, join(s.root, '..'), join(s.root, 'agent'), join(s.root, 'agent', 'deeper')]) {
      assert.throws(() => exportPublic(d, { root: s.root }), /overlaps this repo/, d);
    }
  } finally { s.done(); }
});

test('refuses a folder with files and no marker, and leaves it alone', () => {
  const s = scratch({ 'relay.mjs': 'ok\n' });
  try {
    mkdirSync(s.dest);
    writeFileSync(join(s.dest, 'keep.txt'), 'mine');
    assert.throws(() => exportPublic(s.dest, { root: s.root }), /isn't empty/);
    assert.equal(readFileSync(join(s.dest, 'keep.txt'), 'utf8'), 'mine');
  } finally { s.done(); }
});

test('refuses a destination whose history holds this repo', () => {
  const s = scratch({ 'relay.mjs': 'ok\n' });
  try {
    execFileSync('git', ['clone', '-q', s.root, s.dest], { stdio: 'pipe' });
    rmSync(join(s.dest, 'relay.mjs'));
    assert.throws(() => exportPublic(s.dest, { root: s.root }), /fresh git init/);
  } finally { s.done(); }
});

test('a re-export replaces stale files and keeps .git', () => {
  const s = scratch({ 'relay.mjs': 'ok\n' });
  try {
    mkdirSync(s.dest);
    execFileSync('git', ['init', '-q'], { cwd: s.dest });
    exportPublic(s.dest, { root: s.root });
    writeFileSync(join(s.dest, 'stale.txt'), 'old');
    exportPublic(s.dest, { root: s.root });
    assert.equal(existsSync(join(s.dest, 'stale.txt')), false);
    assert.ok(existsSync(join(s.dest, '.git', 'HEAD')));
    assert.equal(readFileSync(join(s.dest, 'relay.mjs'), 'utf8'), 'ok\n');
  } finally { s.done(); }
});

test('a failed check leaves an earlier export untouched', () => {
  const s = scratch({ 'relay.mjs': 'ok\n' });
  try {
    exportPublic(s.dest, { root: s.root });
    s.write({ 'relay.mjs': 'const host = "api.talktobridge.com";\n' });
    s.g('commit', '-qam', 'leak');
    assert.throws(() => exportPublic(s.dest, { root: s.root }), /relay\.mjs/);
    assert.equal(readFileSync(join(s.dest, 'relay.mjs'), 'utf8'), 'ok\n');
  } finally { s.done(); }
});
