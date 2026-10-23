# Shipping Bridge on the App Store

Two builds come from the same code:

| | Personal (sideloaded) | App Store |
|---|---|---|
| Built by | `Glasses iOS build` (artifact) | `Glasses App Store upload` (signed, uploaded) |
| XcodeGen spec | `project.yml` (`base.yml` + Meta Wearables toolkit) | `appstore.yml` (`base.yml` only) |
| Ray-Ban Meta glasses | yes | no (see below) |
| Start a conversation | Hey Meta, Siri, Shortcuts, app | Siri ("Talk to Bridge"), Action Button, Shortcuts, app |
| Talk through | glasses, any Bluetooth headset, the phone | AirPods, any Bluetooth headset, the phone |
| Photos | still from the glasses camera stream | none |
| Bridge Pro | everything unlocked | natural cloud voice + Ask Shortcut need the subscription |

**Why the App Store build has no glasses.** Meta's iOS integration guide (Device Access Toolkit 1.0) says
"Publishing to the App Store is not currently supported, but we plan to do so in the future", and that
because the toolkit uses the `ExternalAccessory` framework, an app with it "will lead to App Store rejection
due to Apple's MFi program and privacy manifest requirements". Meta only lets developers share a toolkit app
through one private, invite-only release channel. So `appstore.yml` leaves the toolkit, the
`com.meta.ar.wearable` accessory protocol and the Bluetooth, local network and camera permissions out, and the
glasses code and screens sit behind `#if !APP_STORE`.

When Meta opens App Store publishing: move the toolkit parts of `project.yml` into `appstore.yml`, turn the
`#if !APP_STORE` glasses blocks back on for the App Store build (keeping "Hey Meta" out while Meta still
marks voice invocation experimental), create a project named **Talk to Bridge** in the Wearables Developer
Center (the App Store build's home-screen name; "Bridge" is taken), put its App ID and Client Token in the
build, and bring photos back into Bridge Pro.

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
6. **API key for CI:** Users and Access > Integrations > App Store Connect API > Team Keys > generate a key
   with the **Admin** role (the upload's cloud signing creates the distribution certificate, which an
   App Manager key can't do). Then run `glasses/setup-appstore-secrets.ps1`, which stores `ASC_KEY_ID`,
   `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` and `APPLE_TEAM_ID` in the `appstore` environment, which only
   main can use (so the upload runs from main only).
7. **Meta:** nothing for now; the App Store build has no glasses (see above).
8. **Upload:** Actions > Glasses App Store upload > Run workflow. The build appears in TestFlight in about 15 minutes.
9. **Test on TestFlight**, then add screenshots (below) and submit for review.

## Listing

- **Name:** Bridge: Voice for Code Agents (if taken: Talk to Bridge Relay)
- **Subtitle:** Talk to your coding agents
- **Category:** Developer Tools (secondary: Productivity)
- **Age rating:** 4+ (no objectionable content; answers come from the user's own agents)
- **Price:** Free, with Bridge Pro in-app subscription
- **Privacy policy URL:** https://talktobridge.com/privacy.html
- **Support URL:** https://talktobridge.com/support.html
- **Marketing URL:** https://talktobridge.com/
- **Keywords (100 max):** voice,coding,agents,developer,hands-free,airpods,headset,bluetooth,shortcuts,siri,claude
- **Promotional text:** Run your coding agents from anywhere: talk, hear the answer, keep your hands free.

**Description:**

Bridge lets you talk to your Claude agents hands-free, through AirPods or any Bluetooth headset.
Your agents run in Bridge Cloud, so all you need is your iPhone and a Bridge account.

Say "in my project, add a stop-loss check". Bridge reads the task back, and when you say "send it",
your agent starts work. When it's done, or needs a yes or no from you, it calls you.

- Hands-free: start with Siri ("Talk to Bridge"), the Action Button or Shortcuts
- Read-back before anything is sent, so a misheard word never starts the wrong task
- Hear your agents' answers as they arrive, and answer their questions by voice
- Agents can call you: with a headset connected, a message rings like a phone call
- Works from Claude too: add Bridge as a connector in any Claude app
- Private: Sign in with Apple, no email address, no ads, no tracking; delete your account in the app

Bridge Pro:
- A natural cloud voice for replies
- The Ask Bridge action for Shortcuts and automations

Bridge Pro is an auto-renewing subscription, monthly or yearly, with a 1-week free trial. Payment
is charged to your Apple ID. It renews unless cancelled at least 24 hours before the end of the
period; manage or cancel it in Settings > Apple ID > Subscriptions.
Terms: https://talktobridge.com/terms.html

Not affiliated with Anthropic.

## App Review notes (paste into "Notes" under App Review Information)

Bridge is a voice front end for the user's Claude agents, which run in Bridge Cloud. To review it:

1. Open Settings > Connection > Demo for sample replies (no account needed). Signing in with Apple
   in Settings > Account selects Bridge Cloud. Don't submit until Bridge Cloud agents are live
   (cloud/DESIGN.md build step 4); until then a cloud task only answers that agents aren't on yet.
2. Tap "Talk now" and allow the microphone and speech recognition.
3. Say "in demo, write a test". Bridge reads it back. Say "send it". Then say "goodbye".

Subscriptions can be tested in the sandbox from the Bridge Pro section.

Background audio is used only during a conversation the user starts: the app keeps listening
through the headset microphone while an agent works, and speaks its answer, until the user
says "goodbye" or the conversation times out.

## Privacy "nutrition label"

Must match https://talktobridge.com/privacy.html and `PrivacyInfo.xcprivacy`. No tracking.

- **Identifiers > User ID:** linked to the user, app functionality (the Sign in with Apple identifier).
- **Purchases > Purchase history:** linked, app functionality (Bridge Pro transactions checked by Bridge Cloud).
- **User content > Other user content:** linked, app functionality (task text and agents' messages).
- **Identifiers > Device ID:** linked, app functionality (the app's per-install ID and push tokens, to deliver agents' calls and notifications).
- **Usage data > Product interaction:** linked, app functionality (daily natural-voice characters, kept 3 days, for limits).
- **Diagnostics > Crash data, Performance data, Other diagnostic data:** not linked, app functionality (Sentry).

Not collected: contact info (no email is requested; the first name stays on the phone), audio,
location.

## Screenshots

Required: 6.9" iPhone (1320 x 2868). Take them on the iPhone (Bridge settings with demo on, a
conversation transcript, the Bridge Pro sheet) and add them in App Store Connect.

## Review risks to know

- **Ongoing value (guideline 3.1.2):** Apple sometimes rejects subscriptions that only unlock
  features. If that happens, switch Pro to a one-time non-consumable purchase in `Store.swift`.
- **Account (2.1):** the reviewer signs in with Apple, or uses the demo, plus the video above.
- **MFi accessory protocol:** see step 7.
