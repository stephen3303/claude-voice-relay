import SwiftUI
import MWDATCore

@main
struct GlassesRelayApp: App {
    @StateObject private var glasses = GlassesController.shared

    init() {
        // The toolkit must be configured once, before anything touches Wearables.shared.
        do { try Wearables.configure() } catch { print("Wearables.configure failed: \(error)") }
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
