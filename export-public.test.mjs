import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAppStore, publicReadme, publicProject, included, exportPublic } from './export-public.mjs';

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

test('refuses to export into this repo or a folder above it', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-src-'));
  try {
    assert.throws(() => exportPublic(root, { root }), /Refusing/);
    assert.throws(() => exportPublic(join(root, '..'), { root }), /Refusing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean export replaces stale files and keeps .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-src-'));
  const dest = mkdtempSync(join(tmpdir(), 'bridge-dest-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'relay.mjs'), 'ok\n');
    execFileSync('git', ['add', 'relay.mjs'], { cwd: root });
    mkdirSync(join(dest, '.git'));
    writeFileSync(join(dest, '.git', 'HEAD'), 'ref');
    writeFileSync(join(dest, 'stale.txt'), 'old');
    exportPublic(dest, { root });
    assert.equal(existsSync(join(dest, 'stale.txt')), false);
    assert.equal(readFileSync(join(dest, '.git', 'HEAD'), 'utf8'), 'ref');
    assert.equal(readFileSync(join(dest, 'relay.mjs'), 'utf8'), 'ok\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('a failed export leaves the destination untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-src-'));
  const dest = mkdtempSync(join(tmpdir(), 'bridge-dest-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'relay.mjs'), 'const host = "api.talktobridge.com";\n');
    execFileSync('git', ['add', 'relay.mjs'], { cwd: root });
    writeFileSync(join(dest, 'keep.txt'), 'mine');
    assert.throws(() => exportPublic(dest, { root }), /relay\.mjs/);
    assert.equal(readFileSync(join(dest, 'keep.txt'), 'utf8'), 'mine');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
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
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
