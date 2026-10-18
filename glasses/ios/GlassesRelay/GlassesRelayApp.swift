import SwiftUI
import MWDATCore

@main
struct GlassesRelayApp: App {
    #if APP_STORE
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate   // push tokens (Push.swift)
    #endif
    @StateObject private var glasses = GlassesController.shared

    init() {
        ErrorReporting.start()
        Conversation.noteNaturalVoiceBefore()
        // The toolkit must be configured once, before anything touches Wearables.shared.
        // If it fails (or on the simulator), Wearables.shared must never be touched: the toolkit
        // traps on access. The app still works for voice; the glasses features say why they're off.
        do {
            try Wearables.configure()
            GlassesController.toolkitReady = true
        } catch {
            print("Wearables.configure failed: \(error)")
            GlassesController.toolkitError = "\(error)"
            ErrorReporting.report(error, "Wearables.configure")
        }
        // CI launches the simulator with -screenshots to take the App Store screenshots.
        if CommandLine.arguments.contains("-screenshots") { Self.seedScreenshots() }
    }

    /// A believable demo screen: demo relay, and a finished exchange in the transcript.
    @MainActor private static func seedScreenshots() {
        // The simulator has no glasses or toolkit, so show the state a set-up user sees.
        GlassesController.screenshotMode = true
        UserDefaults.standard.set(true, forKey: "welcomed")
        Relay.shared.baseURL = "https://my-pc.tail1234.ts.net"
        Relay.shared.token = "screenshot-token"
        let glasses = GlassesController.shared
        glasses.registration = "Registered"
        glasses.deviceCount = 1
        glasses.cameraAllowed = true
        glasses.conversation.phase = .listening
        glasses.conversation.transcript = [
            ("You", "In trading bot, add a stop-loss check to the order router"),
            ("Relay", "Here's your message to Claude for trading bot, add a stop-loss check to the order router. Ready to send it?"),
            ("You", "Send"),
            ("Relay", "Sent."),
            ("Agent", "Added the stop-loss check and a test for it, and pushed. Want me to lower the default to two percent?"),
            ("You", "Yes"),
        ]
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(glasses)
                .environmentObject(glasses.conversation)
                .task { await glasses.start() }
                #if APP_STORE
                .task { await Account.shared.check() }
                #endif
                // Meta AI calls back into the app after registration; only its links go to the toolkit.
                .onOpenURL { url in
                    guard URLComponents(url: url, resolvingAgainstBaseURL: false)?
                        .queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
                    guard GlassesController.toolkitReady else { return }
                    Task {
                        do { _ = try await Wearables.shared.handleUrl(url) }
                        catch { glasses.lastError = "Meta AI callback failed: \(error)"; ErrorReporting.report(error, "Meta AI callback") }
                    }
                }
        }
    }
}

/// The main screen, after the App Store build's one-time welcome (Sign in with Apple).
struct RootView: View {
    @AppStorage("welcomed") private var welcomed = false

    var body: some View {
        #if APP_STORE
        if welcomed { HomeView() } else { WelcomeView { welcomed = true } }
        #else
        HomeView()
        #endif
    }
}
