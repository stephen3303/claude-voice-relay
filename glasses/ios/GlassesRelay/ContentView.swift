import SwiftUI

struct ContentView: View {
    @EnvironmentObject var glasses: GlassesController
    @EnvironmentObject var conversation: Conversation
    @State private var url = Relay.shared.baseURL
    @State private var token = Relay.shared.token
    @State private var testResult = ""
    @State private var photoResult = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Glasses") {
                    LabeledContent("Meta AI registration", value: glasses.registration)
                    LabeledContent("Connected glasses", value: "\(glasses.deviceCount)")
                    Button("Connect to Meta AI") { Task { await glasses.register() } }
                    if glasses.cameraAllowed {
                        Button("Test photo") {
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
                    if !testResult.isEmpty { Text(testResult).font(.footnote) }
                } header: { Text("PC relay") }

                Section("Conversation — \(conversation.phase.rawValue)") {
                    if conversation.phase == .idle {
                        Button("Talk now (without Hey Meta)") { conversation.begin(trigger: .button) }
                    } else {
                        Button("End", role: .destructive) { conversation.end(saying: nil) }
                    }
                    if !conversation.status.isEmpty { Text(conversation.status).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(Array(conversation.transcript.enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading) {
                            Text(line.who).font(.caption).foregroundStyle(.secondary)
                            Text(line.text)
                        }
                    }
                }
            }
            .navigationTitle("Bridge")
        }
    }
}
