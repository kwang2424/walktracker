import ActivityKit
import CoreLocation
import Foundation
import UserNotifications

/// The Lock Screen / Dynamic Island card for a walk started in the app (see
/// ios/WalkTrackerWidgets). The page starts and ends it; in between, distance
/// and steps are updated from here, since the page is paused while the phone
/// is locked. iOS only lets an app start these while it's on screen, so walks
/// recorded automatically get a notification at the end instead.
@MainActor
final class WalkActivity {
    static let shared = WalkActivity()

    private var activity: Activity<WalkActivityAttributes>?
    private var state = WalkActivityAttributes.ContentState(distance: 0)
    private var lastPoint: CLLocation?
    private var lastPush = Date.distantPast
    private var pushedDistance = 0.0

    private init() {
        // Cards left over from a walk the app didn't get to end (it was closed).
        for old in Activity<WalkActivityAttributes>.activities {
            Task { await old.end(nil, dismissalPolicy: .immediate) }
        }
    }

    func start(startedAt: Date, distance: Double) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if activity != nil { end(distance: distance, newBlocks: nil, dismiss: true) }
        state = .init(distance: distance)
        lastPoint = nil
        pushedDistance = distance
        activity = try? Activity.request(
            attributes: WalkActivityAttributes(startedAt: startedAt),
            content: .init(state: state, staleDate: nil)
        )
    }

    /// A GPS fix good enough to count (LocationService checks). Keeps the
    /// distance going while the page is paused.
    func add(_ location: CLLocation, steps: Int?) {
        guard activity != nil else { return }
        if let last = lastPoint {
            let d = location.distance(from: last)
            let secs = location.timestamp.timeIntervalSince(last.timestamp)
            if d >= 3, d < 150, secs > 0, d / secs < 7 { state.distance += d }
        }
        lastPoint = location
        if let steps { state.steps = steps }
        pushSoon()
    }

    /// The page's own numbers (it's on screen): those win.
    func update(distance: Double, newBlocks: Int?) {
        guard activity != nil else { return }
        state.distance = max(state.distance, distance)
        if let newBlocks { state.newBlocks = newBlocks }
        pushSoon()
    }

    /// The walk is over: show the totals for a while, then go away.
    func end(distance: Double, newBlocks: Int?, dismiss: Bool = false) {
        guard let current = activity else { return }
        activity = nil
        state.distance = max(state.distance, distance)
        state.newBlocks = newBlocks
        state.endedAt = Date()
        let content = ActivityContent(state: state, staleDate: nil)
        Task { await current.end(content, dismissalPolicy: dismiss ? .immediate : .after(Date().addingTimeInterval(15 * 60))) }
    }

    // Live Activity updates are rationed by iOS: send one every 15 s at most.
    private func pushSoon() {
        guard let current = activity, Date().timeIntervalSince(lastPush) >= 15, abs(state.distance - pushedDistance) >= 5 else { return }
        lastPush = Date()
        pushedDistance = state.distance
        let content = ActivityContent(state: state, staleDate: nil)
        Task { await current.update(content) }
    }
}

/// "Walk recorded" notifications when an automatic walk ends.
enum WalkNotifier {
    static func askPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func walkRecorded(distance: Double, duration: TimeInterval) {
        let content = UNMutableNotificationContent()
        content.title = "Walk recorded"
        let km = String(format: "%.1f km", distance / 1000)
        let minutes = Int(duration / 60)
        let time = minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h \(minutes % 60) min"
        content.body = "\(km) in \(time). Open WalkTracker to see your new blocks."
        content.sound = .default
        let request = UNNotificationRequest(identifier: "walk-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
