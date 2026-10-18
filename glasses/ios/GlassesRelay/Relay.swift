import Foundation
import Security

/// Talks to relay.mjs on your PC: /voice/confirm (the same read-back step the Shortcut uses)
/// and /voice/inbox (what your agents have said since).
final class Relay {
    static let shared = Relay()

    var baseURL: String {
        get { UserDefaults.standard.string(forKey: "relayURL") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "relayURL") }
    }
    /// The relay's VOICE_TOKEN, in the Keychain. A re-signed sideloaded build can be refused Keychain access
    /// (errSecMissingEntitlement), so it then falls back to app storage rather than losing the token.
    var token: String {
        get { Keychain.read("relayToken") ?? UserDefaults.standard.string(forKey: "relayTokenFallback") ?? "" }
        set {
            if Keychain.write("relayToken", newValue) {
                UserDefaults.standard.removeObject(forKey: "relayTokenFallback")
            } else {
                UserDefaults.standard.set(newValue, forKey: "relayTokenFallback")
            }
        }
    }

    /// What the user typed as the PC's address, made usable: trimmed, https:// added when there's no scheme,
    /// trailing slash dropped. "" when nothing was typed.
    static func normalized(_ address: String) -> String {
        var a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty || a == demoAddress || a == cloudAddress { return a }
        if !a.contains("://") { a = "https://" + a }
        while a.hasSuffix("/") { a.removeLast() }
        return a
    }

    struct Inbox: Decodable { let boot: Double; let last: Int; let messages: [Message] }
    struct Message: Decodable { let id: Int; let text: String; let age: Int }

    enum Failure: LocalizedError {
        case notConfigured, noAddress, badAddress, noToken, http(Int)
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Open Bridge settings and choose how to connect."
            case .noAddress: return "Enter your PC's address in Bridge settings."
            case .badAddress: return "That PC address isn't a web address. It should look like https://your-pc.your-tailnet.ts.net."
            case .noToken: return "Enter the relay's VOICE_TOKEN in Bridge settings."
            case .http(401): return "The relay rejected the token."
            case .http(let code): return "The relay answered with error \(code)."
            }
        }
    }

    /// "Use demo" sets this address: sample replies, no PC needed (for trying the app, and App Review).
    static let demoAddress = "demo"
    var isDemo: Bool { baseURL == Self.demoAddress }
    /// "Bridge Cloud" sets this address: the signed-in account's cloud API instead of a PC (App Store build).
    static let cloudAddress = "cloud"
    var isCloud: Bool { baseURL == Self.cloudAddress }
    private var demoHeld: String?

    /// One utterance through the read-back step, or straight to the agents with `readBack` off.
    /// Returns the line to speak.
    func say(_ text: String, readBack: Bool = true) async throws -> String {
        if isDemo { return readBack ? demoReply(text) : "Sent." }
        var req = try request(readBack ? "voice/confirm" : "voice/send", timeout: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["text": text])
        let data = try await fetch(req)
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// MP3 of `text` in the relay's cloud voice. Throws when the relay has no TTS key or the call fails.
    func speech(_ text: String) async throws -> Data {
        if isDemo || isCloud { throw Failure.http(503) }   // phone voice
        var req = try request("voice/tts", timeout: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["text": text])
        return try await fetch(req)
    }

    /// A glasses photo plus what was said with it. Returns the line to speak.
    func photo(_ jpeg: Data, said: String) async throws -> String {
        if isDemo { return "Demo mode: on your PC, Claude would look at this photo and answer. The photo was \(jpeg.count / 1024) kilobytes." }
        var req = try request("voice/photo", timeout: 150)
        req.httpMethod = "POST"
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        req.setValue(said.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "", forHTTPHeaderField: "X-Question")
        req.httpBody = jpeg
        let data = try await fetch(req)
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Messages after `after` (nil = from now). With `wait`, the relay holds the request up to 25s.
    func inbox(after: Int?, wait: Bool = true) async throws -> Inbox {
        if isDemo {
            if wait { try await Task.sleep(for: .seconds(25)) }
            return Inbox(boot: 1, last: 0, messages: [])
        }
        var query: [String] = []
        if let after { query.append("after=\(after)") }
        if !wait { query.append("wait=0") }
        let path = "voice/inbox" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        return try JSONDecoder().decode(Inbox.self, from: try await fetch(try request(path, timeout: 40)))
    }

    /// The same read-back flow as the relay, with canned answers.
    private func demoReply(_ text: String) -> String {
        let body = text.replacingOccurrences(of: #"^task:\s*"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " .!?"))
        let lower = body.lowercased()
        if ["send it", "go ahead", "do it", "yes"].contains(lower) {
            guard demoHeld != nil else { return "Nothing is waiting to send. Say the task again." }
            demoHeld = nil
            return "Sent. In demo mode no agent runs; with your PC connected, its answer is read to you here."
        }
        if lower == "cancel" { demoHeld = nil; return "Cancelled. Nothing sent." }
        if lower == "status" { return "Demo mode. Connect your PC's relay to hear your agents' status." }
        demoHeld = body
        return "I heard: \(body). Say send it, or say it again."
    }

    /// A Bridge Cloud call outside the voice protocol (push registration, ending a conversation),
    /// with the Bridge session, or `session` when the Keychain no longer holds it (signing out).
    @discardableResult
    func cloud(_ method: String, _ path: String, session: String? = nil, body: [String: Any]? = nil,
               timeout: TimeInterval = 15) async throws -> Data {
        guard let bearer = session ?? Keychain.read(Account.sessionKey), let url = URL(string: "\(Account.cloudURL)/\(path)")
        else { throw Failure.notConfigured }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await fetch(req)
    }

    /// The conversation ended: Bridge Cloud can ring the phone again straight away.
    func stoppedListening() async {
        guard isCloud else { return }
        try? await cloud("DELETE", "api/voice/listening", timeout: 5)
    }

    private func request(_ path: String, timeout: TimeInterval) throws -> URLRequest {
        let base: String, bearer: String
        if isCloud {
            // Same protocol under /api, with the Bridge session instead of the relay's token.
            base = Account.cloudURL + "/api"
            bearer = Keychain.read(Account.sessionKey) ?? ""
            guard !bearer.isEmpty else { throw Failure.notConfigured }
        } else {
            base = Self.normalized(baseURL)
            bearer = token
            guard !base.isEmpty else { throw Failure.noAddress }
            guard !bearer.isEmpty else { throw Failure.noToken }
        }
        guard let url = URL(string: "\(base)/\(path)"), url.host != nil else { throw Failure.badAddress }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        return req
    }

    private func fetch(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure.http(code) }
        return data
    }
}

enum Keychain {
    /// False when the Keychain refused the item (for example a re-signed build without a keychain group).
    @discardableResult
    static func write(_ key: String, _ value: String) -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock  // readable while the phone is locked in your pocket
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    static func delete(_ key: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key] as CFDictionary)
    }
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
