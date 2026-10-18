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
| bearer `VOICE_TOKEN` | Cognito ID token | per user |
| projects = folders on the PC | projects = GitHub repos the user installed the Bridge GitHub App on, plus a Files workspace | |

## Architecture (all in one AWS region, us-east-1)

```
iPhone app ──HTTPS──> CloudFront (bridge domain)
                        ├── /            S3: website (landing, privacy, terms, support, account)
                        └── /api/*       API Gateway (HTTP API, Cognito JWT authorizer) ──> Lambda (Node 22)
                                              │  DynamoDB: users, plans, usage, projects, tasks, inbox
                                              │  S3: photos (1-day lifecycle), Files workspaces
                                              ├──> Bedrock (Claude Haiku 5.5): read-back parsing, quick photo answers
                                              └──> ECS Fargate RunTask: one container per agent task
                                                     Claude Agent SDK on Bedrock (Sonnet 5.5), or the
                                                     user's own Anthropic key (BYO plan)
                                                     clone repo via GitHub App token → branch → PR
                                                     posts SPOKEN line to the inbox via the API
Cognito user pool: Sign in with Apple (required by App Store 4.8), email fallback
App Store Server Notifications v2 ──> Lambda: subscription state per user
GitHub App webhooks ──> Lambda: which repos each user installed it on
```

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
| Pro Connect (BYO key) | $4.99/mo or $39.99/yr | customer's Anthropic API key | hosted agents, photos, Shortcuts, Files |
| Pro | $19.99/mo or $179.99/yr | included: 30 agent tasks/month, unlimited quick photo answers (fair use) | same |

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
`BridgeWeb` (S3 + CloudFront + ACM + Route 53), `BridgeAuth` (Cognito), `BridgeApi` (API Gateway,
Lambdas, DynamoDB, S3), `BridgeAgents` (ECR, ECS cluster, task definition). Lambdas live in `cloud/api`;
the agent image in `cloud/agent`.

## Build order

1. Deploy role + GitHub OIDC; Bedrock access check. Domain, ACM certificate, website moved to S3/CloudFront.
2. Cognito with Sign in with Apple; account page on the website; account deletion.
3. API: `/voice/confirm`, `/voice/inbox`, `/voice/photo` (quick answer on Bedrock) with the read-back flow.
4. GitHub App + agent container on Fargate: "in <repo>, <task>" opens a PR and speaks the result.
5. App Store subscriptions verified server-side (App Store Server API + notifications); usage metering.
6. App: sign in, choose Cloud or My PC, plan status and usage; Files workspace.
7. Privacy policy, terms, App Store label and review notes updated; TestFlight; submit.
