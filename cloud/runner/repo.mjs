// The folder `claude -p --cloud` runs in. The CLI starts the cloud session on the folder's GitHub remote at its
// current branch, so the runner needs a git folder whose current branch tracks origin = the project's repo.
// A shallow clone of that one branch is the real thing; a private repo can't be cloned without a GitHub token
// (which the runner doesn't hold), so it falls back to an empty repo with the same remote and branch.
// The CLI loads user settings only (cloudArgs: --setting-sources user), so nothing in the clone runs here.
import fs from 'node:fs';

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/** git(args, { cwd }) runs git; repo is "owner/name"; branch is optional (the repo's default). */
export async function prepareRepo({ git, repo, branch, dir }) {
  if (!REPO.test(repo || '')) throw new Error(`${repo} isn't a GitHub repo name (owner/name).`);
  if (branch && (!BRANCH.test(branch) || branch.startsWith('-') || branch.includes('..'))) throw new Error(`${branch} isn't a branch name.`);
  const url = `https://github.com/${repo}.git`;
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    await git(['clone', '--depth', '1', '--single-branch', ...(branch ? ['--branch', branch] : []), '--', url, dir],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return 'clone';
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const b = branch || 'main';
    await git(['init', '-q', '-b', b], { cwd: dir });
    await git(['remote', 'add', 'origin', url], { cwd: dir });
    await git(['config', `branch.${b}.remote`, 'origin'], { cwd: dir });
    await git(['config', `branch.${b}.merge`, `refs/heads/${b}`], { cwd: dir });
    return 'empty';
  }
}
