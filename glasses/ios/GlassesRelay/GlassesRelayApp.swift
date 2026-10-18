import SwiftUI
import MWDATCore

@main
struct GlassesRelayApp: App {
    @StateObject private var glasses = GlassesController.shared

    init() {
        // The toolkit must be configured once, before anything touches Wearables.shared.
        do { try Wearables.configure() } catch { print("Wearables.configure failed: \(error)") }
        // CI launches the simulator with -screenshots to take the App Store screenshots.
        if CommandLine.arguments.contains("-screenshots") { Self.seedScreenshots() }
    }

    /// A believable demo screen: demo relay, and a finished exchange in the transcript.
    @MainActor private static func seedScreenshots() {
        Relay.shared.baseURL = Relay.demoAddress
        GlassesController.shared.conversation.transcript = [
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
                // Meta AI calls back into the app after registration; only its links go to the toolkit.
                .onOpenURL { url in
                    guard URLComponents(url: url, resolvingAgainstBaseURL: false)?
                        .queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
                    Task {
                        do { _ = try await Wearables.shared.handleUrl(url) }
                        catch { glasses.lastError = "Meta AI callback failed: \(error)" }
                    }
                }
        }
    }
}
