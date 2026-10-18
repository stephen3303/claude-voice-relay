import Foundation
import Sentry

/// Crash and error reports to Sentry. The DSN comes from the SENTRY_DSN build setting, which CI fills
/// from a repository secret; a build without it (a local build, a fork) reports nothing.
/// Reports carry the error and where it happened, never what you said, your photos, the answers,
/// your PC's address or the relay token.
enum ErrorReporting {
    private static var started = false

    static func start() {
        guard let dsn = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String,
              dsn.hasPrefix("https://") else { return }
        SentrySDK.start { o in
            o.dsn = dsn
            #if APP_STORE
            o.environment = "appstore"
            #else
            o.environment = "personal"
            #endif
            o.sendDefaultPii = false
            o.attachScreenshot = false
            o.attachViewHierarchy = false
            // Request URLs name your PC on your tailnet, so no network breadcrumbs or failed-request events.
            o.enableNetworkBreadcrumbs = false
            o.enableCaptureFailedRequests = false
            o.enableAutoPerformanceTracing = false
            o.enableAutoSessionTracking = false   // sessions are usage data with an install ID, and skip beforeSend
            // No trail of taps, screens or connectivity either: a report is the error, where, and the phone's state.
            o.enableAutoBreadcrumbTracking = false
            o.maxBreadcrumbs = 0
            o.beforeSend = { event in
                // Allow-list: whatever else the SDK or a later change attaches stays on the phone.
                event.user = nil
                event.breadcrumbs = nil
                event.request = nil
                event.extra = nil
                event.context = event.context?
                    .filter { name, _ in ["os", "device", "app"].contains(name) }
                    .mapValues { values in values.filter { key, _ in key != "device_app_hash" } }   // a per-install ID
                return event
            }
        }
        started = true
    }

    /// A failure the app recovered from (a relay call, the glasses camera, the Meta toolkit). Only the error's type and
    /// code are sent, plus the description for Bridge's own errors: the original's userInfo can hold the request URL.
    static func report(_ error: Error, _ place: String) {
        guard started else { return }
        // Not set up yet, a wrong token, or the phone is locked: the app already says what to do, nothing is broken.
        if let failure = error as? Relay.Failure {
            switch failure {
            case .notConfigured, .noAddress, .badAddress, .noToken, .locked, .http(401), .http(403): return
            case .keychain, .http: break
            }
        }
        // The glasses off, the camera not allowed: the app says so, and it's not a bug.
        if let failure = error as? GlassesController.PhotoFailure {
            switch failure { case .noGlasses, .notAllowed: return; default: break }
        }
        // Cancelled, or the PC or the phone offline: expected, and the app says so.
        let offline: [URLError.Code] = [.cancelled, .notConnectedToInternet, .timedOut, .networkConnectionLost,
                                        .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .dataNotAllowed,
                                        .internationalRoamingOff]
        if error is CancellationError { return }
        if let code = (error as? URLError)?.code, offline.contains(code) { return }
        let ns = error as NSError
        // Bridge's own errors describe themselves in fixed words. Others go by domain and code alone: the Meta
        // toolkit's text can name the glasses, and some URLError texts name your PC. A camera stream error carries
        // the toolkit's text, so it gets a fixed one.
        var words: String?
        if case .failed? = error as? GlassesController.PhotoFailure { words = "The glasses camera stream reported an error." }
        else if error is Relay.Failure || error is GlassesController.PhotoFailure { words = error.localizedDescription }
        let clean = NSError(domain: ns.domain, code: ns.code,
                            userInfo: words.map { [NSLocalizedDescriptionKey: $0] } ?? [:])
        SentrySDK.capture(error: clean) { scope in scope.setTag(value: place, key: "where") }
    }
}
