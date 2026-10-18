import Foundation
import MWDATCore

/// Registers with Meta AI and listens for "Hey Meta, start Bridge".
/// Modeled on the toolkit's BirdSpotter sample (DatGlassesVoiceRepository): wait for registration,
/// open the voice channel, follow the device list, and reopen the channel whenever it drops.
@MainActor
final class GlassesController: ObservableObject {
    @Published var registration = "Unknown"
    @Published var deviceCount = 0
    @Published var lastError: String?

    let conversation = Conversation()

    private var stream: VoiceInvocationsStream?
    private var listeningOn: DeviceIdentifier?
    private var devices: [DeviceIdentifier] = []

    func start() async {
        registration = "\(Wearables.shared.registrationState)"
        Task { for await state in Wearables.shared.registrationStateStream() { registration = "\(state)" } }
        Task { await followDevices() }
        await keepVoiceChannelOpen()
    }

    func register() async {
        do { try await Wearables.shared.startRegistration() } catch { lastError = "\(error)" }
    }

    // MARK: voice channel

    private func keepVoiceChannelOpen() async {
        var delay: Double = 0.5
        while !Task.isCancelled {
            await awaitRegistered()
            await listenUntilDropped()
            // Back off so a channel that keeps failing doesn't spin; short floor because you're waiting.
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }

    /// Meta AI only routes invocations to a registered app; opening the channel earlier drops it.
    private func awaitRegistered() async {
        if case .registered = Wearables.shared.registrationState { return }
        for await state in Wearables.shared.registrationStateStream() {
            if case .registered = state { return }
        }
    }

    /// One lease of the channel. Returns when the toolkit reports an error (the channel is gone).
    private func listenUntilDropped() async {
        let newStream: VoiceInvocationsStream
        do { newStream = try VoiceInvocationsStream(wearables: Wearables.shared) }
        catch { lastError = "Voice channel would not open: \(error)"; return }

        let (drops, drop) = AsyncStream<Void>.makeStream()
        let tokens = ListenerTokenBag()   // dropping a token cancels its listener
        newStream.invocationsPublisher.listen { [weak self] invocation in
            Task { @MainActor in
                guard let launch = invocation as? LaunchApp else { return }
                // Answer exactly once, right away: Meta AI holds the launch open until we do.
                _ = await launch.responseHandle.sendSuccess(actionOutput: nil)
                self?.conversation.begin(trigger: .glasses)
            }
        }.store(in: tokens)
        newStream.errorPublisher.listen { [weak self] error in
            Task { @MainActor in self?.lastError = "Voice channel: \(error.description)" }
            drop.yield()
        }.store(in: tokens)

        stream = newStream
        listeningOn = nil
        ensureListening()
        for await _ in drops { break }

        if listeningOn != nil { newStream.stop() }
        stream = nil
        listeningOn = nil
        await tokens.cancelAll()
    }

    /// Start the channel on the first connected pair. Called on every device or link change,
    /// because at launch the glasses are listed a beat before their link is up.
    private func ensureListening() {
        guard let stream, let preferred = devices.first, preferred != listeningOn else { return }
        if listeningOn != nil { stream.stop() }
        listeningOn = nil
        do { try stream.start(deviceIdentifier: preferred); listeningOn = preferred; lastError = nil }
        catch { lastError = "Waiting for glasses: \(error)" }
    }

    private func followDevices() async {
        var linkTokens: [any AnyListenerToken] = []
        for await identifiers in Wearables.shared.devicesStream() {
            for token in linkTokens { await token.cancel() }
            linkTokens.removeAll()
            devices = identifiers
            deviceCount = identifiers.count
            ensureListening()
            for device in identifiers.compactMap({ Wearables.shared.deviceForIdentifier($0) }) {
                linkTokens.append(device.addLinkStateListener { [weak self] _ in
                    Task { @MainActor in self?.ensureListening() }
                })
            }
        }
    }
}
