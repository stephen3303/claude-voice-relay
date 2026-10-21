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
                    header
                    status
                    controls
                    recent
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
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

    /// "Bridge" with three icons beside it, side by side: listening, glasses, and the PC (or cloud) connection.
    private var header: some View {
        HStack(spacing: 14) {
            Text("Bridge").font(.largeTitle.bold())
            Spacer()
            StatusIcon(symbol: phaseSymbol, label: "Listening", value: conversation.phase.rawValue,
                       tint: conversation.phase == .idle ? .secondary : Color.accentColor,
                       animate: conversation.phase == .listening)
            StatusIcon(symbol: "eyeglasses", label: "Glasses", value: glassesValue,
                       tint: glasses.deviceCount > 0 ? .green : .orange)
            StatusIcon(symbol: relayURL == Relay.cloudAddress ? "cloud.fill" : "desktopcomputer", label: "Connection", value: connectionValue,
                       tint: relayURL.isEmpty ? .orange : .green)
        }
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            #if APP_STORE
            StatusRow(title: "Bridge Pro", value: store.isPro ? "Active" : "Not subscribed", ok: store.isPro)
            #endif
            if glasses.deviceCount == 0 { Text("Glasses: \(glassesValue)").font(.footnote).foregroundStyle(.secondary) }
            if relayURL.isEmpty { Text("Connection: \(connectionValue)").font(.footnote).foregroundStyle(.secondary) }
            if !conversation.status.isEmpty {
                Text(conversation.status).font(.footnote).foregroundStyle(.secondary)
            }
            if let e = glasses.lastError {
                Text(e).font(.footnote).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
            #if APP_STORE
            Text("Or say \"Hey Siri, talk to Bridge\".")
                .font(.footnote).foregroundStyle(.secondary)
            #else
            Text("Or say \"Hey Meta, start Bridge\" on your glasses.")
                .font(.footnote).foregroundStyle(.secondary)
            #endif
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

private struct StatusIcon: View {
    let symbol: String, label: String, value: String, tint: Color
    var animate = false
    var body: some View {
        Image(systemName: symbol)
            .font(.title3)
            .foregroundStyle(tint)
            .symbolEffect(.variableColor.iterative, isActive: animate)
            .frame(width: 32, height: 32)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue(value)
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
            Text(text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        // Long-press to copy or share the message (the menu also shows up in VoiceOver's actions).
        .contextMenu {
            Button { UIPasteboard.general.string = text } label: { Label("Copy", systemImage: "doc.on.doc") }
            ShareLink(item: text)
        }
    }
}

/// Every saved line, newest first, with Clear.
struct HistoryView: View {
    @EnvironmentObject var conversation: Conversation
    @State private var confirmClear = false

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
        .toolbar {
            if !conversation.transcript.isEmpty {
                Button("Clear", role: .destructive) { confirmClear = true }
            }
        }
        .confirmationDialog("Clear the conversation history?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear history", role: .destructive) { conversation.transcript = [] }
        }
    }
}
