// Pushing an agent's work, so the agent never holds a GitHub token. The agent commits on a branch and
// writes a request file; after its turn the relay reads the request, mints a token for that agent's repo
// (github-app.mjs), and two throwaway containers copy the branch out of the repo and push it (see
// FETCH_SCRIPT). The relay then opens the pull request itself.
// Dependencies are passed in, so tests run it without Docker or GitHub.

// Inside .git, so the request is never committed.
export const REQUEST_FILE = '/work/.git/bridge/publish.json';
export const MAX_REQUEST = 64 * 1024;

// A branch name git and GitHub both accept, that can't be read as an option or a refspec.
export function validBranch(b) {
  return typeof b === 'string' && b.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)
    && !/\.\.|\/\/|\/\.|[/.]$|\.lock$/.test(b);
}

// { branch, title, body } from the agent's request, or { error } read aloud as the reason nothing was pushed.
export function parseRequest(text) {
  let r;
  try { r = JSON.parse(text); } catch { return { error: 'its push request was not valid JSON' }; }
  if (!r || typeof r !== 'object') return { error: 'its push request was not valid JSON' };
  if (!validBranch(r.branch)) return { error: 'its push request did not name a valid branch' };
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 200) : `Changes on ${r.branch}`;
  const body = typeof r.body === 'string' ? r.body.slice(0, 20_000) : '';
  return { branch: r.branch, title, body };
}

// Two fixed scripts, run in two throwaway containers whose only link is a git bundle piped from one to the
// other. The first gets the agent's repo read-only at /src and no token: it copies the branch into a fresh
// repo through git's own transport (so the agent's hooks never run; its config is parsed, which git treats
// as safe for a fetch, and a test checks the known ways to run code) and writes it out as a bundle. The
// second gets the token and nothing of the agent's but that bundle, which is plain data: it unpacks it
// into a fresh repo and pushes. So whatever the agent's repo could make the first one do, the token is
// in neither its environment, its files nor its memory.
export const FETCH_SCRIPT = [
  'set -e',
  'git init -q --bare /tmp/r',
  'cd /tmp/r',
  // Its only setting lets git read /src, which belongs to another user (-c doesn't reach upload-pack).
  `git config -f /tmp/r/fetch.gitconfig safe.directory '*'`,
  `GIT_CONFIG_GLOBAL=/tmp/r/fetch.gitconfig GIT_CONFIG_NOSYSTEM=1 git fetch -q --no-tags file:///src "+refs/heads/$BRANCH:refs/heads/$BRANCH" </dev/null`,
  'git bundle create -q - "refs/heads/$BRANCH"',
].join('\n');
export const PUSH_SCRIPT = [
  'set -e',
  // Only the push itself inherits the token (the shell's own copy is unavoidable).
  'T="$GH_TOKEN"; unset GH_TOKEN',
  'cat > /tmp/branch.bundle',
  'git init -q --bare /tmp/p',
  'cd /tmp/p',
  'git fetch -q /tmp/branch.bundle "+refs/heads/$BRANCH:refs/heads/$BRANCH"',
  `GH_TOKEN="$T" git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' push -q "https://github.com/$REPO.git" "refs/heads/$BRANCH:refs/heads/$BRANCH"`,
].join('\n');

/**
 * deps.readRequest(a) -> the request file's text (and deletes it), or null when the agent made none
 * deps.agentGitHub -> { credentials(a), release(creds) } from github-app.mjs
 * deps.push({ a, branch, repo, token }) -> runs FETCH_SCRIPT and PUSH_SCRIPT in their containers; throws on failure
 * deps.fetch, deps.log
 */
export function makePublisher({ readRequest, agentGitHub, push, fetch = globalThis.fetch, log = () => {} }) {
  async function call(method, url, token, body) {
    const res = await fetch(`https://api.github.com${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'claude-voice-relay',
        Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${url}: ${res.status} ${data.message || ''}`.trim());
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // The open pull request for `branch`, opened if there's none yet: { number, opened }.
  async function pullRequest(token, info, req) {
    try {
      const pr = await call('POST', `/repos/${info.full_name}/pulls`, token,
        { title: req.title, body: req.body, head: req.branch, base: info.default_branch });
      return { number: pr.number, opened: true };
    } catch (err) {
      if (err.status !== 422 || !/already exists/i.test(JSON.stringify(err.data))) throw err;
      const head = encodeURIComponent(`${info.owner.login}:${req.branch}`);
      const [pr] = await call('GET', `/repos/${info.full_name}/pulls?head=${head}&state=open`, token);
      if (!pr) throw err;
      return { number: pr.number, opened: false };
    }
  }

  // What to tell the user about the agent's push request, or null when it made none.
  async function publish(a) {
    let text;
    try { text = await readRequest(a); }
    catch (err) { log(`${a.name}: couldn't read its push request: ${err.message}`); return null; }
    if (text == null) return null;
    if (text.length > MAX_REQUEST) return "I didn't push the work, because its push request was too long.";
    const req = parseRequest(text);
    if (req.error) { log(`${a.name}: ${req.error}`); return `I didn't push the work, because ${req.error}.`; }

    let creds;
    try { creds = await agentGitHub.credentials(a); }
    catch (err) { log(`${a.name}: no GitHub token: ${err.message}`); }
    if (!creds) return "I couldn't push the work, because there's no GitHub access for this repo. It's committed on its branch.";
    let pushed = false;
    try {
      const e = encodeURIComponent;
      const info = await call('GET', `/repos/${e(creds.owner)}/${e(creds.repo)}`, creds.token);
      if (req.branch === info.default_branch) {
        return `I didn't push, because the work is on ${info.default_branch} itself. Ask for it on a new branch.`;
      }
      await push({ a, branch: req.branch, repo: info.full_name, token: creds.token });
      pushed = true;
      log(`${a.name}: pushed ${req.branch} to ${info.full_name}.`);
      const pr = await pullRequest(creds.token, info, req);
      log(`${a.name}: pull request #${pr.number} on ${info.full_name}${pr.opened ? ' opened' : ' updated'}.`);
      return pr.opened ? `I pushed the work and opened pull request ${pr.number}.` : `I pushed the work to pull request ${pr.number}.`;
    } catch (err) {
      log(`${a.name}: publishing ${req.branch} failed: ${err.message}`);
      return pushed ? "I pushed the work, but couldn't open the pull request. The log on your PC has the details."
        : "The push failed, so the work is only committed. The log on your PC has the details.";
    } finally {
      // Not awaited, so a slow GitHub doesn't keep the agent busy; revoke logs its own failures.
      agentGitHub.release(creds).catch(() => {});
    }
  }

  return { publish };
}
