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
photos (`/api/voice/photo`, Bedrock) answer that they need Pro. Sandbox purchases count too while `SANDBOX_PRO`
(cloud/infra/lib/api.mjs) is true, because App Review buys in the sandbox against this backend; that also gives invited
TestFlight testers Pro for free, within the daily budgets. Once Apple approves the app it is set to false: sandbox
purchases are refused, and Pro they granted ends. Missed refund notifications aren't caught up yet: that needs
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

## Build order

1. Deploy role + GitHub OIDC; Bedrock access check. Domain, ACM certificate, website moved to S3/CloudFront.
2. Sign in with Apple and account deletion (done); account page on the website.
3. API: `/voice/confirm`, `/voice/inbox`, `/voice/photo` (quick answer on Bedrock) with the read-back flow.
4. GitHub App + agent container on Fargate: "in <repo>, <task>" opens a PR and speaks the result.
5. App Store subscriptions verified server-side (App Store Server API + notifications); usage metering.
6. App: sign in, choose Cloud or My PC, plan status and usage; Files workspace.
7. Privacy policy, terms, App Store label and review notes updated; TestFlight; submit.
