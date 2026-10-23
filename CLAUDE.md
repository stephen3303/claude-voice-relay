# Bridge / claude-voice-relay

Talk to Claude Code agents hands-free: "Hey Meta, start Bridge" on Ray-Ban Meta glasses (or Siri,
Shortcuts), hear the answers out loud. Owner: Stephen (Windows 11 PC "powerspec", iPhone,
no Mac). The repo is public: never commit secrets, tokens, `.env`, `state.json`, `outbox.json`, `*.pem` or logs.

## Layout
- `relay.mjs` — the PC relay (Node, no deps). Docker agents (one container per repo,
  headless `claude -p`), and the voice endpoint on :47879 behind `tailscale serve`
  (https://powerspec.taila78b6c.ts.net). `AGENT_MODE=cloud` runs tasks as claude.ai cloud sessions instead
  (`cloud-agents.mjs`, host `claude -p --cloud`), so they show in the Claude app. Voice routes: `/voice/confirm` (read-back), `/voice/send`
  (no read-back), `/voice/inbox` (long-poll), `/voice/photo`, `/voice/tts`.
- `glasses/ios` — the Bridge iPhone app (SwiftUI, XcodeGen, Meta Wearables DAT 1.0.1).
  Two flavours from one source: personal (sideloaded, `project.yml` = `base.yml` + the Meta toolkit, everything unlocked,
  experimental "Hey Meta" voice invocation) and App Store (`appstore.yml` = `base.yml` with no glasses, since Meta doesn't
  allow toolkit apps on the App Store yet; glasses code behind `#if !APP_STORE`; `APP_STORE` compilation condition: StoreKit Bridge Pro, Sign in with Apple,
  Bridge Cloud, agent calls via PushKit + CallKit in `Push.swift`, `AppStore.entitlements`). Screens: `HomeView` (main), `SettingsView`, `HelpView`,
  `HistoryView`, `WelcomeView` (App Store first launch). Crash and error reports go to Sentry
  (`ErrorReporting.swift`) when CI builds with the `SENTRY_DSN` secret (`glasses/setup-sentry-secrets.ps1`);
  never send speech, photos, replies, the PC address or the token. The relay and Bridge Cloud report errors with
  `sentry.mjs` (no SDK; `cloud/api/sentry.mjs` is an identical copy, checked by its test): Sentry projects
  `bridge-relay` (`SENTRY_DSN` in `.env`) and `bridge-cloud` (repo secret `SENTRY_DSN_CLOUD`, set on the Lambdas at deploy).
- `cloud/` — Bridge Cloud on AWS (account 651325958035, us-east-1), CDK in `cloud/infra`, Lambda code
  in `cloud/api`. `DESIGN.md` is the architecture and build order. Stacks: `BridgeApi` (HTTP API,
  Lambda, DynamoDB, KMS session key, Sign in with Apple, APNs push in `cloud/api/push.mjs` with the key
  in Secrets Manager `bridge/apns`, set by `cloud/setup/setup-apns.ps1`) and `BridgeWeb` (S3 + CloudFront for
  talktobridge.com, DNS at Cloudflare). `BridgeApi` also runs Stephen's own agents in place of the PC relay: the owner token
  (`cloud/api/owner.mjs`), agent state (`cloud/api/agents.mjs`) and the Fargate runner (`cloud/runner`, which reuses
  `cloud-agents.mjs`), set up by `cloud/setup/setup-owner.ps1` (DESIGN.md, "The owner's agents"). The orchestrator (`cloud/api/orchestrator.mjs`,
  status files in `cloud/api/status.mjs`) answers "status on all programs", "what needs me" and the briefings from each
  project's `STATUS#` item (DESIGN.md, "The orchestrator").
- `site/` — the website (home, privacy, terms, support) for the App Store product only, live at https://talktobridge.com
  on GitHub Pages (Cloudflare DNS only); CloudFront (`BridgeWeb`) later. The app and listing link to talktobridge.com.
- `hooks/`, `agent/` — Claude Code notification hook; the agent container image.
- `github-app.mjs`, `publish.mjs` — agents never hold a GitHub token: they commit and write a push request, and after
  the turn the relay mints a GitHub App token (`setup-github-app.mjs` creates the App) for that agent's repo only, and
  only if its default branch has the README's rulesets. One throwaway container copies the branch out as a bundle with no
  token, a second gets only the bundle and the token and pushes, the relay opens the PR, and the token is revoked. The App key and each folder's pinned
  repo (`github-pins.json`) live in `%USERPROFILE%\.bridge`. The relay refuses to mount its own folder, `.bridge` or
  anything above them, so agents work on this repo from a second clone.

- `export-public.mjs` — writes the public, self-hosted copy (repo `bridge-relay`): the relay, agent image, hooks and
  the sideload app with every `#if APP_STORE` branch removed, plus the files in `public/` (README tail, LICENSE,
  its CI), read from the commit, not the working tree. It fails if anything paid or secret is left, or if a file under
  `glasses/ios` isn't listed in its `INCLUDE` or `EXCLUDE` (add new app files there). This repo is the source of truth; keep
  App Store-only Swift inside `#if APP_STORE` (CI builds the exported app as the `public` flavour). bridge-relay must start
  from a fresh `git init`, never a clone of this repo, or its history would go public; the export refuses one.

## Build, test, run
- Relay: `start.ps1` runs it and restarts it if it exits, so to reload after editing `relay.mjs`,
  stop the `node ... relay.mjs` process and it comes back in ~10 s. Check `logs/relay.log`.
  Syntax check: `node --check relay.mjs`.
- Tests: `node --test` from the repo root runs every `*.test.mjs` (no AWS needed). Synth: `cd cloud/infra && npx cdk synth -q`.
- The iOS app can't be built here (no Mac). Push and let CI build it; read failures with
  `gh run view <id> --log-failed`.

## CI (GitHub Actions)
See `.github/CICD.md` for the pipeline, the subagents in `.claude/agents`, and the secrets they need.
- `ci.yml` — every PR and main: syntax check, `node --test`, CDK synth.
- `claude-review.yml` — Claude reviews ready PRs with the subagents; `claude.yml` answers `@claude` comments.
- `glasses-ios.yml` — builds both flavours on push to `glasses/**`; the personal IPA is the artifact.
- `glasses-screenshots.yml` — simulator screenshots (home and settings, light and dark), manual.
- `glasses-subscriptions.yml` — creates the Bridge Pro subscriptions in App Store Connect, manual.
- `glasses-appstore.yml` — signed archive and upload to App Store Connect, manual.
- `cloud-deploy.yml` — on push to `cloud/**` or `site/**`: tests, then deploys BridgeApi, then
  BridgeWeb (allowed to fail while AWS has CloudFront blocked). AWS access is the
  `BridgeGitHubDeploy` role via GitHub OIDC; there are no stored AWS keys.
- `pages.yml` — the website on GitHub Pages.
- `impactor-check.yml` — builds Impactor (the sideloader) and checks Apple accepts its sign-in; manual, and on edits to the workflow.

## Working with Stephen
- Be direct and say why. Keep going until he says stop. Keep replies short; if he's on voice,
  assume he's driving.
- Ask questions as multiple-choice forms, all in one message.
- Commit and push after each fix or feature. Write the commit message to a file and use
  `git commit -F` (PowerShell mangles here-strings). End commits with the Co-Authored-By line.
- Things only he can do (Apple, Meta, AWS Support, Cloudflare, running installers): give exact
  steps, or a script he runs that prompts for values, so secrets never pass through chat.

## Current blockers (update as they clear)
- AWS account verification: blocks CloudFront (talktobridge.com) and Bedrock (photo answers in the
  cloud). Once it clears, rerun Cloud deploy and give Stephen the Cloudflare CNAMEs (DNS only) for
  talktobridge.com and www, pointing at the `CloudFrontTarget` output.
- App Store: Stephen has enrolled. Still needed: the App Store Connect API key and the app record, stored with
  `glasses/setup-appstore-secrets.ps1`. The App Store build has no glasses until Meta allows toolkit apps there (`glasses/APP_STORE.md`). Then run the
  subscriptions workflow, then the App Store upload. The site describes the App Store product only (Bridge
  Cloud, Pro); `site/privacy.html` covers it, but still names "the developer of Bridge" and
  support@talktobridge.com, which needs a real legal name and a working mailbox before upload. Also set App Store Server Notifications (Version 2, production and sandbox URLs)
  to the `AppStoreNotificationsUrl` output, so renewals and refunds reach Bridge Pro's cloud check (`cloud/api/storekit.mjs`).
- Cloud agents (Fargate + GitHub App) aren't built yet; the cloud API answers tasks honestly.
