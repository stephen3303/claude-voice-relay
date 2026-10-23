# Bridge Cloud: the hosted service behind Bridge Pro

Free Bridge keeps talking to the self-hosted relay (your PC, Docker, Tailscale). **Bridge Pro**
talks to Bridge Cloud on AWS instead, so a subscriber needs only the iPhone app and a GitHub account.

## What the app talks to

The cloud speaks the same protocol as the relay, so the app only switches its base URL and auth:

| Relay (free) | Cloud (Pro) | |
|---|---|---|
| `POST /voice/confirm` | same | read-back step; "send it" starts a task |
| `GET /voice/inbox` | same | agent messages, long-poll |
| `POST /voice/photo` | same | quick answer, or "send this to <project>" |
| `POST /voice/tts` (OpenAI, with a key) | same (Amazon Polly, Bridge Pro only; 60k characters per account and 1M in total per day) | MP3 of a line; any non-200 means the phone voice |
| bearer `VOICE_TOKEN` | Bridge session token (Sign in with Apple) | per user |
| projects = folders on the PC | projects = GitHub repos the user installed the Bridge GitHub App on, plus a Files workspace | |

## Architecture (all in one AWS region, us-east-1)

```
iPhone app ──HTTPS──> CloudFront (bridge domain)
                        ├── /            S3: website (landing, privacy, terms, support, account)
                        └── /api/*       API Gateway (HTTP API, Lambda authorizer on Bridge sessions) ──> Lambda (Node 22)
                                              │  DynamoDB: users, plans, usage, projects, tasks, inbox
                                              │  S3: photos (1-day lifecycle), Files workspaces
                                              ├──> Bedrock (Claude Haiku 5.5): read-back parsing, quick photo answers
                                              └──> ECS Fargate RunTask: one container per agent task
                                                     Claude Agent SDK on Bedrock (Sonnet 5.5), or the
                                                     user's own Anthropic key (BYO plan)
                                                     clone repo via GitHub App token → branch → PR
                                                     posts SPOKEN line to the inbox via the API
Accounts: Sign in with Apple only (App Store 4.8). The app sends Apple's identity token to /api/auth/apple, which answers with a 30-day session signed by a KMS key; a Lambda authorizer checks it. No Cognito.
App Store Server Notifications v2 ──> Lambda: subscription state per user (cloud/api/storekit.mjs)
GitHub App webhooks ──> Lambda: which repos each user installed it on
```

## Bridge Pro, checked in the cloud

The app sends StoreKit 2's signed transaction to `POST /api/pro` after signing in and whenever its entitlements change.
`cloud/api/storekit.mjs` checks Apple's signature (x5c chain to Apple Root CA - G3, pinned by fingerprint, plus the
App Store marker extensions), the bundle ID and the Pro product, then stores until when the account is Pro. One
subscription (originalTransactionId) belongs to one Bridge account, so a transaction copied to another account is refused.
App Store Server Notifications v2 (`POST /api/appstore/notifications`) extend Pro on renewal and end it on a refund or
revocation; a refunded transaction ID is kept, so the phone's old copy can't bring Pro back. No App Store Connect key is
needed for any of this. The natural voice (`/api/voice/tts`) answers 402 without Pro, and the app speaks with the phone;
photos (`/api/voice/photo`, Bedrock) answer that they need Pro. Sandbox purchases count too, because App Review buys
in the sandbox against this backend, for every update, not just the first; that also gives invited TestFlight
testers Pro for free. So sandbox Pro stays on for good but gets small allowances (`voice.mjs`): 5,000 characters of
natural voice per account a day (100,000 across all sandbox accounts) and 5 photo answers per account a day (50 in
all), where paid Pro gets 60,000 characters and no photo cap. Missed refund notifications aren't caught up yet: that needs
the App Store Server API and an App Store Connect key. A reversed refund (`REFUND_REVERSED`) restores Pro. Keep the
Billing Grace Period off in App Store Connect: Pro here lasts until `expiresDate`, and a grace period would keep Pro on
the phone while the cloud has ended it. Turning it on needs `gracePeriodExpiresDate` from `signedRenewalInfo` first.

## Agents start the conversation (push)

When an agent posts to the inbox, `deliver` (cloud/api/index.mjs) also pushes it over APNs (cloud/api/push.mjs) to each of
the user's phones, unless the app polled the inbox in the last 45 seconds (a conversation is already open and will read it):

- **Headphones, glasses or a car connected, and "Agents can call me" on:** a VoIP push. The app reports it to CallKit as an
  incoming call from "Bridge: <project>". Answering it (lock screen, or a tap on the glasses or AirPods) starts a
  conversation whose first line is the agent's message. CallKit is the only way iOS lets a backgrounded app open the
  microphone, which is why this is a call and not a notification.
- **Otherwise:** a time-sensitive notification. Tapping it, or its Talk button, opens Bridge and starts the conversation.
  If Bridge is open and a headset is connected, the conversation starts without the banner.

The app registers both tokens with `POST /api/push/register` and re-sends whenever the audio route changes, so the cloud
knows which to use. iOS requires every VoIP push to become a reported call, so when the phone's state was stale (no
headset after all, or already talking) the app reports the call and ends it at once, and shows the notification instead.
The APNs key (.p8) is in Secrets Manager as `bridge/apns` (cloud/setup/setup-apns.ps1); without it messages still reach
the inbox and nothing rings.

Choices and why:
- **Fargate tasks, not long-running servers:** an agent task runs for minutes, then the container exits,
  so idle cost is zero. Public subnets with a public IP and no NAT gateway: a NAT costs about $32/month idle.
- **Branch + pull request, never the default branch:** nothing reaches a customer's main without their merge.
- **Bedrock, not customers' Claude subscriptions:** consumer plans can't power a third-party
  service. The included plan pays Bedrock; the BYO plan uses the customer's Anthropic API key,
  stored encrypted in Secrets Manager and only read inside their task.
- **Same voice protocol as the relay:** the app logic (read-back, inbox, photos) is unchanged.

## Plans (App Store auto-renewing subscriptions, one group)

| Plan | Price (proposal) | Claude usage | Includes |
|---|---|---|---|
| Free | $0 | user's own PC (self-hosted relay) | voice, read-back, inbox |
| Pro Connect (BYO key) | $4.99/mo or $49.99/yr | customer's Anthropic API key | hosted agents, photos, Shortcuts, Files |
| Pro | $19.99/mo or $179.99/yr (placeholder, not yet confirmed) | included: 30 agent tasks/month, unlimited quick photo answers (fair use) | same |

Cost per included user, worst case: about 30 tasks × ~$1.50 (Sonnet 5.5 with prompt caching) ≈ $45. So the
allowance is metered in DynamoDB and enforced before a task starts. The app says "You've used 25 of 30 tasks this
month." Extra tasks could be sold as consumable task packs later.

## "Work with their own files"

Two ways, for customers whose work isn't on GitHub:
1. **Files workspace (in the cloud):** upload files from the iPhone Files app or the website. They are kept per
   user in S3, mounted into the agent's container, and edited results can be downloaded. Good for documents and data.
2. **Their own PC:** that's the free self-hosted relay. A Pro user can keep a relay project alongside cloud
   projects, and the app routes "in <project>" to whichever owns that name.

## Security and privacy

- Each agent task gets its own container, a GitHub installation token for only that repo (1 hour), and no AWS
  permissions beyond writing its own inbox messages and Files prefix.
- Photos are deleted after the answer (S3 lifecycle as a backstop). Transcripts are kept only as inbox
  messages for 7 days.
- The privacy policy and App Store label change from "Data Not Collected" to: contact info (Sign in with
  Apple relay email), user content (task text, photos, files) used only to provide the service, not linked to
  tracking. Account deletion (App Store 5.1.1(v)) is in the app and on the website and removes everything.

## Infrastructure as code

AWS CDK (TypeScript) in `cloud/infra`, deployed from GitHub Actions with OIDC (no stored AWS keys):
`BridgeWeb` (S3 + CloudFront + ACM + Route 53), `BridgeApi` (API Gateway,
Lambdas, DynamoDB, S3), `BridgeAgents` (ECR, ECS cluster, task definition). Lambdas live in `cloud/api`;
the agent image in `cloud/agent`.

## The owner's agents: the PC relay, moved into Bridge Cloud

Stephen's own use runs here instead of on his PC, so the PC hosts nothing. It's the relay's `AGENT_MODE=cloud`,
moved: each task is a claude.ai cloud session that shows in the Claude app.

- **Owner token** (`cloud/api/owner.mjs`): the sideloaded app has no Sign in with Apple, so it keeps sending a
  relay token (by default the relay's own `VOICE_TOKEN`). The authorizer compares it with the SHA-256 in Secrets
  Manager (`bridge/owner`) and lets it in as the user `owner`, who has every Pro feature. The app only changes its
  relay address to `<ApiUrl>/api`; the voice protocol is the same, and Tailscale is no longer needed.
- **The Claude connector** signs in with Sign in with Apple, as `apple.<sub>`. `bridge/owner` can also hold the
  owner's `appleSub` (setup-owner.ps1 offers the accounts that connected Claude, by date); the connector's tools then
  act as `owner`, so Claude on claude.ai starts the owner's agents and reads their inbox. Its refresh tokens stay
  under the Apple account, and the app's own Apple sign-in is unchanged.
- **Agents** (`cloud/api/agents.mjs`): only `owner` gets them, because they run on Stephen's claude.ai
  subscription and the Agent SDK terms keep subscription sign-in out of products for others. Everyone else still
  gets the "not switched on" answer until build step 4 (API billing). Projects (`PROJECT#` items) come from his
  project folders' GitHub remotes; each agent's state, pending turns and run id are an `AGENT#` item. Task, reply,
  status and stop work as on the relay; usage, context and photos to agents don't (they need the PC).
- **Runner** (`cloud/runner`, Fargate, 0.5 vCPU / 1 GB, public subnets, no NAT): the Voice Lambda starts one task per
  busy spell of an agent. It signs Claude Code in with a claude.ai login made for Bridge Cloud (`bridge/owner-claude`),
  shallow-clones the repo (or makes an empty repo with the same remote, for a private one), runs the pending turns with
  the relay's own `cloud-agents.mjs`, writes each answer to the inbox (and ntfy), fires the project routine, marks the
  agent idle and exits. When Claude Code refreshes the login, the runner writes the new one back.
  Claude Code's print mode can't start a new cloud session (2.1.260 and later refuse), so a new task fires the
  owner's "Bridge task" routine (`bridge/owner-routine`, `{ url, token }`) with the repo and the task as its text;
  its prompt is `cloud/setup/task-routine-prompt.txt`. The CLI can only queue a message to a cloud session, not wait
  for its answer, so the session sends each spoken answer itself: the text also carries a Reply URL
  (`POST /api/agent/reply`, no API Gateway authorizer) and a per-task reply token (`brt.<agent>.<random>`; only its
  SHA-256 is kept, as the agent's `replyHash`). Replies go to the session with `claude -p --cloud <id>` and are
  answered the same way. The cloud environment's Trusted network allows `*.amazonaws.com`.
- **Setup**: `cloud/setup/setup-owner.ps1` on the PC stores the token's hash, signs a new claude.ai login in and stores
  it, asks once for the task routine's Fire URL and token, and writes the projects. `cloud/setup/deploy-branch.ps1` deploys BridgeApi from an unmerged branch on the PC and
  then runs it, to try a change before it's merged.
- **Cost** at about 10 tasks a day: roughly $5 to $8 a month, nearly all Fargate time while a session works and
  Secrets Manager; nothing runs between tasks.
- **Known limits**: two runners starting at once with an expired login can race on its refresh and sign the
  other out (rerun the setup script). Sideloaded builds get no push, so answers arrive while the app listens, and through ntfy.

## The orchestrator: status on all of the owner's projects

One entry point for every spoken request about the owner's projects (`cloud/api/orchestrator.mjs`). It's plain code in
the Voice Lambda, not a model: matching a project and reading reports need no judgement, so answers are instant, the
same words always route the same way, and nothing runs between requests. The Claude work stays in the workers.

- **Registry**: the `PROJECT#` items (name, repo, aliases, and a `tag` such as CVR from `setup-owner.ps1`).
- **Status files** (`cloud/api/status.mjs`): a `STATUS#<project>` item per project in the standard format (health, done,
  in progress and its ID, next, needs the owner, assigned to, where, needs to continue overnight). Workers send it as
  `status` with each answer to `/api/agent/reply` (the routine prompt asks for it), any Claude session can write it with
  the connector's `update_status`, and the runner marks a project "needs attention" when a run fails. Live agent state
  outranks the file: a question waiting on the owner, or a run that went quiet, shows in every report.
- **Voice**: "status on all programs", "status on X and Y", "what needs me?", "details on X", "tell X to ...",
  "morning briefing", "evening brief". Reports answer at once; "tell X to" is read back like a task. The connector's
  `get_status` gives the same reports to Claude.
- **Workers** read and update `.bridge/worker.md` in their repo, so what one task learns reaches the next.

## Build order

1. Deploy role + GitHub OIDC; Bedrock access check. Domain, ACM certificate, website moved to S3/CloudFront.
2. Sign in with Apple and account deletion (done); account page on the website.
3. API: `/voice/confirm`, `/voice/inbox`, `/voice/photo` (quick answer on Bedrock) with the read-back flow.
4. GitHub App + agent container on Fargate: "in <repo>, <task>" opens a PR and speaks the result.
5. App Store subscriptions verified server-side (App Store Server API + notifications); usage metering.
6. App: sign in, choose Cloud or My PC, plan status and usage; Files workspace.
7. Privacy policy, terms, App Store label and review notes updated; TestFlight; submit.
