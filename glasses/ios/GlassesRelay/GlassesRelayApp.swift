import SwiftUI
import MWDATCore

@main
struct GlassesRelayApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate   // push tokens (Push.swift)
    @StateObject private var glasses = GlassesController.shared

    init() {
        // The toolkit must be configured once, before anything touches Wearables.shared.
        // If it fails (or on the simulator), Wearables.shared must never be touched: the toolkit
        // traps on access. The app still works for voice; the glasses features say why they're off.
        do {
            try Wearables.configure()
            GlassesController.toolkitReady = true
        } catch {
            print("Wearables.configure failed: \(error)")
            GlassesController.toolkitError = "\(error)"
        }
        // CI launches the simulator with -screenshots to take the App Store screenshots.
        if CommandLine.arguments.contains("-screenshots") { Self.seedScreenshots() }
    }

    /// A believable demo screen: demo relay, and a finished exchange in the transcript.
    @MainActor private static func seedScreenshots() {
        // The simulator has no glasses or toolkit, so show the state a set-up user sees.
        GlassesController.screenshotMode = true
        Relay.shared.baseURL = "https://my-pc.tail1234.ts.net"
        Relay.shared.token = "screenshot-token"
        let glasses = GlassesController.shared
        glasses.registration = "Registered"
        glasses.deviceCount = 1
        glasses.cameraAllowed = true
        glasses.conversation.phase = .listening
        glasses.conversation.transcript = [
            ("You", "In trading bot, add a stop-loss check to the order router"),
            ("Relay", "I heard: add a stop-loss check to the order router. That goes to trading bot. Say send it, or say the task again."),
            ("You", "Send it"),
            ("Relay", "Sent."),
            ("Agent", "trading bot: Added the stop-loss check and a test for it, and pushed. Want me to lower the default to two percent?"),
            ("You", "Yes"),
        ]
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(glasses)
                .environmentObject(glasses.conversation)
                .task { await glasses.start() }
                // Renew the Bridge Cloud session in its last week, or sign out if the Apple ID was revoked.
                .task { await Account.shared.check() }
                // Meta AI calls back into the app after registration; only its links go to the toolkit.
                .onOpenURL { url in
                    guard URLComponents(url: url, resolvingAgainstBaseURL: false)?
                        .queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
                    guard GlassesController.toolkitReady else { return }
                    Task {
                        do { _ = try await Wearables.shared.handleUrl(url) }
                        catch { glasses.lastError = "Meta AI callback failed: \(error)" }
                    }
                }
        }
    }
}
