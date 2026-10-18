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
            o.beforeSend = { event in
                event.user = nil
                return event
            }
        }
        started = true
    }

    /// A failure the app recovered from (a relay call, the glasses camera, the Meta toolkit). Only the error's type, code
    /// and description are sent: the original's userInfo can hold the request URL.
    static func report(_ error: Error, _ place: String) {
        guard started else { return }
        // Not set up yet, a wrong token, or the phone is locked: the app already says what to do, nothing is broken.
        if let failure = error as? Relay.Failure {
            guard case .http(let code) = failure, code != 401, code != 403 else { return }
        }
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        let ns = error as NSError
        let clean = NSError(domain: ns.domain, code: ns.code,
                            userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        SentrySDK.capture(error: clean) { scope in scope.setTag(value: place, key: "where") }
    }
}
