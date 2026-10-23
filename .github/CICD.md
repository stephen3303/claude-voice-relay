# CI/CD and the Claude subagents

## The pipeline

| Stage | Workflow | When | Needs |
|---|---|---|---|
| Checks | `ci.yml` | every PR, every push to main | nothing |
| iOS build | `glasses-ios.yml` | push touching `glasses/ios/**` | nothing |
| Claude review | `claude-review.yml` | PR opened, updated, reopened or marked ready (drafts skipped) | a Claude credential (below) |
| Ask Claude | `claude.yml` | a comment containing `@claude` from you or a collaborator | a Claude credential |
| Deploy cloud | `cloud-deploy.yml` | merge to main touching `cloud/**` or `site/**` | `AWS_DEPLOY_ROLE_ARN` variable (set) and the `aws-deploy` environment (`cloud/setup/update-deploy-role.ps1`) |
| Website | `pages.yml` | merge to main touching `site/**` | nothing |
| App Store | `glasses-appstore.yml`, `glasses-subscriptions.yml` | by hand | the `ASC_*` and `APPLE_TEAM_ID` secrets, in the main-only `appstore` environment (`glasses/setup-appstore-secrets.ps1`) |
| Crash reports | `glasses-release.yml`, `glasses-appstore.yml` (not the per-push `glasses-ios.yml` check, whose builds have no symbols) | release builds | optional: `SENTRY_DSN` and `SENTRY_AUTH_TOKEN` secrets, `SENTRY_ORG` and `SENTRY_PROJECT` variables (`glasses/setup-sentry-secrets.ps1`), and the Sentry setting "Prevent Storing of IP Addresses" on, which `site/privacy.html` relies on; without them the app reports nothing |
| Cloud error reports | `cloud-deploy.yml` | deploy | optional: `SENTRY_DSN_CLOUD` secret (the `bridge-cloud` Sentry project's DSN), passed to the Lambdas as `SENTRY_DSN`, set with `gh secret set SENTRY_DSN_CLOUD --env aws-deploy -R stephen3303/claude-voice-relay -b <DSN>` (an `aws-deploy` environment secret, so only main's deploy can read it); without it Bridge Cloud reports nothing |

Main is production: there is no staging stack, so `ci.yml` and the Claude review are the gate before a merge.

## The subagents (`.claude/agents`)

Claude Code loads these in any session in this repo (your PC, the cloud, and the GitHub workflows above).

| Agent | Looks at | Runs in review when |
|---|---|---|
| `code-reviewer` | correctness in relay.mjs, cloud/api, cloud/infra, relay/cloud/app protocol drift | always |
| `test-engineer` | runs syntax checks, `node --test`, CDK synth; finds untested behaviour, writes tests on request | always |
| `security-reviewer` | secrets in a public repo, Sign in with Apple and sessions, relay auth, IAM, workflow permissions | anything outside `glasses/ios` and `site` changed |
| `ios-reviewer` | Swift compile errors by reading, App Store vs personal flavour leaks, App Review risks | `glasses/` changed |
| `release-manager` | CDK resource replacement, backward compatibility with shipped apps, rollback, release notes | `cloud/`, `site/` or workflows changed |

Use one by hand: in Claude Code, "use the security-reviewer on my last commit", or on GitHub,
"@claude have the ios-reviewer check this PR".

## How the Claude workflows stay safe on a public repo

- **Review (`claude-review.yml`):** Claude runs in a checkout of main, so `CLAUDE.md`, `.claude/` (agents,
  settings, hooks) and `.mcp.json` always come from main. The PR is checked out into `./pr` as data with
  its own Claude config deleted, and Claude's tools can read it but not run it; `ci.yml` runs the tests in
  a job with no secrets. Fork PRs are skipped.
- **`@claude` (`claude.yml`):** runs code, so it only acts on comments from you or collaborators, on
  issues they opened and same-repo PRs, and it only reads your comments in the thread, since anyone can
  comment on a public repo (not the Claude review's, which are written from the PR's content). To add a collaborator, add their username to
  `include_comments_by_actor`. Pushes it makes use the workflow's token, so they don't start CI
  by themselves; push again or rerun CI.
- **No `id-token: write`** in either, so neither can mint a GitHub OIDC token at all. Separately, the
  AWS `BridgeGitHubDeploy` role only trusts jobs in the `aws-deploy` environment, which only
  `cloud-deploy.yml` uses and which only accepts main.
- Actions in these jobs are pinned to commit SHAs.

A workflow edited in a same-repo branch runs with the secrets on that branch's PR. That's GitHub's model:
anyone who can push a branch can read the secrets, so only give push access to people you'd give them to.

## What you need to add (once)

The Claude workflows skip cleanly until one of these repository secrets exists
(Settings > Secrets and variables > Actions > New repository secret):

- **`CLAUDE_CODE_OAUTH_TOKEN`** (uses your Claude subscription): on your PC run `claude setup-token`, copy the
  token it prints, and paste it as the secret value. Or
- **`ANTHROPIC_API_KEY`** (pay per use): create a key at console.anthropic.com > API keys.

Easiest of all: run `claude` in this repo on your PC and type `/install-github-app`; it adds the secret for you.
The Claude GitHub App is already installed on this repo.

Cost: a review runs on every push to a ready PR (a newer push cancels the running one). Keep a PR in
draft while you iterate if you want fewer reviews.

## Not set up on purpose

- **Preview deploys / `cdk diff` on PRs:** the `BridgeGitHubDeploy` role only trusts main, which is the right
  default. To get a diff on PRs, add a second read-only role trusting `pull_request` and a step running
  `npx cdk diff`; ask Claude for it when you want it.
- **Staging stack:** worth adding before Bridge Cloud has paying users.
