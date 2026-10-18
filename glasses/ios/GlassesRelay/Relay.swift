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
    var token: String {
        get { Keychain.read("relayToken") ?? "" }
        set { Keychain.write("relayToken", newValue) }
    }

    /// The PC address as typed, made usable: trimmed, https:// added when no scheme was typed, trailing
    /// slashes dropped. "" when nothing was typed; nil when it isn't an https address with a host.
    static func pcAddress(_ typed: String) -> String? {
        var a = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return "" }
        if a.range(of: "^[a-z][a-z0-9+.-]*:/", options: [.regularExpression, .caseInsensitive]) == nil { a = "https://" + a }
        while a.hasSuffix("/") { a.removeLast() }
        guard let c = URLComponents(string: a), c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty
        else { return nil }
        return a
    }

    struct Inbox: Decodable { let boot: Double; let last: Int; let messages: [Message] }
    struct Message: Decodable { let id: Int; let text: String; let age: Int }

    enum Failure: LocalizedError {
        case notConfigured, noAddress, badAddress, noToken, locked, keychain(OSStatus), http(Int)
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Open Bridge settings and choose how to connect."
            case .noAddress: return "Enter your PC's address in Bridge settings."
            case .badAddress: return "That PC address isn't a web address. It should look like https://your-pc.your-tailnet.ts.net."
            case .noToken: return "Enter the relay's VOICE_TOKEN in Bridge settings."
            case .locked: return "Unlock your phone once, then try again."
            case .keychain(let status): return "The iPhone Keychain refused the token (error \(status))."
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
            guard let address = Self.pcAddress(baseURL) else { throw Failure.badAddress }   // also tidies older saved values
            guard !address.isEmpty else { throw Failure.noAddress }
            base = address
            switch Keychain.lookup("relayToken") {
            case .found(let value): bearer = value
            case .missing: throw Failure.noToken
            case .locked: throw Failure.locked
            case .failed(let status): throw Failure.keychain(status)
            }
        }
        guard let url = URL(string: "\(base)/\(path)") else { throw Failure.badAddress }
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
    enum Lookup { case found(String), missing, locked, failed(OSStatus) }

    /// Saves `value`, replacing what's there, and returns the Keychain's status (errSecSuccess when saved).
    /// The old value is only removed once the new one is in, so a failed save keeps the previous token.
    @discardableResult
    static func write(_ key: String, _ value: String) -> OSStatus {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        let attrs: [String: Any] = [kSecValueData as String: Data(value.utf8),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]  // readable while the phone is locked in your pocket
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        return SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil)
    }
    static func delete(_ key: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key] as CFDictionary)
    }
    static func read(_ key: String) -> String? {
        if case .found(let value) = lookup(key) { return value }
        return nil
    }
    /// Like `read`, but says why nothing came back: no item, the phone not unlocked since it started, or another error.
    static func lookup(_ key: String) -> Lookup {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let d = out as? Data, let value = String(data: d, encoding: .utf8), !value.isEmpty else { return .missing }
            return .found(value)
        case errSecItemNotFound: return .missing
        case errSecInteractionNotAllowed: return .locked
        default: return .failed(status)
        }
    }
}
