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
    @ObservedObject private var store = Store.shared

    var body: some View {
        NavigationStack {
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
                        Task {
                            do { _ = try await Relay.shared.inbox(after: nil, wait: false); testResult = "✓ Relay reachable" }
                            catch { testResult = error.localizedDescription }
                        }
                    }
                    Button("Use demo (no PC needed)") {
                        url = Relay.demoAddress
                        Relay.shared.baseURL = Relay.demoAddress
                        testResult = "Demo on: replies are samples. Enter your PC's address to use your agents."
                    }
                    if !testResult.isEmpty { Text(testResult).font(.footnote) }
                } header: { Text("PC relay") }

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
            }
            .navigationTitle("Bridge")
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
