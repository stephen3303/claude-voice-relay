import Foundation
import MWDATCore
import MWDATCamera

/// Registers with Meta AI and listens for "Hey Meta, start Bridge".
/// Modeled on the toolkit's BirdSpotter sample (DatGlassesVoiceRepository): wait for registration,
/// open the voice channel, follow the device list, and reopen the channel whenever it drops.
@MainActor
final class GlassesController: ObservableObject {
    /// One per app, shared with the Shortcuts actions.
    static let shared = GlassesController()

    @Published var registration = "Unknown"
    @Published var deviceCount = 0
    @Published var cameraAllowed = false
    @Published var lastError: String?

    let conversation = Conversation()

    private var stream: VoiceInvocationsStream?
    private var listeningOn: DeviceIdentifier?
    private var devices: [DeviceIdentifier] = []
    private var started = false

    private init() {
        conversation.takePhoto = { [weak self] in
            guard let self else { throw PhotoFailure.noGlasses }
            return try await self.capturePhoto()
        }
    }

    func start() async {
        guard !started else { return }
        started = true
        registration = "\(Wearables.shared.registrationState)"
        Task { for await state in Wearables.shared.registrationStateStream() { registration = "\(state)" } }
        Task { await followDevices() }
        Task { await awaitRegistered(); await refreshCameraPermission() }
        #if !APP_STORE
        // "Hey Meta, start Bridge" is experimental in Meta's toolkit, so it's left out of the
        // App Store build; that build starts from Siri, Shortcuts or the Action Button.
        await keepVoiceChannelOpen()
        #endif
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

    // MARK: camera

    enum PhotoFailure: LocalizedError {
        case noGlasses, notAllowed, timedOut, failed(String)
        var errorDescription: String? {   // spoken aloud, so plain words
            switch self {
            case .noGlasses: return "I can't see your glasses. Check they're on and connected."
            case .notAllowed: return "The camera isn't allowed yet. Open Bridge and tap Allow camera."
            case .timedOut: return "The photo took too long. Try again."
            case .failed(let why): return "The photo didn't work. \(why)"
            }
        }
    }

    func refreshCameraPermission() async {
        cameraAllowed = (try? await Wearables.shared.checkPermissionStatus(.camera)) == .granted
    }

    /// Opens the Meta AI app to ask; only call this from a tap.
    func allowCamera() async {
        do { cameraAllowed = try await Wearables.shared.requestPermission(.camera) == .granted }
        catch { lastError = "Camera permission: \(error)" }
    }

    /// One photo from the glasses camera, as JPEG. A device session is opened just for the shot and
    /// closed after, so the camera isn't held (or the battery drained) between photos.
    /// Order per Meta's sample: session started → camera stream streaming → photo started → stream
    /// stopped so the shutter has the sensor to itself → capture.
    func capturePhoto() async throws -> Data {
        try Store.shared.requirePro()
        // Launched from a Shortcut, the device list can arrive a beat after the app opens.
        for _ in 0..<10 where devices.isEmpty { try await Task.sleep(for: .milliseconds(500)) }
        guard let device = devices.first else { throw PhotoFailure.noGlasses }
        guard (try? await Wearables.shared.checkPermissionStatus(.camera)) == .granted else {
            cameraAllowed = false
            throw PhotoFailure.notAllowed
        }

        let session = try Wearables.shared.createSession(deviceSelector: SpecificDeviceSelector(device: device))
        defer { session.stop() }
        try session.start()
        try await withTimeout(15) {
            for await state in session.stateStream() {
                if case .started = state { return }
                if case .stopped = state { throw PhotoFailure.failed("The glasses ended the session.") }
            }
        }

        #if APP_STORE
        // App Store build: the standalone photo capability is experimental (Meta won't allow it in
        // published apps yet), so take the still from the camera stream, which is not.
        guard let camera = try session.addCamera(config: StreamConfiguration(
            videoCodec: .hvc1, audioCodec: nil, resolution: .medium, frameRate: 7))
        else { throw PhotoFailure.failed("The camera would not start.") }
        #else
        guard let camera = try session.addCamera(config: StreamConfiguration(
            videoCodec: .hvc1, audioCodec: nil, resolution: .low, frameRate: 7))
        else { throw PhotoFailure.failed("The camera would not start.") }
        #endif

        enum Event { case streaming, photoReady, photo(Data), error(String) }
        let (events, emit) = AsyncStream<Event>.makeStream()
        let tokens = ListenerTokenBag()
        defer { Task { await tokens.cancelAll() } }
        camera.stream.statePublisher.listen { state in
            if case .streaming = state { emit.yield(.streaming) }
        }.store(in: tokens)
        camera.stream.errorPublisher.listen { error in emit.yield(.error(error.localizedDescription)) }.store(in: tokens)
        #if APP_STORE
        camera.stream.photoDataPublisher.listen { data in emit.yield(.photo(data.data)) }.store(in: tokens)
        #else
        camera.photo.statePublisher.listen { state in
            if case .started = state { emit.yield(.photoReady) }
        }.store(in: tokens)
        camera.photo.photoDataPublisher.listen { data in emit.yield(.photo(data.imageData)) }.store(in: tokens)
        camera.photo.errorPublisher.listen { error in emit.yield(.error(error.description)) }.store(in: tokens)
        #endif

        camera.stream.start()
        return try await withTimeout(30) {
            var asked = false
            for await event in events {
                switch event {
                case .streaming where !asked:
                    #if APP_STORE
                    asked = true
                    guard camera.stream.capturePhoto(format: .jpeg) else { throw PhotoFailure.failed("The camera was busy.") }
                    #else
                    camera.photo.start()
                    #endif
                case .streaming:
                    break
                case .photoReady where !asked:
                    asked = true
                    camera.stream.stop()
                    // Medium keeps the Bluetooth transfer quick; plenty for Claude to read a screen or sign.
                    camera.photo.capturePhoto(resolution: .medium, quality: .medium)
                case .photoReady:
                    break
                case .photo(let jpeg):
                    #if APP_STORE
                    camera.stream.stop()
                    #else
                    camera.photo.stop()
                    #endif
                    return jpeg
                case .error(let why):
                    throw PhotoFailure.failed(why)
                }
            }
            throw PhotoFailure.timedOut
        }
    }

    private func withTimeout<T>(_ seconds: Double, _ work: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask { try await Task.sleep(for: .seconds(seconds)); throw PhotoFailure.timedOut }
            defer { group.cancelAll() }
            return try await group.next()!
        }
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
