import SwiftUI
#if APP_STORE
import StoreKit
import AuthenticationServices
#endif
import Security
import AVFoundation

/// Settings, opened from the main screen's gear: account, connection, glasses, voice, Bridge Pro, about.
struct SettingsView: View {
    @EnvironmentObject var glasses: GlassesController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @ObservedObject private var store = Store.shared
    #if APP_STORE
    @ObservedObject private var account = Account.shared
    @ObservedObject private var push = Push.shared
    #endif
    @AppStorage("relayURL") private var relayURL = ""
    @State private var url = Relay.shared.isDemo || Relay.shared.isCloud ? "" : Relay.shared.baseURL
    @State private var token = Relay.shared.token
    @State private var testResult = ""
    @State private var photoResult = ""
    @State private var readBack = Conversation.readBack
    @State private var wakeWord = Conversation.wakeWord
    @State private var answerWindow = Conversation.answerWindow
    @State private var hangUpAfter = Conversation.hangUpAfter
    // A deleted voice falls back to the best installed one; show that rather than a blank picker.
    @State private var voiceID = Conversation.voices.contains { $0.identifier == Conversation.voiceID } ? Conversation.voiceID : ""
    @State private var hiFi = Conversation.hiFiSpeech
    @State private var natural = Conversation.naturalVoice
    @State private var previewer = AVSpeechSynthesizer()
    #if APP_STORE
    @State private var showPaywall = false
    @State private var showManage = false
    @State private var confirmDelete = false
    #endif

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
            case .pc: relayURL = Relay.pcAddress(url) ?? ""
            }
            testResult = ""
            #if APP_STORE
            push.refresh()   // the cloud learns whether it can reach this phone
            #endif
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                #if APP_STORE
                accountSection
                #endif
                connectionSection
                #if !APP_STORE
                glassesSection   // the App Store build has no glasses toolkit (appstore.yml)
                #endif
                Section {
                    Toggle("Read back what I said", isOn: $readBack)
                        .onChange(of: readBack) { _, on in Conversation.readBack = on }
                    Toggle("Only answer to \"Bridge\"", isOn: $wakeWord)
                        .onChange(of: wakeWord) { _, on in Conversation.wakeWord = on }
                    if wakeWord {
                        Picker("Answer without \"Bridge\"", selection: $answerWindow) {
                            ForEach(Conversation.answerWindows, id: \.self) { Text(Self.duration($0, zero: "Never")).tag($0) }
                        }
                        .onChange(of: answerWindow) { _, seconds in Conversation.answerWindow = seconds }
                    }
                    Picker("Hang up after quiet", selection: $hangUpAfter) {
                        ForEach(Conversation.hangUpChoices, id: \.self) { Text(Self.duration($0, zero: "Never")).tag($0) }
                    }
                    .onChange(of: hangUpAfter) { _, seconds in Conversation.hangUpAfter = seconds }
                    Picker("Phone voice", selection: $voiceID) {
                        Text("Best installed").tag("")
                        ForEach(Conversation.voices, id: \.identifier) { Text(Conversation.label($0)).tag($0.identifier) }
                    }
                    .onChange(of: voiceID) { _, id in
                        Conversation.voiceID = id
                        preview()
                    }
                    if mode.wrappedValue != .demo {
                        Toggle("Natural voice", isOn: $natural)
                            // Saved only when it differs from the current value, so the refresh below isn't saved as a choice.
                            .onChange(of: natural) { _, on in if on != Conversation.naturalVoice { Conversation.naturalVoice = on } }
                            // An upgraded Pro install's default depends on Pro, which StoreKit reports after launch.
                            .onChange(of: store.isPro) { _, _ in natural = Conversation.naturalVoice }
                    }
                    Toggle("High-quality speech", isOn: $hiFi)
                        .onChange(of: hiFi) { _, on in Conversation.hiFiSpeech = on }
                } header: { Text("Voice") } footer: {
                    Text(voiceFooter)
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
            #if APP_STORE
            .sheet(isPresented: $showPaywall) { Paywall { showPaywall = false } }
            .manageSubscriptionsSheet(isPresented: $showManage)
            #endif
        }
    }

    /// "25 seconds", "5 minutes"; `zero` for 0.
    private static func duration(_ seconds: TimeInterval, zero: String) -> String {
        let s = Int(seconds)
        return s == 0 ? zero : s < 60 ? "\(s) seconds" : s == 60 ? "1 minute" : "\(s / 60) minutes"
    }

    /// Built a sentence at a time: as one long `+` chain of ternaries it's too slow for the Swift type checker.
    private var voiceFooter: String {
        var text = readBack
            ? "Bridge reads your message back and asks \"Ready to send it?\" Nothing is sent until you say yes."
            : "Bridge sends what you say after a 2-second pause, without repeating it."
        if wakeWord {
            text += " While listening, Bridge ignores anything that doesn't start with \"Bridge\""
            text += answerWindow == 0 ? "." : ", except an answer within \(Int(answerWindow)) seconds of a question it asked."
        }
        if hangUpAfter == 0 {
            let goodbye = wakeWord ? "Bridge, goodbye" : "goodbye"
            text += " Bridge stays on until you say \"\(goodbye)\", which uses more battery and keeps the glasses on call-quality audio."
        }
        text += " The phone voice speaks unless the natural voice is on and available; download Premium voices in iPhone Settings > Accessibility > Spoken Content > Voices."
        if mode.wrappedValue == .pc {
            text += " Natural voice sends each reply's text to OpenAI to be spoken, and needs an OpenAI key on the relay."
        } else if mode.wrappedValue == .cloud {
            text += " Natural voice is spoken by Amazon Polly and needs Bridge Pro."
        }
        text += " High-quality speech plays replies over the glasses' music link, which sounds much better, but each reply starts and listening resumes about a second later."
        return text
    }

    #if APP_STORE
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

    #endif

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
                Button("Save and test") { saveAndTest() }
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

    private func saveAndTest() {
        guard let address = Relay.pcAddress(url) else { testResult = Relay.Failure.badAddress.localizedDescription; return }
        url = address
        relayURL = address
        token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let status = Keychain.write("relayToken", token)
        guard status == errSecSuccess else { testResult = Relay.Failure.keychain(status).localizedDescription; return }
        test()
    }

    private func test() {
        testResult = "Testing…"
        Task {
            do { _ = try await Relay.shared.inbox(after: nil, wait: false); testResult = "✓ Connected" }
            catch { testResult = error.localizedDescription }
        }
    }

    /// Not during a conversation: the recognizer would hear the sample and send it as a turn.
    private func preview() {
        previewer.stopSpeaking(at: .immediate)
        guard glasses.conversation.phase == .idle else { return }
        // The default session follows the silent switch, and a finished conversation's one plays from the earpiece.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        let u = AVSpeechUtterance(string: "This is how Bridge will sound.")
        u.voice = Conversation.bestVoice()
        u.rate = 0.5
        previewer.speak(u)
        // Hand the audio back (music the preview paused resumes) once it's done, unless a conversation started.
        Task {
            repeat { try? await Task.sleep(for: .milliseconds(300)) } while previewer.isSpeaking
            if glasses.conversation.phase == .idle { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
        }
    }

    #if !APP_STORE
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
    #endif

    #if APP_STORE
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
    #endif
}

#if APP_STORE
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
#endif
