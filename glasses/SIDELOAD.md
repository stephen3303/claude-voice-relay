## Install on your iPhone (from Windows)

The IPA is unsigned. Sideloadly, Impactor or AltStore signs it with your Apple ID when it installs it.

**Sideloadly**
1. Install iTunes and iCloud from apple.com (not the Microsoft Store versions), then Sideloadly.
2. Plug the iPhone in with a cable, unlock it and tap Trust.
3. Download `GlassesRelay.ipa` from this release and drag it into Sideloadly.
4. Enter your Apple ID and click Start. Leave the bundle ID as `com.smitherman.glassesrelay`
   so the Meta AI app still finds Bridge.
5. On the iPhone: Settings > General > VPN & Device Management, tap your Apple ID, then Trust.
6. Turn on Developer Mode if iOS asks (Settings > Privacy & Security > Developer Mode) and restart.

**Impactor** ([github.com/claration/Impactor](https://github.com/claration/Impactor/releases)):
use version 2.7.1 or newer. Apple stopped accepting the sign-in that older versions send, so they
fail to log in to your Apple ID (HTTP 503, error -80045 or a "Plist error"). Install the Windows
x86_64 setup, sign in with your Apple ID, then drop in the IPA and install. If sign-in still fails,
reset its anisette data in settings and try again; the Impactor check workflow in this repo shows
whether Apple is accepting Impactor's sign-in at all.

**AltStore**: install AltServer on the PC, install AltStore on the iPhone from it, then open the IPA
in AltStore (My Apps > +).

A free Apple ID's signature lasts 7 days; reinstall (or let AltStore refresh) before then. A paid
developer account's lasts a year. Installing over the old copy keeps your settings.

## What doesn't work sideloaded

- **Push notifications and CallKit calls** (agents calling you when they need you) need the push
  entitlement, which only an App Store Connect signed build carries. Use a TestFlight build for
  those. Sideloaded, Bridge still hears agent replies while a conversation is open.
- Everything else works: "Hey Meta, start Bridge", the read-back, photos, Shortcuts and Siri.
