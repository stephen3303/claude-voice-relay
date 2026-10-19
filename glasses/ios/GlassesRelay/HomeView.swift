import SwiftUI

/// The main screen: where things stand, the two controls (Talk and Look), and the latest exchange.
/// Settings and Help open from the toolbar.
struct HomeView: View {
    @EnvironmentObject var glasses: GlassesController
    @EnvironmentObject var conversation: Conversation
    @ObservedObject private var store = Store.shared
    @AppStorage("relayURL") private var relayURL = ""
    @State private var showSettings = CommandLine.arguments.contains("-show-settings")   // CI screenshot
    @State private var showHelp = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    status
                    controls
                    recent
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Bridge")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showHelp = true } label: { Label("Help", systemImage: "questionmark.circle") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showHelp) { HelpView() }
        }
    }

    // MARK: status

    private var status: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(conversation.phase.rawValue, systemImage: phaseSymbol)
                .font(.title2.bold())
                .foregroundStyle(conversation.phase == .idle ? Color.primary : Color.accentColor)
                .symbolEffect(.variableColor.iterative, isActive: conversation.phase == .listening)
            Divider()
            StatusRow(title: "Glasses", value: glassesValue, ok: glasses.deviceCount > 0)
            StatusRow(title: "Connection", value: connectionValue, ok: !relayURL.isEmpty)
            #if APP_STORE
            StatusRow(title: "Bridge Pro", value: store.isPro ? "Active" : "Not subscribed", ok: store.isPro)
            #endif
            if !conversation.status.isEmpty {
                Text(conversation.status).font(.footnote).foregroundStyle(.secondary)
            }
            if let e = glasses.lastError {
                Text(e).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private var phaseSymbol: String {
        switch conversation.phase {
        case .idle: return "moon.zzz"
        case .listening: return "waveform"
        case .thinking: return "ellipsis.bubble"
        case .speaking: return "speaker.wave.2"
        }
    }

    private var glassesValue: String {
        if glasses.deviceCount > 0 { return glasses.deviceCount == 1 ? "Connected" : "\(glasses.deviceCount) connected" }
        return glasses.registration == "Registered" ? "Not nearby" : "Not set up"
    }

    private var connectionValue: String {
        switch relayURL {
        case "": return "Not set up"
        case Relay.demoAddress: return "Demo"
        case Relay.cloudAddress: return "Bridge Cloud"
        default: return "My PC"
        }
    }

    // MARK: controls

    private var controls: some View {
        VStack(spacing: 12) {
            if conversation.phase == .idle {
                Button { conversation.begin(trigger: .button) } label: {
                    Label("Talk", systemImage: "mic.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button(role: .destructive) { conversation.end(saying: nil) } label: {
                    Label("End conversation", systemImage: "stop.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }
            Button { conversation.look() } label: {
                Label(store.isPro ? "Look" : "Look (Bridge Pro)", systemImage: "camera.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(conversation.phase != .idle || !glasses.cameraAllowed)
            Text("Or say \"Hey Meta, start Bridge\" on your glasses.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .controlSize(.large)
    }

    // MARK: recent

    @ViewBuilder private var recent: some View {
        if !conversation.transcript.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Recent").font(.headline)
                    Spacer()
                    NavigationLink("History") { HistoryView() }.font(.subheadline)
                }
                ForEach(Array(Array(conversation.transcript.enumerated()).suffix(6).reversed()), id: \.offset) { _, line in
                    TranscriptLine(who: line.who, text: line.text)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

private struct StatusRow: View {
    let title: String, value: String, ok: Bool
    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary)
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(ok ? Color.green : Color.orange)
                .accessibilityHidden(true)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

struct TranscriptLine: View {
    let who: String, text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(who).font(.caption).foregroundStyle(.secondary)
            Text(text).textSelection(.enabled)   // press and hold to select and copy
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Every saved line, newest first, with Clear.
struct HistoryView: View {
    @EnvironmentObject var conversation: Conversation
    @State private var confirmClear = false
    @State private var draft = ""

    var body: some View {
        List {
            if conversation.transcript.isEmpty {
                Text("Nothing yet. Your conversations appear here.").foregroundStyle(.secondary)
            }
            ForEach(Array(Array(conversation.transcript.enumerated()).reversed()), id: \.offset) { _, line in
                TranscriptLine(who: line.who, text: line.text)
            }
        }
        .navigationTitle("History")
        .safeAreaInset(edge: .bottom) { composer }
        .toolbar {
            if !conversation.transcript.isEmpty {
                Button("Clear", role: .destructive) { confirmClear = true }
            }
        }
        .confirmationDialog("Clear the conversation history?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear history", role: .destructive) { conversation.transcript = [] }
        }
    }

    /// Type to the relay instead of speaking: the same read-back as voice ("Ready to send it?", then type yes).
    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message the relay", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(send)
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title) }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || conversation.sendingText)
                .accessibilityLabel("Send")
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !conversation.sendingText else { return }
        draft = ""
        conversation.sendText(text)
    }
}
