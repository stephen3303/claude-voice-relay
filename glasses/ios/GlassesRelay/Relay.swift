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

    struct Inbox: Decodable { let boot: Double; let last: Int; let messages: [Message] }
    struct Message: Decodable { let id: Int; let text: String; let age: Int }

    enum Failure: LocalizedError {
        case notConfigured, http(Int)
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Open the app and set your relay address and token."
            case .http(401): return "The relay rejected the token."
            case .http(let code): return "The relay answered with error \(code)."
            }
        }
    }

    /// One utterance through the read-back step. Returns the line to speak.
    func say(_ text: String) async throws -> String {
        var req = try request("voice/confirm", timeout: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["text": text])
        let data = try await fetch(req)
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A glasses photo plus what was said with it. Returns the line to speak.
    func photo(_ jpeg: Data, said: String) async throws -> String {
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
        var query: [String] = []
        if let after { query.append("after=\(after)") }
        if !wait { query.append("wait=0") }
        let path = "voice/inbox" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        return try JSONDecoder().decode(Inbox.self, from: try await fetch(try request(path, timeout: 40)))
    }

    private func request(_ path: String, timeout: TimeInterval) throws -> URLRequest {
        let base = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        guard !base.isEmpty, !token.isEmpty, let url = URL(string: "\(base)/\(path)") else { throw Failure.notConfigured }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
    static func write(_ key: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock  // readable while the phone is locked in your pocket
        SecItemAdd(add as CFDictionary, nil)
    }
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
