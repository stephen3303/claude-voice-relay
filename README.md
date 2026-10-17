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
The relay reads your task back and waits for **send it** before anything starts. Point the
Shortcut at `/voice/confirm` and wrap it in a loop:

1. **Repeat** 6 times
2. &nbsp;&nbsp;**Dictate text**
3. &nbsp;&nbsp;**Text**: `task: ` + Dictated Text
4. &nbsp;&nbsp;**Get contents of** `http://<relay>:47879/voice/confirm` (POST, same Authorization header and Text body as before)
5. &nbsp;&nbsp;**Speak** Contents of URL (leave *Wait Until Finished* on, or dictation hears the speech)
6. &nbsp;&nbsp;**If** Contents of URL *does not contain* `again` → **Stop This Shortcut**
7. **End Repeat**

On each turn, say one of these:
- **send it** (or "go ahead", "do it", "yes"): starts the task you just heard read back.
- **the task again**: replaces it, and the relay reads the new one back.
- **cancel**: drops it.

The read-back also names the project it resolved, so a misheard project gets caught before
the agent starts. Any reply that is waiting on you contains "again"; "Sent." and "Cancelled." don't, which is what ends the loop.
An unconfirmed task expires after 10 minutes. Plain `/voice` still sends straight away.

## Setup
1. `copy .env.example .env` and fill it in.
2. `npm run build-agent`
3. `npm run install-hook`
4. `npm start` (or let the ClaudeVoiceRelay scheduled task start it at logon)

Tested from my phone: the relay has been verified end to end from an iPhone.
