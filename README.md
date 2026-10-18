# claude-voice-relay

Hands-free Claude Code agents: start them with Siri, hear them in your AirPods, answer by voice.

- **relay.mjs** (runs on Windows) — Telegram bot + agent manager. Each agent is its own Docker
  container with only its repo mounted at `/work`, running headless Claude Code; your replies
  resume the same session.
- **hooks/notify.mjs** — Claude Code Notification hook for your normal interactive sessions;
  forwards "Claude needs you" to Telegram (notify only; answer those at a screen or via the Claude app).

## Voice commands (via Telegram)
- `task: in <project>, <what to do>` — new agent (the iPhone Shortcut adds the `task:` prefix)
- `yes` / `no` / anything else — answers the agent that's waiting (prefix with the agent name to target one)
- `status`, `stop <agent>`, `full <agent>` (full text, for when you're at a screen)

Spoken project names match folder names under PROJECTS_ROOT; add nicknames to `aliases.json`,
e.g. `{ "trading bot": "Roundtable_Trading" }`.

## iPhone Shortcut ("Tell Claude") with read-back
The relay reads your task back and waits for **send it** before anything starts. `/voice` does
this by default (set `VOICE_CONFIRM=0` in `.env` to send immediately); `/voice/confirm` always does.
Build the Shortcut so it keeps listening until the task is sent or cancelled:

1. **Repeat** 8 times
2. &nbsp;&nbsp;**Dictate text** (Stop Listening: *After Pause*)
3. &nbsp;&nbsp;**Text**: `task: ` + Dictated Text
4. &nbsp;&nbsp;**Get contents of** `https://<pc>.<tailnet>.ts.net/voice/confirm`
   (or `http://<relay>:47879/voice/confirm`): Method **POST**, Header `Authorization` = `Bearer <VOICE_TOKEN>`,
   Request Body **JSON** with one field, `text` = the Text from step 3
5. &nbsp;&nbsp;**Speak** Contents of URL (leave *Wait Until Finished* on, or dictation hears the speech)
6. &nbsp;&nbsp;**If** Contents of URL *does not contain* `again` → **Stop This Shortcut**
7. **End Repeat**

On each turn, say one of these:
- **send it** (or "go ahead", "do it", "yes"; "sent it" and "send it please" also count): starts the task you just heard read back.
- **the task again**: replaces it, and the relay reads the new one back.
- **cancel**: drops it.

The read-back names the project it resolved, so a misheard project gets caught before the agent
starts. If dictation stops right after the project ("in voice relay"), the relay keeps the project
and asks for the task. Every reply that is waiting on you contains "again"; "Sent." and
"Cancelled. Nothing sent." don't, which is what ends the loop. An unconfirmed task expires after
10 minutes, and "send it" after that says so. With nothing waiting, a bare "yes" answers an agent
that asked you a yes-or-no question.

**Updating an older Shortcut:** change the URL in *Get contents of* to end in `/voice/confirm`,
wrap the actions in the Repeat loop above if they aren't already, and add the *If ... again* step.
The body can stay JSON, or be a Form with a `text` field. Nothing else changes.

## Ray-Ban Meta glasses ("Hey Meta, start Bridge")
`glasses/ios` is an iPhone app, Bridge, built on GitHub Actions (`Glasses iOS build`) and sideloaded
with Sideloadly. Meta AI opens it on "Hey Meta, start Bridge"; it listens through the glasses
microphone, sends what you say to `/voice/confirm` (the same read-back as the Shortcut), and speaks
the answer. While the conversation is open it also long-polls `GET /voice/inbox` and reads out
whatever your agents say. Say "in <project>, <task>" to start a task, "send it" to confirm,
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

Tested from my phone: the relay has been verified end to end from an iPhone.

## Use Bridge from Claude (custom connector)
Bridge Cloud is also a remote MCP server, so Claude (claude.ai, the Claude apps, Claude Code) can
start tasks for your agents and read what they said. It has two tools: **send_task** (a project and
a task, or just an answer for the agent that asked something) and **read_inbox**. You sign in with
the same Apple ID as the Bridge app, so it's the same account and the same inbox.

One-time setup in Apple Developer (only the account holder can do this):
1. **Certificates, Identifiers & Profiles → Identifiers → +** → **Services IDs**. Description
   `Bridge web`, identifier `com.smitherman.glassesrelay.web` (it must be exactly this; it's
   `SERVICES_ID` in `cloud/infra/lib/api.mjs`).
2. Open it, tick **Sign in with Apple**, **Configure**: Primary App ID = the Bridge app
   (`com.smitherman.glassesrelay`, so you get the same account as in the app). Domain: the host of
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
