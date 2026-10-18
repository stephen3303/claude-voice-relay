# Shipping Bridge on the App Store

Two builds come from the same code:

| | Personal (sideloaded) | App Store |
|---|---|---|
| Built by | `Glasses iOS build` (artifact) | `Glasses App Store upload` (signed, uploaded) |
| "Hey Meta, start Bridge" | yes | no: Meta marks voice invocation experimental, and experimental features "cannot be published yet" |
| Start a conversation | Hey Meta, Siri, Shortcuts, app | Siri ("Talk to Bridge"), Action Button, Shortcuts, app |
| Photos | still from the camera stream | still from the camera stream |
| Bridge Pro | everything unlocked | photos + Ask/Look Shortcuts need the subscription |

When Meta takes voice invocation out of experimental, drop the `#if !APP_STORE` in
`GlassesController.start()` and ship it in the App Store build too.

## Steps only you can do

1. **Apple Developer Program** ($99/year): enroll at developer.apple.com/programs with your Apple ID.
   Your free "personal team" (48KYFQL84F) can't publish; the paid team gets a new Team ID.
2. **App Store Connect > Business:** accept the Paid Apps agreement, and add tax and banking details.
   Subscriptions can't be sold until this is done.
3. **Bundle ID:** in Certificates, Identifiers & Profiles, register `com.smitherman.glassesrelay`.
   If Apple says it's taken (the free team claimed it through Sideloadly), it frees up after the
   free provisioning expires. Otherwise use a new one and change it in `project.yml`, `Store.swift`
   and the Wearables Developer Center.
4. **App record:** App Store Connect > Apps > + New App: iOS, the name below, that bundle ID, SKU `bridge-ios`.
5. **Subscription:** the app > Monetization > Subscriptions > new group "Bridge Pro", then two
   auto-renewable subscriptions:
   - `com.smitherman.glassesrelay.pro.monthly`: 1 month, $4.99, 1-week free introductory offer
   - `com.smitherman.glassesrelay.pro.yearly`: 1 year, $49.99, 1-week free introductory offer
   Each needs a display name, a description and a review screenshot (a screenshot of the Bridge Pro sheet is fine).
6. **API key for CI:** Users and Access > Integrations > App Store Connect API > generate a key with
   the App Manager role. Add these repository secrets (Settings > Secrets and variables > Actions):
   `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (`base64 -w0 AuthKey_XXXX.p8`) and `APPLE_TEAM_ID`.
7. **Meta, for production:** in the Wearables Developer Center, set the app's Apple Team ID to the paid team,
   take its **App ID** and **Client Token** into the `META_APP_ID` and `META_CLIENT_TOKEN` secrets,
   and publish a release channel for App Store users. Ask Meta how DAT apps meet Apple's MFi
   requirement: the app declares the `com.meta.ar.wearable` accessory protocol, and App Review
   asks the accessory maker to approve that.
8. **Upload:** Actions > Glasses App Store upload > Run workflow. The build appears in TestFlight in about 15 minutes.
9. **Test on TestFlight**, then add screenshots (below) and submit for review.

## Listing

- **Name:** Bridge: Voice for Code Agents (if taken: Bridge Voice Relay)
- **Subtitle:** Talk to your coding agents
- **Category:** Developer Tools (secondary: Productivity)
- **Age rating:** 4+ (no objectionable content; answers come from the user's own agents)
- **Price:** Free, with Bridge Pro in-app subscription
- **Privacy policy URL:** https://stephen3303.github.io/claude-voice-relay/privacy.html
- **Support URL:** https://stephen3303.github.io/claude-voice-relay/support.html
- **Marketing URL:** https://stephen3303.github.io/claude-voice-relay/
- **Keywords (100 max):** voice,coding,agents,developer,hands-free,glasses,ray-ban,relay,shortcuts,siri,claude code
- **Promotional text:** Run your coding agents from anywhere: talk, hear the answer, keep your hands free.

**Description:**

Bridge lets you talk to the coding agents running on your own PC, hands-free, through Ray-Ban Meta
glasses or any Bluetooth headset.

Say "in my project, add a stop-loss check". Bridge reads the task back, and when you say "send it",
your agent starts work. When it's done, or needs a yes or no from you, you hear it.

- Hands-free: start with Siri ("Talk to Bridge"), the Action Button or Shortcuts
- Read-back before anything is sent, so a misheard word never starts the wrong task
- Hear your agents' answers as they arrive, and answer their questions by voice
- Private: speech is recognized on your iPhone, and text goes only to your own PC over your Tailscale network

Bridge Pro:
- "Look at this": take a photo with your glasses and hear what Claude sees
- "Send this to my project": hand the photo to that agent
- Ask Bridge and Look with Bridge actions for Shortcuts and automations

Requires the free, open-source Bridge relay on a Windows PC with Docker, Tailscale and your own
Claude Code subscription. Setup: https://github.com/stephen3303/claude-voice-relay

Bridge Pro is an auto-renewing subscription, monthly or yearly, with a 1-week free trial. Payment
is charged to your Apple ID. It renews unless cancelled at least 24 hours before the end of the
period; manage or cancel it in Settings > Apple ID > Subscriptions.
Terms: https://stephen3303.github.io/claude-voice-relay/terms.html

Not affiliated with Anthropic or Meta. Ray-Ban is a trademark of Luxottica.

## App Review notes (paste into "Notes" under App Review Information)

Bridge is a voice front end for software the user runs on their own computer (the open-source relay
at https://github.com/stephen3303/claude-voice-relay). Reviewing it without that setup:

1. Open Bridge > PC relay > tap "Use demo (no PC needed)".
2. Tap "Talk now" and allow the microphone and speech recognition.
3. Say "in demo, write a test". Bridge reads it back. Say "send it". Then say "goodbye".

The glasses camera features (Bridge Pro) need Ray-Ban Meta glasses; a video of them working is at:
<add a link to a screen recording here>. Subscriptions can be tested in the sandbox from the
Bridge Pro section.

Background audio is used only during a conversation the user starts: the app keeps listening
through the headset microphone while an agent works, and speaks its answer, until the user
says "goodbye" or the conversation times out.

## Privacy "nutrition label"

Data Not Collected. Speech is recognized on device; text and photos go only to the user's own
relay, and the developer never receives them; no analytics or tracking. (`PrivacyInfo.xcprivacy` matches.)

## Screenshots

Required: 6.9" iPhone (1320 x 2868). Take them on the iPhone (Bridge settings with demo on, a
conversation transcript, the Bridge Pro sheet) and add them in App Store Connect.

## Review risks to know

- **Ongoing value (guideline 3.1.2):** Apple sometimes rejects subscriptions that only unlock
  features. If that happens, switch Pro to a one-time non-consumable purchase in `Store.swift`.
- **Companion software (2.1):** the reviewer needs the demo mode and the video above.
- **MFi accessory protocol:** see step 7.
