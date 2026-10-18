import AuthenticationServices
import SwiftUI
import StoreKit

struct ContentView: View {
    @EnvironmentObject var glasses: GlassesController
    @EnvironmentObject var conversation: Conversation
    @State private var url = Relay.shared.baseURL
    @State private var token = Relay.shared.token
    @State private var testResult = ""
    @State private var photoResult = ""
    @State private var showPaywall = false
    @State private var readBack = Conversation.readBack
    @State private var confirmDelete = false
    @ObservedObject private var store = Store.shared
    @ObservedObject private var account = Account.shared
    @ObservedObject private var push = Push.shared

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            Form {
                Section("Glasses") {
                    LabeledContent("Meta AI registration", value: glasses.registration)
                    LabeledContent("Connected glasses", value: "\(glasses.deviceCount)")
                    Button("Connect to Meta AI") { Task { await glasses.register() } }
                    if glasses.cameraAllowed {
                        Button("Test photo") {
                            guard store.isPro else { photoResult = "Photos need Bridge Pro. See Bridge Pro below."; return }
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
                    if let e = glasses.lastError { Text(e).font(.footnote).foregroundStyle(.red) }
                }
                Section {
                    TextField("https://your-pc.your-tailnet.ts.net", text: $url)
                        .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                    SecureField("VOICE_TOKEN from the relay's .env", text: $token)
                    Button("Save and test") {
                        Relay.shared.baseURL = url.trimmingCharacters(in: .whitespaces)
                        Relay.shared.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
                        push.refresh()
                        Task {
                            do { _ = try await Relay.shared.inbox(after: nil, wait: false); testResult = "✓ Relay reachable" }
                            catch { testResult = error.localizedDescription }
                        }
                    }
                    Button("Use demo (no PC needed)") {
                        url = Relay.demoAddress
                        Relay.shared.baseURL = Relay.demoAddress
                        push.refresh()
                        testResult = "Demo on: replies are samples. Enter your PC's address to use your agents."
                    }
                    if !testResult.isEmpty { Text(testResult).font(.footnote) }
                } header: { Text("PC relay") }

                Section("Bridge Cloud") {
                    if account.signedIn {
                        LabeledContent("Account", value: account.name.isEmpty ? "Signed in" : account.name)
                        if url == Relay.cloudAddress {
                            Toggle("Agents can call me", isOn: $push.callsAllowed)
                            Text("With glasses or headphones connected, an agent that wants you rings like a phone call. Otherwise you get a notification.")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button("Test call") { Task { await push.testCall() } }
                        } else {
                            Button("Use Bridge Cloud") {
                                url = Relay.cloudAddress
                                Relay.shared.baseURL = Relay.cloudAddress
                                push.refresh()
                            }
                        }
                        Button("Sign out") { account.signOut(); url = Relay.shared.baseURL }
                        Button("Delete account", role: .destructive) { confirmDelete = true }
                            .confirmationDialog("Delete your Bridge Cloud account and everything stored for it?",
                                                isPresented: $confirmDelete, titleVisibility: .visible) {
                                Button("Delete account", role: .destructive) {
                                    Task { await account.deleteAccount(); url = Relay.shared.baseURL }
                                }
                            }
                    } else {
                        SignInWithAppleButton(.signIn) { $0.requestedScopes = [.fullName] } onCompletion: { result in
                            Task { await account.completed(result) }
                        }
                        .frame(height: 44)
                    }
                    if !push.status.isEmpty { Text(push.status).font(.footnote) }
                    if let e = account.error { Text(e).font(.footnote).foregroundStyle(.red) }
                }

                Section("Bridge Pro") {
                    LabeledContent("Status", value: store.isPro ? "Active" : "Not subscribed")
                    if !store.isPro {
                        Text(Store.summary).font(.footnote)
                        Button("Start free trial") { showPaywall = true }
                    }
                }

                Section("Conversation — \(conversation.phase.rawValue)") {
                    if conversation.phase == .idle {
                        #if APP_STORE
                        Button("Talk now") { conversation.begin(trigger: .button) }
                        #else
                        Button("Talk now (without Hey Meta)") { conversation.begin(trigger: .button) }
                        #endif
                    } else {
                        Button("End", role: .destructive) { conversation.end(saying: nil) }
                    }
                    Toggle("Read back what I said", isOn: $readBack)
                        .onChange(of: readBack) { _, on in Conversation.readBack = on }
                    if !conversation.status.isEmpty { Text(conversation.status).font(.footnote).foregroundStyle(.secondary) }
                    if !conversation.transcript.isEmpty {
                        Button("Clear history", role: .destructive) { conversation.transcript = [] }
                    }
                    ForEach(Array(conversation.transcript.enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading) {
                            Text(line.who).font(.caption).foregroundStyle(.secondary)
                            Text(line.text)
                        }
                    }
                }
                .id("conversation")
            }
            .navigationTitle("Bridge")
            // CI's App Store screenshot of the conversation.
            .task {
                guard CommandLine.arguments.contains("-scroll-conversation") else { return }
                try? await Task.sleep(for: .milliseconds(500))
                proxy.scrollTo("conversation", anchor: .top)
            }
            .sheet(isPresented: $showPaywall) {
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
                    if store.isPro { showPaywall = false }
                }
            }
            }
        }
    }
}
