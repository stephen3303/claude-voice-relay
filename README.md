# claude-voice-relay

Hands-free Claude Code agents: start them with Siri, hear them in your AirPods, answer by voice.

- **relay.mjs** (runs on Windows) — voice endpoint + agent manager. Each agent is its own Docker
  container with only its repo mounted at `/work`, running headless Claude Code; your replies
  resume the same session. You talk to it through the Bridge app or the iPhone Shortcut below.
- **hooks/notify.mjs** — Claude Code Notification hook for your normal interactive sessions;
  the Bridge app reads "Claude needs you" aloud while a conversation is open. On your phone, the
  Claude app's push notifications cover the same thing.

## Voice commands
- `task: in <project>, <what to do>` — new agent (the iPhone Shortcut adds the `task:` prefix)
- `yes` / `no` / anything else — answers the agent that's waiting (prefix with the agent name to target one)
- `status`, `stop <agent>`

An agent's full last reply (everything above its spoken summary) is in `logs/claude-agent-<name>.last.md`.

Spoken project names match folder names under PROJECTS_ROOT; add nicknames to `aliases.json`,
e.g. `{ "trading bot": "Roundtable_Trading" }`.

## iPhone Shortcut ("Tell Claude") with read-back
The relay reads your task back the way Siri reads back a text ("Here's your message to Claude
for trading bot, add a stop-loss check. Ready to send it?") and waits for a yes before anything starts. `/voice` does
this by default (set `VOICE_CONFIRM=0` in `.env` to send immediately); `/voice/confirm` always does.
Build the Shortcut so it keeps listening until the task is sent or cancelled:

1. **Repeat** 8 times
2. &nbsp;&nbsp;**Dictate text** (Stop Listening: *After Pause*)
3. &nbsp;&nbsp;**Text**: `task: ` + Dictated Text
4. &nbsp;&nbsp;**Get contents of** `https://<pc>.<tailnet>.ts.net/voice/confirm`
   (or `http://<relay>:47879/voice/confirm`): Method **POST**, Header `Authorization` = `Bearer <VOICE_TOKEN>`,
   Request Body **JSON** with one field, `text` = the Text from step 3
5. &nbsp;&nbsp;**Speak** Contents of URL (leave *Wait Until Finished* on, or dictation hears the speech)
6. &nbsp;&nbsp;**If** Contents of URL *does not contain* `?` → **Stop This Shortcut**
7. **End Repeat**

On each turn, say one of these:
- **send** or **yes** (or "send it", "go ahead", "do it"; "sent it" and "send it please" also count): starts the task you just heard read back.
- **change it**: the relay asks "What do you want to tell trading bot?" and reads your new words back. Saying a new task straight away replaces it too.
- **cancel** or **no**: drops it ("OK, I won't send it.").

The read-back names the project it resolved, so a misheard project gets caught before the agent
starts. If dictation stops right after the project ("in voice relay"), the relay keeps the project
and asks for the task. Every reply that is waiting on you is a question (it contains "?"); "Sent." and
"OK, I won't send it." aren't, which is what ends the loop. Silence never sends anything. An unconfirmed task expires after
10 minutes, and "send it" after that says so. With nothing waiting, a bare "yes" answers an agent
that asked you a yes-or-no question.

**Updating an older Shortcut:** change the URL in *Get contents of* to end in `/voice/confirm`,
wrap the actions in the Repeat loop above if they aren't already, and add the *If ... does not contain ?* step (older Shortcuts checked for `again`; change it to `?`).
The body can stay JSON, or be a Form with a `text` field. Nothing else changes.

## Ray-Ban Meta glasses ("Hey Meta, start Bridge")
`glasses/ios` is an iPhone app, Bridge, built on GitHub Actions (`Glasses iOS build`) and sideloaded
with Sideloadly. For a build to install, run `Glasses dev release` (Actions > Run workflow): it
publishes `GlassesRelay.ipa` as a prerelease, and [glasses/SIDELOAD.md](glasses/SIDELOAD.md) has
the install steps. Meta AI opens it on "Hey Meta, start Bridge"; it listens through the glasses
microphone, sends what you say to `/voice/confirm` (the same read-back as the Shortcut), and speaks
the answer. While the conversation is open it also long-polls `GET /voice/inbox` and reads out
whatever your agents say. Say "in <project>, <task>" to start a task, "send" or "yes" when it asks "Ready to send it?",
"yes" to answer an agent, and "goodbye" to hang up. After "Sent." it stays on the line for up to
15 minutes so you hear the agent's answer.

**Natural voice:** set `OPENAI_API_KEY` in `.env` (optionally `TTS_VOICE`, `TTS_MODEL`) and restart the relay;
the app then speaks through `POST /voice/tts` and falls back to the iPhone voice if that fails.

**Photos:** say "look at this, ..." / "what am I looking at" for a quick answer (`POST /voice/photo`
runs `claude -p` on the photo), or "send this to <project>, ..." to hand it to that agent. The photo is
copied into the agent's container `/tmp` (never the repo, so it can't be committed) and deleted
after the answer. Needs Camera enabled for Bridge in the Wearables Developer Center and
"Allow camera" tapped once in the app.

**Shortcuts / Siri:** Talk to Bridge, Ask Bridge (text in, reply out) and Look with Bridge.

The phone reaches the relay over HTTPS with `tailscale serve --bg 47879`. In the app, enter that
`https://<pc>.<tailnet>.ts.net` address and your `VOICE_TOKEN`.

## Setup
1. `copy .env.example .env` and fill it in.
2. `npm run build-agent`
3. `npm run install-hook`
4. `npm start` (or let the ClaudeVoiceRelay scheduled task start it at logon)
5. Give agents their own GitHub access (below).

Tested from my phone: the relay has been verified end to end from an iPhone.

## GitHub access for agents
Agents never hold a GitHub token, yours or any other. They commit on a branch and ask for it to be
pushed; after the turn the relay mints a token from its own GitHub App that only covers that agent's
repository, with contents and pull request access and nothing else (no workflows, secrets, settings
or other repos). One throwaway container copies the branch out of the repo with no token and no
network, and a second one, which gets the token and nothing of the agent's but that copy, pushes it.
The relay opens the pull request (or updates the open one), says which, and revokes the token
straight away. Commits and pull requests show as `<app-name>[bot]`. Agents can't
use `gh` or fetch private repos, since they have no credentials.

The relay only hands out a token for a repo whose default branch is protected as below, and never
lets an agent work in the relay's own folder (it could change the code your PC runs) or in a folder
above it or above `%USERPROFILE%\.bridge`, where the App key is. To have agents work on this repo,
clone it again into a subfolder, keeping the repo's name (a folder is only matched to the GitHub
repo of the same name): in your projects folder, `git clone https://github.com/<you>/claude-voice-relay agents\claude-voice-relay`.
`aliases.json` already sends "voice relay" there.

**In each repo the App will be installed on, first:**
1. Add a `.github/CODEOWNERS` file containing `* @<your-username>` (this repo has one).
2. **Settings → Rules → Rulesets → New ruleset → New branch ruleset.** Name `Protect main`,
   Enforcement **Active**. **Bypass list → Add bypass → Repository admin**, set to **For pull
   requests only** (so you can still merge your own pull requests); never add the agents App.
   **Target branches → Add target → Include default branch.** Keep **Restrict deletions** and
   **Block force pushes** on. Tick **Require a pull request before merging**, set **Required
   approvals** to 1, and tick **Require review from Code Owners** and **Require approval of the most
   recent reviewable push**. **Create.**
3. **New branch ruleset** again. Name `Protect branches`, Enforcement **Active**, **Bypass list →
   Repository admin**, set to **Always**. **Target branches → Add target → Include all branches.**
   Keep **Restrict deletions** and **Block force pushes** on, nothing else. **Create.**

Agents then can't push to, rewrite or delete any branch but their own new ones, and the bot's
approval doesn't count, so nothing merges without you.

**Then, once:**
1. On the PC, in this folder: `node setup-github-app.mjs`. The browser opens GitHub; click
   **Create GitHub App**. The private key goes to `%USERPROFILE%\.bridge\` (readable only by you)
   and `.env` gets `GITHUB_APP_ID` and `GITHUB_APP_KEY_FILE`.
2. On the install page that opens: **Only select repositories**, pick the repos agents may push to,
   **Install**. Add more later under GitHub **Settings → Applications → Installed GitHub Apps**.
3. `npm run build-agent`, then restart the relay. Older agent containers (which still had a
   credential helper, or your old token) are replaced on their next turn; their sessions are kept.

Without the App you can put a fine-grained token in `AGENT_GH_TOKEN` instead (GitHub **Settings →
Developer settings → Fine-grained tokens**, only the agents' repos, Contents and Pull requests
read and write, an expiry). It acts as you, so the rulesets can't tell agents apart; the App is better.

## Agents in the Claude app (cloud sessions)
With `AGENT_MODE=cloud` in `.env`, each voice task runs as a claude.ai cloud session instead of a
Docker container, so the conversation shows up in the Claude app (**Code** tab) and at claude.ai/code
with its full transcript, and you can pick it up there. The relay still speaks the replies.
- The session works on the project folder's GitHub remote at its current branch (what's pushed, not
  local changes), and pushes and opens its pull request itself through the Claude GitHub app, not the
  relay's GitHub App. The relay still only starts one for a repo that passes the same check as
  before a relay push (protected default branch, CODEOWNERS, the App installed), because those
  rules are what stop any bot, the Claude GitHub app included, from changing main on its own.
  So cloud mode needs the GitHub App below; `AGENT_GH_TOKEN` alone isn't enough.
- It needs Claude Code on the PC signed in with your claude.ai account: run `claude auth login` once
  (and `claude update`; older versions don't wait for a follow-up's answer, so you hear "sent" and read it in the app).
  The `CLAUDE_CODE_OAUTH_TOKEN` setup token can't start cloud sessions; the relay keeps it away from them.
- The relay starts `claude` without a shell, like the photo answers do, so it must be the native
  install (`claude.exe`, from `irm https://claude.ai/install.ps1 | iex`), not npm's `claude.cmd`;
  or set `CLAUDE_BIN` in `.env` to the full path of `claude.exe`.
- Photos can't go to cloud agents (they're files on the PC); quick "what am I looking at" photos still work.
- "Stop" only stops the relay listening; stop the session itself in the Claude app.

## Use Bridge from Claude (custom connector)
Bridge Cloud is also a remote MCP server, so Claude (claude.ai, the Claude apps, Claude Code) can
start tasks for your agents and read what they said. It has two tools: **send_task** (a project and
a task, or just an answer for the agent that asked something) and **read_inbox**. You sign in with
the same Apple ID as the Bridge app, so it's the same account and the same inbox.

One-time setup in Apple Developer (only the account holder can do this):
1. **Certificates, Identifiers & Profiles → Identifiers → +** → **Services IDs**. Description
   `Bridge web`, identifier `com.talktobridge.bridge.web` (it must be exactly this; it's
   `SERVICES_ID` in `cloud/infra/lib/api.mjs`).
2. Open it, tick **Sign in with Apple**, **Configure**: Primary App ID = the Bridge app
   (`com.talktobridge.bridge`, so you get the same account as in the app). Domain: the host of
   the `AppleReturnUrl` output of the Cloud deploy run (`<id>.execute-api.us-east-1.amazonaws.com`).
   Return URL: the `AppleReturnUrl` itself (`https://<id>.execute-api.us-east-1.amazonaws.com/api/oauth/apple`).
   Save, then Continue, then Save.

Add it to Claude:
1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name `Bridge`; URL: the `ConnectorUrl` output (`https://<id>.execute-api.us-east-1.amazonaws.com/api/mcp`).
   Leave the advanced OAuth fields empty: Claude registers itself.
3. **Connect**, then **Sign in with Apple**. The connector then works in the Claude iPhone app too.

For Claude Code: `claude mcp add --transport http bridge <ConnectorUrl>`, then `/mcp` to sign in.

How it works: `cloud/api/connector.mjs`. The MCP endpoint is stateless streamable HTTP (JSON
responses). Sign-in is OAuth 2.1 with dynamic client registration and PKCE; only Claude's and
localhost redirect addresses can register. Access tokens last an hour; a sign-in lasts 30 days.
Refresh tokens are kept with the account, work once each, and deleting the account disconnects
Claude. Access tokens are signed by the same KMS key as app sessions but for another audience, so
neither works in place of the other. Until cloud agents are built (cloud/DESIGN.md step 4), send_task answers that
they aren't switched on yet, the same as the app does in Cloud mode.
