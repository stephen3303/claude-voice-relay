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
3. **Bundle ID:** in Certificates, Identifiers & Profiles, register `com.talktobridge.bridge`.
   Do it before sideloading a build with this ID, or Sideloadly's free team may claim it first. If you
   ever need a different ID, replace it everywhere `git grep com.talktobridge.bridge` finds it (app,
   cloud, tests, workflows, docs) and in the Wearables Developer Center.
4. **App record:** App Store Connect > Apps > + New App: iOS, the name below, that bundle ID, SKU `bridge-ios`.
5. **Subscription:** the app > Monetization > Subscriptions > new group "Bridge Pro", then two
   auto-renewable subscriptions:
   - `com.talktobridge.bridge.pro.monthly`: 1 month, $4.99, 1-week free introductory offer
   - `com.talktobridge.bridge.pro.yearly`: 1 year, $49.99, 1-week free introductory offer
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
- **Privacy policy URL:** https://talktobridge.com/privacy.html
- **Support URL:** https://talktobridge.com/support.html
- **Marketing URL:** https://talktobridge.com/
- **Keywords (100 max):** voice,coding,agents,developer,hands-free,glasses,ray-ban,headset,shortcuts,siri,claude
- **Promotional text:** Run your coding agents from anywhere: talk, hear the answer, keep your hands free.

**Description:**

Bridge lets you talk to your Claude agents hands-free, through Ray-Ban Meta glasses or any Bluetooth
headset. Your agents run in Bridge Cloud, so all you need is your iPhone and a Bridge account.

Say "in my project, add a stop-loss check". Bridge reads the task back, and when you say "send it",
your agent starts work. When it's done, or needs a yes or no from you, it calls you.

- Hands-free: start with Siri ("Talk to Bridge"), the Action Button or Shortcuts
- Read-back before anything is sent, so a misheard word never starts the wrong task
- Hear your agents' answers as they arrive, and answer their questions by voice
- Agents can call you: with a headset connected, a message rings like a phone call
- Works from Claude too: add Bridge as a connector in any Claude app
- Private: Sign in with Apple, no email address, no ads, no tracking; delete your account in the app

Bridge Pro:
- "Look at this": take a photo with your glasses and hear what Claude sees
- "Send this to my project": hand the photo to that agent
- A natural cloud voice for replies
- Ask Bridge and Look with Bridge actions for Shortcuts and automations

Bridge Pro is an auto-renewing subscription, monthly or yearly, with a 1-week free trial. Payment
is charged to your Apple ID. It renews unless cancelled at least 24 hours before the end of the
period; manage or cancel it in Settings > Apple ID > Subscriptions.
Terms: https://talktobridge.com/terms.html

Not affiliated with Anthropic or Meta. Ray-Ban is a trademark of Luxottica.

## App Review notes (paste into "Notes" under App Review Information)

Bridge is a voice front end for the user's Claude agents, which run in Bridge Cloud. To review it:

1. Sign in with Apple in Settings > Account, which selects Bridge Cloud. Or, without signing in,
   choose Settings > Connection > Demo for sample replies.
2. Tap "Talk now" and allow the microphone and speech recognition.
3. Say "in demo, write a test". Bridge reads it back. Say "send it". Then say "goodbye".

The glasses camera features (Bridge Pro) need Ray-Ban Meta glasses; a video of them working is at:
<add a link to a screen recording here>. Subscriptions can be tested in the sandbox from the
Bridge Pro section.

Background audio is used only during a conversation the user starts: the app keeps listening
through the headset microphone while an agent works, and speaks its answer, until the user
says "goodbye" or the conversation times out.

## Privacy "nutrition label"

Must match https://talktobridge.com/privacy.html and `PrivacyInfo.xcprivacy`. No tracking.

- **Identifiers > User ID:** linked to the user, app functionality (the Sign in with Apple identifier).
- **Purchases > Purchase history:** linked, app functionality (Bridge Pro transactions checked by Bridge Cloud).
- **User content > Photos:** linked, app functionality (photos the user asks about or sends to an agent).
- **User content > Other user content:** linked, app functionality (task text and agents' messages).
- **Usage data > Product interaction:** linked, app functionality (daily natural-voice characters and photo answers, kept 3 days, for limits).
- **Diagnostics > Crash data, Performance data, Other diagnostic data:** not linked, app functionality (Sentry).

Not collected: contact info (no email is requested; the first name stays on the phone), audio,
location. Push tokens are only used to deliver the user's own calls and notifications.

## Screenshots

Required: 6.9" iPhone (1320 x 2868). Take them on the iPhone (Bridge settings with demo on, a
conversation transcript, the Bridge Pro sheet) and add them in App Store Connect.

## Review risks to know

- **Ongoing value (guideline 3.1.2):** Apple sometimes rejects subscriptions that only unlock
  features. If that happens, switch Pro to a one-time non-consumable purchase in `Store.swift`.
- **Account (2.1):** the reviewer signs in with Apple, or uses the demo, plus the video above.
- **MFi accessory protocol:** see step 7.
