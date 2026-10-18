## Privacy

The relay and the sideloaded app have no account, no analytics, no ads and no tracking. Speech is turned into
text by Apple's speech recognition on the iPhone (on-device where the iPhone supports your language). The text
and any glasses photos go only to the relay on your own PC, over your own Tailscale network, and from there to
Claude Code under your own Claude account. With `OPENAI_API_KEY` set, the relay sends reply text to OpenAI to
be spoken. Builds made with a `SENTRY_DSN` send crash reports with no speech, photos, replies, address or token;
builds without one (the default here) send nothing.

## The App Store app

Bridge on the App Store adds Bridge Cloud (agents without a PC), calls from agents, the Claude connector and
Bridge Pro. It is built from a separate, private repository; this one is the free, self-hosted part.

## Licence

MIT, see [LICENSE](LICENSE).
