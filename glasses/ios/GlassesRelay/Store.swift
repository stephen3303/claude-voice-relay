import StoreKit

/// Bridge Pro: photos and the Ask/Look Shortcuts actions. Voice conversations stay free.
/// The personal (sideloaded) build has everything unlocked; only the App Store build sells Pro.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    /// Must match the auto-renewable subscriptions in App Store Connect (one subscription group).
    static let productIDs = ["com.smitherman.glassesrelay.pro.monthly", "com.smitherman.glassesrelay.pro.yearly"]
    static let privacyURL = URL(string: "https://stephen3303.github.io/claude-voice-relay/privacy.html")!
    static let termsURL = URL(string: "https://stephen3303.github.io/claude-voice-relay/terms.html")!

    #if APP_STORE
    @Published private(set) var isPro = false
    #else
    @Published private(set) var isPro = true
    #endif

    private var updates: Task<Void, Never>?

    private init() {
        #if APP_STORE
        // Renewals, refunds and purchases made on another device arrive here.
        updates = Task { [weak self] in
            for await _ in Transaction.updates { await self?.refresh() }
        }
        Task { await refresh() }
        #endif
    }

    func refresh() async {
        #if APP_STORE
        var active = false
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, Self.productIDs.contains(t.productID), t.revocationDate == nil {
                active = true
            }
        }
        isPro = active
        #endif
    }

    /// The one description of what Pro gives, used in the settings section and the subscription sheet.
    static let summary = "Photos from your glasses, and the Ask and Look actions for Shortcuts. Voice conversations stay free."

    enum Locked: LocalizedError {
        case needsPro
        var errorDescription: String? { "That needs Bridge Pro. Open Bridge to start a free trial." }
    }

    func requirePro() throws {
        guard isPro else { throw Locked.needsPro }
    }
}
