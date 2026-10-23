// App Store build only: the first-launch Sign in with Apple screen (not in the public relay repo).
#if APP_STORE
import SwiftUI
import AuthenticationServices

/// First launch of the App Store build: what Bridge does, and Sign in with Apple. An account is
/// only needed for Bridge Cloud, so "Continue without an account" goes on to My PC or Demo.
struct WelcomeView: View {
    var done: () -> Void
    @ObservedObject private var account = Account.shared
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Image("LaunchLogo")
                .resizable().scaledToFit().frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 22))
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text("Welcome to Bridge").font(.largeTitle.bold())
                Text("Talk to your Claude agents hands-free, through AirPods, any Bluetooth headset or your iPhone.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 16) {
                Feature(symbol: "waveform", title: "Hands-free", text: "Say \"Hey Siri, talk to Bridge\" and speak your task.")
                Feature(symbol: "bubble.left.and.text.bubble.right", title: "Answers out loud", text: "Your agents' replies are read to you as they arrive.")
                Feature(symbol: "phone", title: "Agents call you", text: "When an agent needs you, it rings like a phone call.")
            }
            Spacer()
            VStack(spacing: 12) {
                SignInWithAppleButton(.continue) { $0.requestedScopes = [.fullName] } onCompletion: { result in
                    Task {
                        await account.completed(result)
                        if account.signedIn { Relay.shared.baseURL = Relay.cloudAddress; done() }
                    }
                }
                .signInWithAppleButtonStyle(scheme == .dark ? .white : .black)
                .frame(height: 50)
                if let e = account.error { Text(e).font(.footnote).foregroundStyle(.red) }
                Button("Continue without an account", action: done)
                    .font(.subheadline)
            }
        }
        .padding(28)
    }
}

private struct Feature: View {
    let symbol: String, title: String, text: String
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol).font(.title2).foregroundStyle(Color.accentColor).frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(text).foregroundStyle(.secondary)
            }
        }
    }
}
#endif
