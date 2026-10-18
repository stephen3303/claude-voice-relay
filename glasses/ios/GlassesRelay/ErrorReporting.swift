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
            guard case .http(let code) = failure, code != 401, code != 403 else { return }
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
        // Bridge's own errors and URLError describe themselves in fixed words. Others (the Meta toolkit, the system)
        // go by domain and code alone, since their text can name the glasses or the device.
        let ownWords = error is Relay.Failure || error is GlassesController.PhotoFailure || error is URLError
        let clean = NSError(domain: ns.domain, code: ns.code,
                            userInfo: ownWords ? [NSLocalizedDescriptionKey: error.localizedDescription] : [:])
        SentrySDK.capture(error: clean) { scope in scope.setTag(value: place, key: "where") }
    }
}
