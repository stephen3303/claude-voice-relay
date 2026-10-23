import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRepo } from './repo.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-repo-')), 'work');

test('clones one branch shallowly', async () => {
  const calls = [];
  const how = await prepareRepo({ git: async (args) => calls.push(args), repo: 'stephen3303/trading-bot', branch: 'main', dir: tmp() });
  assert.equal(how, 'clone');
  assert.deepEqual(calls[0].slice(0, 6), ['clone', '--depth', '1', '--single-branch', '--branch', 'main']);
  assert.equal(calls[0].at(-2), 'https://github.com/stephen3303/trading-bot.git');
});

test('a repo it cannot clone becomes an empty repo tracking the same remote and branch', async () => {
  const calls = [];
  const dir = tmp();
  const git = async (args) => { calls.push(args); if (args[0] === 'clone') throw new Error('auth required'); };
  assert.equal(await prepareRepo({ git, repo: 'stephen3303/private', branch: '', dir }), 'empty');
  assert.deepEqual(calls.slice(1), [
    ['init', '-q', '-b', 'main'],
    ['remote', 'add', 'origin', 'https://github.com/stephen3303/private.git'],
    ['config', 'branch.main.remote', 'origin'],
    ['config', 'branch.main.merge', 'refs/heads/main'],
  ]);
  assert.ok(fs.existsSync(dir));
});

test('refuses names that could become git options or other URLs', async () => {
  const git = async () => assert.fail('git ran');
  for (const repo of ['--upload-pack=x/y', 'a/b/c', 'https://evil.example/x', '']) {
    await assert.rejects(prepareRepo({ git, repo, branch: 'main', dir: tmp() }), /isn't a GitHub repo name/);
  }
  await assert.rejects(prepareRepo({ git, repo: 'a/b', branch: '--orphan', dir: tmp() }), /isn't a branch name/);
  await assert.rejects(prepareRepo({ git, repo: 'a/b', branch: 'x/../y', dir: tmp() }), /isn't a branch name/);
});
