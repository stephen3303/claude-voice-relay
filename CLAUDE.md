# Bridge / claude-voice-relay

Talk to Claude Code agents hands-free: "Hey Meta, start Bridge" on Ray-Ban Meta glasses (or Siri,
Shortcuts, Telegram), hear the answers out loud. Owner: Stephen (Windows 11 PC "powerspec", iPhone,
no Mac). The repo is public: never commit secrets, tokens, `.env`, `state.json` or logs.

## Layout
- `relay.mjs` — the PC relay (Node, no deps). Telegram bot, Docker agents (one container per repo,
  headless `claude -p`), and the voice endpoint on :47879 behind `tailscale serve`
  (https://powerspec.taila78b6c.ts.net). Voice routes: `/voice/confirm` (read-back), `/voice/send`
  (no read-back), `/voice/inbox` (long-poll), `/voice/photo`, `/voice/tts`.
- `glasses/ios` — the Bridge iPhone app (SwiftUI, XcodeGen `project.yml`, Meta Wearables DAT 1.0.1).
  Two flavours from one source: personal (sideloaded, everything unlocked, experimental Meta camera
  API) and App Store (`APP_STORE` compilation condition: StoreKit Bridge Pro, Sign in with Apple,
  Bridge Cloud, agent calls via PushKit + CallKit in `Push.swift`, `AppStore.entitlements`). Screens: `HomeView` (main), `SettingsView`, `HelpView`,
  `HistoryView`, `WelcomeView` (App Store first launch).
- `cloud/` — Bridge Cloud on AWS (account 651325958035, us-east-1), CDK in `cloud/infra`, Lambda code
  in `cloud/api`. `DESIGN.md` is the architecture and build order. Stacks: `BridgeApi` (HTTP API,
  Lambda, DynamoDB, KMS session key, Sign in with Apple, APNs push in `cloud/api/push.mjs` with the key
  in Secrets Manager `bridge/apns`, set by `cloud/setup/setup-apns.ps1`) and `BridgeWeb` (S3 + CloudFront for
  talktobridge.com, DNS at Cloudflare).
- `site/` — the website (privacy, terms, support), on GitHub Pages now; talktobridge.com later.
- `hooks/`, `agent/` — Claude Code notification hook; the agent container image.

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
- App Store: Stephen has enrolled. Still needed: the App Store Connect API key, the app record, and
  the Meta app ID and client token, stored with `glasses/setup-appstore-secrets.ps1`. Then run the
  subscriptions workflow, then the App Store upload. Before that upload, `site/privacy.html` must cover
  Bridge Cloud, the Bridge account (Sign in with Apple), push, spoken replies via Amazon Polly and the
  Bridge Pro purchase record the app sends to Bridge Cloud (`/api/pro`); today it
  covers self-hosting only. Also set App Store Server Notifications (Version 2, production and sandbox URLs)
  to the `AppStoreNotificationsUrl` output, so renewals and refunds reach Bridge Pro's cloud check (`cloud/api/storekit.mjs`).
- Cloud agents (Fargate + GitHub App) aren't built yet; the cloud API answers tasks honestly.
