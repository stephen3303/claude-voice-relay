import SwiftUI
import StoreKit
import AuthenticationServices

/// Settings, opened from the main screen's gear: account, connection, glasses, voice, Bridge Pro, about.
struct SettingsView: View {
    @EnvironmentObject var glasses: GlassesController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @ObservedObject private var store = Store.shared
    @ObservedObject private var account = Account.shared
    @ObservedObject private var push = Push.shared
    @AppStorage("relayURL") private var relayURL = ""
    @State private var url = Relay.shared.isDemo || Relay.shared.isCloud ? "" : Relay.shared.baseURL
    @State private var token = Relay.shared.token
    @State private var testResult = ""
    @State private var photoResult = ""
    @State private var readBack = Conversation.readBack
    @State private var showPaywall = false
    @State private var showManage = false
    @State private var confirmDelete = false

    private enum Mode: String { case cloud, pc, demo }
    private var mode: Binding<Mode> {
        Binding {
            switch relayURL {
            case Relay.cloudAddress: return .cloud
            case Relay.demoAddress: return .demo
            default: return .pc
            }
        } set: { m in
            switch m {
            case .cloud: relayURL = Relay.cloudAddress
            case .demo: relayURL = Relay.demoAddress
            case .pc: relayURL = Relay.normalized(url)
            }
            testResult = ""
            push.refresh()   // the cloud learns whether it can reach this phone
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                #if APP_STORE
                accountSection
                #endif
                connectionSection
                glassesSection
                Section {
                    Toggle("Read back what I said", isOn: $readBack)
                        .onChange(of: readBack) { _, on in Conversation.readBack = on }
                } header: { Text("Voice") } footer: {
                    Text(readBack
                         ? "Bridge repeats what it heard and waits for \"send it\"."
                         : "Bridge sends what you say after a 2-second pause, without repeating it.")
                }
                #if APP_STORE
                if account.signedIn && mode.wrappedValue == .cloud { callsSection }
                proSection
                #endif
                Section("About") {
                    Link("Privacy policy", destination: Store.privacyURL)
                    Link("Terms of use", destination: Store.termsURL)
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showPaywall) { Paywall { showPaywall = false } }
            .manageSubscriptionsSheet(isPresented: $showManage)
        }
    }

    // MARK: account (App Store build)

    private var accountSection: some View {
        Section {
            if account.signedIn {
                LabeledContent("Signed in", value: account.name.isEmpty ? "With Apple" : account.name)
                Button("Sign out") { account.signOut() }
                Button("Delete account", role: .destructive) { confirmDelete = true }
                    .confirmationDialog("Delete your Bridge account and everything stored for it?",
                                        isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete account", role: .destructive) { Task { await account.deleteAccount() } }
                    }
            } else {
                SignInWithAppleButton(.signIn) { $0.requestedScopes = [.fullName] } onCompletion: { result in
                    Task {
                        await account.completed(result)
                        if account.signedIn { relayURL = Relay.cloudAddress }
                    }
                }
                .signInWithAppleButtonStyle(scheme == .dark ? .white : .black)
                .frame(height: 44)
            }
            if let e = account.error { Text(e).font(.footnote).foregroundStyle(.red) }
        } header: { Text("Account") } footer: {
            Text("An account lets Bridge Cloud run your agents, so you don't need a PC.")
        }
    }

    // MARK: calls (App Store build, Bridge Cloud)

    private var callsSection: some View {
        Section {
            Toggle("Agents can call me", isOn: $push.callsAllowed)
            Button("Test call") { Task { await push.testCall() } }
            if !push.status.isEmpty { Text(push.status).font(.footnote) }
        } header: { Text("Calls") } footer: {
            Text("With glasses or headphones connected, an agent that wants you rings like a phone call. Otherwise you get a notification.")
        }
    }

    // MARK: connection

    private var connectionSection: some View {
        Section {
            Picker("Connect to", selection: mode) {
                #if APP_STORE
                if account.signedIn { Text("Bridge Cloud").tag(Mode.cloud) }
                #endif
                Text("My PC").tag(Mode.pc)
                Text("Demo").tag(Mode.demo)
            }
            switch mode.wrappedValue {
            case .pc:
                TextField("https://your-pc.your-tailnet.ts.net", text: $url)
                    .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                SecureField("VOICE_TOKEN from the relay's .env", text: $token)
                Button("Save and test") {
                    url = Relay.normalized(url)
                    token = token.trimmingCharacters(in: .whitespacesAndNewlines)
                    relayURL = url
                    Relay.shared.baseURL = url   // the test reads this now, not after @AppStorage catches up
                    Relay.shared.token = token
                    test()
                }
            case .cloud:
                Button("Test") { test() }
            case .demo:
                EmptyView()
            }
            if !testResult.isEmpty { Text(testResult).font(.footnote) }
        } header: { Text("Connection") } footer: {
            switch mode.wrappedValue {
            case .pc: Text("Your PC runs the relay. See Help for setting it up.")
            case .cloud: Text("Your agents run on Bridge Cloud.")
            case .demo: Text("Sample replies, so you can try Bridge without a PC.")
            }
        }
    }

    private func test() {
        testResult = "Testing…"
        Task {
            do { _ = try await Relay.shared.inbox(after: nil, wait: false); testResult = "✓ Connected" }
            catch { testResult = error.localizedDescription }
        }
    }

    // MARK: glasses

    private var glassesSection: some View {
        Section("Glasses") {
            LabeledContent("Meta AI", value: glasses.registration)
            LabeledContent("Connected glasses", value: "\(glasses.deviceCount)")
            Button("Connect to Meta AI") { Task { await glasses.register() } }
            if glasses.cameraAllowed {
                Button("Test photo") {
                    guard store.isPro else { photoResult = "Photos need Bridge Pro."; return }
                    photoResult = "Taking a picture…"
                    Task {
                        do {
                            let jpeg = try await glasses.capturePhoto()
                            photoResult = try await Relay.shared.photo(jpeg, said: "What am I looking at?")
                        } catch { photoResult = error.localizedDescription }
                    }
                }
            } else {
                Button("Allow camera") { Task { await glasses.allowCamera() } }
            }
            if !photoResult.isEmpty { Text(photoResult).font(.footnote) }
        }
    }

    // MARK: Bridge Pro (App Store build)

    private var proSection: some View {
        Section {
            LabeledContent("Status", value: store.isPro ? "Active" : "Not subscribed")
            if store.isPro {
                Button("Manage subscription") { showManage = true }
            } else {
                Button("Start free trial") { showPaywall = true }
            }
        } header: { Text("Bridge Pro") } footer: { Text(Store.summary) }
    }
}

/// The subscription sheet: StoreKit's own view, with restore and the policy links App Review asks for.
struct Paywall: View {
    var done: () -> Void
    @ObservedObject private var store = Store.shared

    var body: some View {
        SubscriptionStoreView(productIDs: Store.productIDs) {
            VStack(spacing: 8) {
                Text("Bridge Pro").font(.title.bold())
                Text(Store.summary).multilineTextAlignment(.center)
            }
            .padding()
        }
        .storeButton(.visible, for: .restorePurchases, .cancellation)
        .subscriptionStorePolicyDestination(url: Store.privacyURL, for: .privacyPolicy)
        .subscriptionStorePolicyDestination(url: Store.termsURL, for: .termsOfService)
        .onInAppPurchaseCompletion { _, _ in
            await store.refresh()
            if store.isPro { done() }
        }
    }
}
