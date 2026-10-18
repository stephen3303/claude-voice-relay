## Install on your iPhone (from Windows)

**Coming from a build before 18 October 2026** (the app ID changed then): delete that app
first. The new one installs as a separate app, both answer `glassesrelay://` links, and nothing carries
over, so afterwards enter the PC address and token again and connect to Meta AI again.

The IPA is unsigned. Sideloadly, Impactor or AltStore signs it with your Apple ID when it installs it.

**Sideloadly**
1. Install iTunes and iCloud from apple.com (not the Microsoft Store versions), then Sideloadly.
2. Plug the iPhone in with a cable, unlock it and tap Trust.
3. Download `GlassesRelay.ipa` from this release and drag it into Sideloadly.
4. Enter your Apple ID and click Start. Leave the bundle ID as `com.talktobridge.bridge`:
   it's the one registered with Meta, so the Meta AI app only finds Bridge under it.
5. On the iPhone: Settings > General > VPN & Device Management, tap your Apple ID, then Trust.
6. Turn on Developer Mode if iOS asks (Settings > Privacy & Security > Developer Mode) and restart.

**Impactor** ([github.com/claration/Impactor](https://github.com/claration/Impactor/releases)):
use version 2.7.1 or newer. Apple stopped accepting the sign-in that versions before 2.7.1 send, so
they fail to log in to your Apple ID (HTTP 503, error -80045 or a "Plist error").
1. Install the Windows x86_64 setup, then plug the iPhone in, unlock it and tap Trust.
2. Sign in with your Apple ID, drop in `GlassesRelay.ipa` and install. Keep the bundle ID as
   `com.talktobridge.bridge` so the Meta AI app finds Bridge.
3. Then do Sideloadly steps 5 and 6 on the iPhone.

If sign-in still fails, use Settings > Reset Anisette Data in Impactor and try again. The Impactor
check workflow in this repo shows whether Apple accepts Impactor's sign-in at all.

**AltStore**: install AltServer on the PC, install AltStore on the iPhone from it, then open the IPA
in AltStore (My Apps > +).

A free Apple ID's signature lasts 7 days; reinstall (or let AltStore refresh) before then. A paid
developer account's lasts a year. Installing over the old copy keeps your settings.

## What doesn't work sideloaded

- **Push notifications and CallKit calls** (agents calling you when they need you) need the push
  entitlement, which only an App Store Connect signed build carries. Use a TestFlight build for
  those. Sideloaded, Bridge still hears agent replies while a conversation is open.
- Everything else works: "Hey Meta, start Bridge", the read-back, photos, Shortcuts and Siri.
