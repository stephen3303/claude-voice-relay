# CI/CD and the Claude subagents

## The pipeline

| Stage | Workflow | When | Needs |
|---|---|---|---|
| Checks | `ci.yml` | every PR, every push to main | nothing |
| iOS build | `glasses-ios.yml` | push touching `glasses/ios/**` | nothing |
| Claude review | `claude-review.yml` | PR opened, updated, reopened or marked ready (drafts skipped) | a Claude credential (below) |
| Ask Claude | `claude.yml` | a comment containing `@claude` from you or a collaborator | a Claude credential |
| Deploy cloud | `cloud-deploy.yml` | merge to main touching `cloud/**` or `site/**` | `AWS_DEPLOY_ROLE_ARN` variable (already set) |
| Website | `pages.yml` | merge to main touching `site/**` | nothing |
| App Store | `glasses-appstore.yml`, `glasses-subscriptions.yml` | by hand | the `ASC_*`, `APPLE_TEAM_ID`, `META_*` secrets |

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
