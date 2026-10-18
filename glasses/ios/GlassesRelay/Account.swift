import AuthenticationServices
import Foundation

/// Bridge Cloud account (App Store build): Sign in with Apple, traded at /api/auth/apple for a
/// 30-day Bridge session that Relay sends with cloud requests. The session lives in the Keychain.
@MainActor
final class Account: ObservableObject {
    static let shared = Account()

    /// BridgeApi's ApiUrl (cloud/infra).
    static let cloudURL = "https://cjypa7s397.execute-api.us-east-1.amazonaws.com"
    static let sessionKey = "cloudSession"

    @Published private(set) var signedIn = Keychain.read(sessionKey) != nil
    @Published private(set) var name = UserDefaults.standard.string(forKey: "accountName") ?? ""
    @Published var error: String?

    private var expires: Double {
        get { UserDefaults.standard.double(forKey: "sessionExpires") }
        set { UserDefaults.standard.set(newValue, forKey: "sessionExpires") }
    }

    private init() {}

    /// The Sign in with Apple button's completion.
    func completed(_ result: Result<ASAuthorization, Error>) async {
        error = nil
        switch result {
        case .failure(let e):
            if (e as? ASAuthorizationError)?.code != .canceled { error = e.localizedDescription }
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = cred.identityToken, let token = String(data: tokenData, encoding: .utf8) else {
                error = "Apple didn't return a sign-in token. Try again."; return
            }
            // Apple sends the name only on the first sign-in; keep it.
            if let given = cred.fullName?.givenName, !given.isEmpty { name = given; UserDefaults.standard.set(given, forKey: "accountName") }
            UserDefaults.standard.set(cred.user, forKey: "appleUser")
            do { try await exchange(path: "api/auth/apple", body: ["identityToken": token], bearer: nil) }
            catch { self.error = "Couldn't sign in to Bridge Cloud. \(error.localizedDescription)" }
        }
    }

    /// On launch: sign out if the Apple ID was revoked; renew a session in its last week.
    func check() async {
        guard signedIn else { return }
        if let user = UserDefaults.standard.string(forKey: "appleUser"),
           let state = try? await ASAuthorizationAppleIDProvider().credentialState(forUserID: user),
           state == .revoked || state == .notFound {
            signOut(); return
        }
        if expires - Date().timeIntervalSince1970 < 7 * 86400, let session = Keychain.read(Self.sessionKey) {
            try? await exchange(path: "api/auth/refresh", body: [:], bearer: session)
        }
    }

    func signOut() {
        Keychain.delete(Self.sessionKey)
        UserDefaults.standard.removeObject(forKey: "appleUser")
        expires = 0
        signedIn = false
        if Relay.shared.isCloud { Relay.shared.baseURL = "" }
    }

    /// Removes the account and everything Bridge Cloud stores for it (App Store guideline 5.1.1(v)).
    func deleteAccount() async {
        guard let session = Keychain.read(Self.sessionKey) else { signOut(); return }
        do {
            var req = URLRequest(url: URL(string: "\(Self.cloudURL)/api/account")!)
            req.httpMethod = "DELETE"
            req.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
            let (_, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 || code == 401 else { throw Relay.Failure.http(code) }
            name = ""; UserDefaults.standard.removeObject(forKey: "accountName")
            signOut()
        } catch { self.error = "Couldn't delete the account. \(error.localizedDescription)" }
    }

    private struct Session: Decodable { let token: String; let expires: Double }

    private func exchange(path: String, body: [String: String], bearer: String?) async throws {
        var req = URLRequest(url: URL(string: "\(Self.cloudURL)/\(path)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 && bearer != nil { signOut(); return }
        guard code == 200 else { throw Relay.Failure.http(code) }
        let session = try JSONDecoder().decode(Session.self, from: data)
        Keychain.write(Self.sessionKey, session.token)
        expires = session.expires
        signedIn = true
    }
}
