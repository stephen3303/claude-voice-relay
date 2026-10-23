import Combine
import Foundation
#if APP_STORE
import StoreKit
#endif

/// Bridge Pro: Bridge Cloud's natural voice and the Ask Shortcuts action (plus glasses photos and Look where the build
/// has the glasses toolkit). Voice conversations stay free.
/// The personal (sideloaded) build has everything unlocked; only the App Store build sells Pro.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    #if APP_STORE
    /// Must match the auto-renewable subscriptions in App Store Connect (one subscription group).
    static let productIDs = ["com.talktobridge.bridge.pro.monthly", "com.talktobridge.bridge.pro.yearly"]
    static let privacyURL = URL(string: "https://talktobridge.com/privacy.html")!
    static let termsURL = URL(string: "https://talktobridge.com/terms.html")!

    @Published private(set) var isPro = false
    private var updates: Task<Void, Never>?
    #else
    /// The self-hosted app's privacy notes and licence, in the public relay repo.
    static let privacyURL = URL(string: "https://github.com/stephen3303/bridge-relay#privacy")!
    static let termsURL = URL(string: "https://github.com/stephen3303/bridge-relay/blob/main/LICENSE")!

    @Published private(set) var isPro = true
    #endif

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
        var latest: (jws: String, expires: Date)?
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, Self.productIDs.contains(t.productID), t.revocationDate == nil {
                active = true
                let expires = t.expirationDate ?? .distantFuture
                if latest == nil || expires > latest!.expires { latest = (result.jwsRepresentation, expires) }
            }
        }
        isPro = active
        Conversation.noteProForNaturalVoice(active)
        latestTransaction = latest?.jws
        await reportIfNeeded()
        #endif
    }

    #if APP_STORE
    private var latestTransaction: String?
    /// The session and transaction Bridge Cloud last answered for. Keyed by session, so another account (or this one
    /// after signing in again) is told afresh, even if a report from before the sign-out lands late.
    private var reported: String?
    private var lastTry: (key: String, at: Date)?
    private var inFlight: Task<Void, Never>?
    #endif

    /// Bridge Cloud checks Apple's signature on the transaction itself before it unlocks the natural voice and photos.
    /// Until it has answered for this one (offline, a timeout), cloud voice and photo calls try again, briefly so
    /// a spoken reply isn't held up. A refusal (another account's subscription) is an answer: retrying won't change it.
    func reportIfNeeded() async {
        #if APP_STORE
        // A reply or photo right after sign-in waits for the report already on its way, then checks whether that
        // one covered the current session and transaction (it may have started before sign-in).
        if let inFlight { await inFlight.value }
        guard let jws = latestTransaction, let session = Keychain.read(Account.sessionKey) else { return }
        let key = "\(session)|\(jws)"
        // At most one try every 30 s while the cloud doesn't answer, so a slow or failing cloud costs replies little.
        // A new session or transaction (sign-in, purchase, renewal) goes straight away.
        guard key != reported else { return }
        if let last = lastTry, last.key == key, Date().timeIntervalSince(last.at) < 30 { return }
        lastTry = (key, Date())
        let report = Task {
            do {
                try await Relay.shared.cloud("POST", "api/pro", session: session, body: ["transaction": jws], timeout: 4)
                reported = key
            } catch Relay.Failure.http(let code) where code == 400 || code == 409 {
                reported = key
            } catch {}
        }
        inFlight = report
        await report.value
        inFlight = nil
        #endif
    }

    /// The one description of what Pro gives, used in the settings section and the subscription sheet.
    #if APP_STORE
    static let summary = "The natural voice on Bridge Cloud (turn on Natural voice in Settings), and the Ask action for Shortcuts. Voice conversations stay free."
    #else
    static let summary = "Photos from your glasses, the natural voice on Bridge Cloud (turn on Natural voice in Settings), and the Ask and Look actions for Shortcuts. Voice conversations stay free."
    #endif

    enum Locked: LocalizedError {
        case needsPro
        var errorDescription: String? { "That needs Bridge Pro. Open Bridge to start a free trial." }
    }

    func requirePro() throws {
        guard isPro else { throw Locked.needsPro }
    }
}
