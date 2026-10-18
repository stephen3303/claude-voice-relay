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
The relay reads your task back and waits for **send it** before anything starts. This is on for
`/voice` by default (set `VOICE_CONFIRM=0` in `.env` to send immediately), so the existing
Shortcut confirms with no changes: run it once to dictate, and again to say "send it".
To keep listening in one run instead, wrap the actions in a loop:

1. **Repeat** 6 times
2. &nbsp;&nbsp;**Dictate text**
3. &nbsp;&nbsp;**Text**: `task: ` + Dictated Text
4. &nbsp;&nbsp;**Get contents of** `http://<relay>:47879/voice` (POST, same Authorization header and Text body as before)
5. &nbsp;&nbsp;**Speak** Contents of URL (leave *Wait Until Finished* on, or dictation hears the speech)
6. &nbsp;&nbsp;**If** Contents of URL *does not contain* `again` → **Stop This Shortcut**
7. **End Repeat**

On each turn, say one of these:
- **send it** (or "go ahead", "do it", "yes"): starts the task you just heard read back.
- **the task again**: replaces it, and the relay reads the new one back.
- **cancel**: drops it.

The read-back also names the project it resolved, so a misheard project gets caught before
the agent starts. Any reply that is waiting on you contains "again"; "Sent." and "Cancelled." don't, which is what ends the loop.
An unconfirmed task expires after 10 minutes.

## Ray-Ban Meta glasses ("Hey Meta, start Bridge")
`glasses/ios` is an iPhone app, Bridge, built on GitHub Actions (`Glasses iOS build`) and sideloaded
with Sideloadly. Meta AI opens it on "Hey Meta, start Bridge"; it listens through the glasses
microphone, sends what you say to `/voice/confirm` (the same read-back as the Shortcut), and speaks
the answer. While the conversation is open it also long-polls `GET /voice/inbox` and reads out
whatever your agents say. Say "in <project>, <task>" to start a task, "send it" to confirm,
"yes" to answer an agent, and "goodbye" to hang up. After "Sent." it stays on the line for up to
15 minutes so you hear the agent's answer.

The phone reaches the relay over HTTPS with `tailscale serve --bg 47879`. In the app, enter that
`https://<pc>.<tailnet>.ts.net` address and your `VOICE_TOKEN`.

## Setup
1. `copy .env.example .env` and fill it in.
2. `npm run build-agent`
3. `npm run install-hook`
4. `npm start` (or let the ClaudeVoiceRelay scheduled task start it at logon)

Tested from my phone: the relay has been verified end to end from an iPhone.
