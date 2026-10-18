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

    /// Set at launch by GlassesRelayApp. False means Wearables.configure() failed, and nothing may touch Wearables.shared.
    nonisolated(unsafe) static var toolkitReady = false
    nonisolated(unsafe) static var toolkitError: String?
    /// App Store screenshots in CI: the seeded state is shown as is, and nothing is started.
    nonisolated(unsafe) static var screenshotMode = false

    func start() async {
        guard !started, !Self.screenshotMode else { return }
        started = true
        guard Self.toolkitReady else {
            registration = "Unavailable"
            lastError = "Glasses features are off: the Meta toolkit didn't start (\(Self.toolkitError ?? "unknown error"))."
            return
        }
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
        guard Self.toolkitReady else { return }
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
        case noGlasses, notAllowed, timedOut, cameraDidNotStart, cameraBusy, photoNeverArrived, failed(String)
        var errorDescription: String? {   // spoken aloud, so plain words
            switch self {
            case .noGlasses: return "I can't see your glasses. Check they're on and connected."
            case .notAllowed: return "The camera isn't allowed yet. Open Bridge and tap Allow camera."
            case .timedOut: return "The glasses took too long to connect. Try again."
            case .cameraDidNotStart: return "The glasses camera didn't wake up. Try again."
            case .cameraBusy: return "The glasses camera was busy. Try again."
            case .photoNeverArrived: return "The photo didn't reach your phone. Try again."
            case .failed(let why): return "The photo didn't work. \(why)"
            }
        }
    }

    func refreshCameraPermission() async {
        cameraAllowed = (try? await Wearables.shared.checkPermissionStatus(.camera)) == .granted
    }

    /// Opens the Meta AI app to ask; only call this from a tap.
    func allowCamera() async {
        guard Self.toolkitReady else { return }
        do { cameraAllowed = try await Wearables.shared.requestPermission(.camera) == .granted }
        catch { lastError = "Camera permission: \(error)" }
    }

    /// One photo from the glasses camera, as JPEG. A device session is opened just for the shot and
    /// closed after, so the camera isn't held (or the battery drained) between photos.
    /// Order per Meta's sample: session started → camera stream streaming → photo started → stream
    /// stopped (and seen to be down) so the shutter has the sensor to itself → capture.
    func capturePhoto() async throws -> Data {
        try Store.shared.requirePro()
        guard Self.toolkitReady else { throw PhotoFailure.noGlasses }
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
            // stateStream announces changes, so a session that is already up would say nothing.
            // Subscribe first, then read, so a start in between isn't missed either.
            let states = session.stateStream()
            if case .started = session.state { return }
            for await state in states {
                if case .started = state { return }
                if case .stopped = state { throw PhotoFailure.failed("The glasses ended the session.") }
            }
        }

        // App Store build: the standalone photo capability is experimental (Meta won't allow it in
        // published apps yet), so take the still from the camera stream, which is not. The personal
        // build tries the standalone photo first and falls back to the stream, so both run it at medium.
        guard let camera = try session.addCamera(config: StreamConfiguration(
            videoCodec: .hvc1, audioCodec: nil, resolution: .medium, frameRate: 7))
        else { throw PhotoFailure.failed("The camera would not start.") }

        enum Event { case streaming, streamStopped, photoReady, photoStopped, progress(UInt64, UInt64), photo(Data), error(String), photoError(String), timeout(Int, PhotoFailure) }
        let (events, emit) = AsyncStream<Event>.makeStream()
        let tokens = ListenerTokenBag()
        defer { Task { await tokens.cancelAll() } }
        camera.stream.statePublisher.listen { state in
            switch state {
            case .streaming: emit.yield(.streaming)
            case .stopped: emit.yield(.streamStopped)
            default: break
            }
        }.store(in: tokens)
        camera.stream.errorPublisher.listen { error in emit.yield(.error(error.localizedDescription)) }.store(in: tokens)
        camera.stream.photoDataPublisher.listen { data in emit.yield(.photo(data.data)) }.store(in: tokens)
        #if !APP_STORE
        camera.photo.statePublisher.listen { state in
            switch state {
            case .started: emit.yield(.photoReady)
            case .stopped: emit.yield(.photoStopped)
            default: break
            }
        }.store(in: tokens)
        camera.photo.photoDataPublisher.listen { data in emit.yield(.photo(data.imageData)) }.store(in: tokens)
        camera.photo.errorPublisher.listen { error in
            // description is only the case name; the underlying error is what says why.
            switch error {
            case .captureFailure(let underlying?), .sessionSetupFailed(let underlying?):
                emit.yield(.photoError("\(error.description): \(underlying)"))
            default:
                emit.yield(.photoError(error.description))
            }
        }.store(in: tokens)
        camera.photo.transferProgressPublisher.listen { p in emit.yield(.progress(p.bytesReceived, p.totalBytes)) }.store(in: tokens)
        #endif

        // One watchdog, re-armed per stage, so a slow wake-up and a slow transfer each get their
        // own allowance and the spoken error says which one ran out. A timeout that fired before a
        // re-arm can already be queued, so each carries its generation and stale ones are ignored.
        // Every allowance is clipped to one overall deadline, so progress can't keep it waiting forever.
        var deadline = ContinuousClock.now + .seconds(60)
        var watchdog: Task<Void, Never>?
        var generation = 0
        func arm(_ seconds: Double, _ failure: PhotoFailure) {
            watchdog?.cancel()
            generation += 1
            let gen = generation, wait = min(Duration.seconds(seconds), deadline - ContinuousClock.now)
            watchdog = Task { try? await Task.sleep(for: wait); if !Task.isCancelled { emit.yield(.timeout(gen, failure)) } }
        }
        defer { watchdog?.cancel() }

        /// The still taken from the running video stream: the App Store build's only path, and the
        /// personal build's fallback.
        func fireStreamStill() throws {
            guard camera.stream.capturePhoto(format: .jpeg) else { throw PhotoFailure.cameraBusy }
            arm(20, .photoNeverArrived)
        }

        camera.stream.start()
        arm(15, .cameraDidNotStart)
        var photoStarting = false, shutterReady = false, fired = false
        #if !APP_STORE
        // The standalone photo is experimental, and in testing the shutter fired but the
        // picture never crossed. So if it fails, take the still from the video stream instead, and
        // leave a note on the home screen saying how far the full photo got.
        var fellBack = false, photoDown = false, streamRestarted = false, streamFired = false
        var bytes: (UInt64, UInt64)?, why = ""
        var succeeded = false
        // How far the fallback got, for the note: "where it stopped" beats "it failed".
        var stage = "the shutter didn't let go of the camera", streamError = ""
        func fire() {
            fired = true
            // Medium keeps the Bluetooth transfer quick; plenty for Claude to read a screen or sign.
            camera.photo.capturePhoto(resolution: .medium, quality: .medium)
            // About a second when it works (Meta's sample allows 15 s); progress buys more time.
            arm(12, .photoNeverArrived)
        }
        func note(_ outcome: String) -> String {
            let crossed = bytes.map { "\($0.0) of \($0.1) bytes arrived" } ?? "no bytes arrived"
            return "Last glasses photo: the full photo failed (\(why); \(crossed)). \(outcome)"
        }
        func restartStream() {
            streamRestarted = true
            stage = "the video stream didn't restart"
            camera.stream.start()
            arm(15, .photoNeverArrived)
        }
        func fallBack(_ reason: String) {
            fellBack = true
            why = reason
            deadline = ContinuousClock.now + .seconds(20)   // the fallback's own budget
            // The shutter and the stream compete for the sensor, so the stream waits for the shutter
            // to report it's down, as the shutter waited for the stream on the way in.
            camera.photo.stop()
            if photoDown { restartStream() } else { arm(3, .cameraBusy) }
        }
        defer {
            if fellBack { lastError = note(succeeded ? "The fallback got a photo." : "The fallback failed too: \(stage)\(streamError).") }
        }
        #endif
        for await event in events {
            switch event {
            #if !APP_STORE
            case .photoStopped where fellBack && !streamRestarted:
                photoDown = true
                restartStream()
            case .timeout(let gen, _) where gen == generation && fellBack && !streamRestarted:
                restartStream()   // the shutter never said it let go; try the stream anyway
            case .streaming where fellBack && !streamFired:
                streamFired = true
                stage = "the video stream refused the still"
                try fireStreamStill()
                stage = "the still never arrived"
            case .progress, .photoError:
                guard !fellBack else { break }   // leftovers from the abandoned full photo
                if case .progress(let received, let total) = event {
                    bytes = (received, total)
                    arm(15, .photoNeverArrived)   // bytes are still crossing; keep waiting
                } else if case .photoError(let message) = event, fired {
                    fallBack(message)
                } else if case .photoError(let message) = event {
                    throw PhotoFailure.failed(message)
                }
            #endif
            case .streaming where !photoStarting && !fired:
                #if APP_STORE
                fired = true
                try fireStreamStill()
                #else
                // The stream only wakes the sensor; the shutter is started once frames prove it's up.
                photoStarting = true
                camera.photo.start()
                arm(10, .cameraDidNotStart)   // the sensor is up; a fresh allowance for the shutter
                #endif
            case .streaming:
                break
            #if !APP_STORE
            case .photoReady where !shutterReady:
                shutterReady = true
                // Stream and shutter compete for the sensor, and stop() returns before the stream lets
                // go. Meta's sample says a capture fired in that beat is refused with no error and no
                // bytes, so it just times out. Fire only once the stream reports it is down.
                camera.stream.stop()
                if camera.stream.state == .stopped { fire() } else { arm(5, .cameraBusy) }
            case .streamStopped where shutterReady && !fired:
                fire()
            case .photoStopped where fired && !fellBack:
                // Possibly just the end of a good capture with the data still on its way; give it a beat.
                photoDown = true
                arm(3, .photoNeverArrived)
            case .timeout(let gen, .photoNeverArrived) where gen == generation && fired && !fellBack:
                fallBack("it never arrived")
            #endif
            case .streamStopped, .photoReady, .photoStopped:
                break
            #if APP_STORE
            case .progress, .photoError:
                break
            #endif
            case .photo(let jpeg):
                // A late full photo after the fallback started is still taken; it's the better picture.
                camera.stream.stop()
                #if !APP_STORE
                camera.photo.stop()
                succeeded = true
                #endif
                return jpeg
            case .error(let message):
                #if !APP_STORE
                streamError = " (stream error: \(message))"
                #endif
                throw PhotoFailure.failed(message)
            case .timeout(let gen, let failure) where gen == generation:
                throw failure
            case .timeout:
                break   // fired before a later re-arm
            }
        }
        // The events never finish on their own, so getting here means the photo was cancelled.
        throw CancellationError()
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
