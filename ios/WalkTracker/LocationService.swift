import CoreLocation
import CoreMotion
import UIKit

/// All GPS for the app, using Apple's Core Location and Core Motion only.
///
/// 1. Walks started in the app: feeds the web app's `navigator.geolocation`,
///    and keeps recording with the phone locked or the app in the background,
///    holding the points until the app is open again.
/// 2. Auto-tracking (optional, needs "Always" location access): the motion
///    sensor notices when you start walking and the walk is recorded on its own,
///    even if the app isn't open. Between walks only low-power location runs.
@MainActor
final class LocationService: NSObject {
    static let shared = LocationService()

    /// Hands points to the web app (set by WebHost).
    var deliver: (([TrackPoint]) -> Void)?
    var deliverCurrent: ((Int, TrackPoint) -> Void)?
    var deliverError: ((Int, String) -> Void)?
    var onAutoWalkFinished: (() -> Void)?

    let journal = WalkJournal()
    private let manager = CLLocationManager()
    private let motion = CMMotionActivityManager()
    private var watches = Set<Int>() // web app watchPosition ids
    private var currentRequests = Set<Int>() // web app getCurrentPosition ids
    private var lastFix: CLLocation?
    private var motionOn = false
    private var offFootSince: Date?
    private var finishTimer: Timer?

    private enum Mode { case off, idle, precise }
    private var mode = Mode.off

    private(set) var autoTrack: Bool {
        get { UserDefaults.standard.bool(forKey: "autoTrack") }
        set { UserDefaults.standard.set(newValue, forKey: "autoTrack") }
    }

    override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .fitness
        // An auto walk still open from before iOS closed the app: keep going if
        // we're still walking; the motion sensor cancels this check if we are.
        if journal.current != nil {
            offFootSince = Date()
            scheduleFinishCheck()
        }
        updateMode()
    }

    // MARK: - Web app geolocation

    func watch(id: Int) {
        watches.insert(id)
        // A walk started in the app takes over from auto-tracking.
        if journal.current != nil { finishAutoWalk() }
        askForLocation()
        updateMode()
        // Points recorded while the web app wasn't running (e.g. it was reloaded).
        let held = journal.takeOutbox()
        if !held.isEmpty { deliver?(held) }
    }

    func clearWatch(id: Int) {
        watches.remove(id)
        if watches.isEmpty { journal.clearOutbox() }
        updateMode()
    }

    func getCurrent(id: Int) {
        if let fix = lastFix, -fix.timestamp.timeIntervalSinceNow < 30, fix.horizontalAccuracy < 100 {
            deliverCurrent?(id, TrackPoint(fix))
            return
        }
        currentRequests.insert(id)
        askForLocation()
        updateMode()
    }

    /// The app is on screen again: hand over everything recorded meanwhile.
    func flush() {
        guard UIApplication.shared.applicationState == .active, !watches.isEmpty else { return }
        let held = journal.takeOutbox()
        if !held.isEmpty { deliver?(held) }
    }

    // MARK: - Auto-tracking

    func setAutoTrack(_ on: Bool) {
        autoTrack = on
        if on {
            switch manager.authorizationStatus {
            case .notDetermined: manager.requestWhenInUseAuthorization() // then "Always", below
            case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
            default: break
            }
            // Asking for recent activity is what shows the Motion & Fitness prompt.
            if CMMotionActivityManager.isActivityAvailable() {
                motion.queryActivityStarting(from: Date(timeIntervalSinceNow: -60), to: Date(), to: .main) { _, _ in }
            }
        } else if journal.current != nil {
            finishAutoWalk()
        }
        updateMode()
    }

    func status() -> [String: Any] {
        let location: String
        switch manager.authorizationStatus {
        case .authorizedAlways: location = "always"
        case .authorizedWhenInUse: location = "whenInUse"
        case .denied: location = "denied"
        case .restricted: location = "restricted"
        default: location = "notDetermined"
        }
        let motionStatus: String
        if !CMMotionActivityManager.isActivityAvailable() {
            motionStatus = "unavailable"
        } else {
            switch CMMotionActivityManager.authorizationStatus() {
            case .authorized: motionStatus = "authorized"
            case .denied: motionStatus = "denied"
            case .restricted: motionStatus = "restricted"
            default: motionStatus = "notDetermined"
            }
        }
        return [
            "autoTrack": autoTrack,
            "location": location,
            "motion": motionStatus,
            "recording": journal.current != nil,
            "pending": journal.finishedCount,
        ]
    }

    private func handle(activity: CMMotionActivity) {
        guard autoTrack else { return }
        let onFoot = (activity.walking || activity.running) && activity.confidence != .low
        if onFoot {
            offFootSince = nil
            finishTimer?.invalidate()
            if journal.current == nil && watches.isEmpty {
                journal.begin()
                updateMode()
            }
        } else if journal.current != nil, activity.stationary || activity.automotive || activity.cycling {
            // Stopped, or got on a bike/in a car: end the walk if it stays that way.
            if offFootSince == nil { offFootSince = Date() }
            scheduleFinishCheck()
        }
    }

    private func scheduleFinishCheck() {
        finishTimer?.invalidate()
        finishTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finishIfOffFoot() }
        }
    }

    private func finishIfOffFoot() {
        guard let since = offFootSince, Date().timeIntervalSince(since) >= 170 else { return }
        finishAutoWalk()
    }

    private func finishAutoWalk() {
        finishTimer?.invalidate()
        offFootSince = nil
        journal.finishCurrent()
        updateMode()
        onAutoWalkFinished?()
    }

    private func startMotion() {
        guard !motionOn, CMMotionActivityManager.isActivityAvailable() else { return }
        motionOn = true
        motion.startActivityUpdates(to: .main) { [weak self] activity in
            guard let activity else { return }
            MainActor.assumeIsolated { self?.handle(activity: activity) }
        }
    }

    private func stopMotion() {
        guard motionOn else { return }
        motionOn = false
        motion.stopActivityUpdates()
    }

    // MARK: - GPS modes

    private func askForLocation() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
    }

    /// precise: a walk is being recorded (or the app asked where you are).
    /// idle: auto-tracking is on; low-power location keeps the app able to
    ///       notice the next walk. off: nothing.
    private func updateMode() {
        let auth = manager.authorizationStatus
        let allowed = auth == .authorizedAlways || auth == .authorizedWhenInUse
        let wantPrecise = allowed && (!watches.isEmpty || !currentRequests.isEmpty || journal.current != nil)
        let wantIdle = autoTrack && auth == .authorizedAlways
        let next: Mode = wantPrecise ? .precise : wantIdle ? .idle : .off

        if wantIdle {
            manager.startMonitoringSignificantLocationChanges() // relaunches the app if iOS closed it
            startMotion()
        } else {
            manager.stopMonitoringSignificantLocationChanges()
            stopMotion()
        }
        guard next != mode else { return }
        mode = next
        switch next {
        case .precise:
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = 4
            manager.pausesLocationUpdatesAutomatically = false
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
            manager.startUpdatingLocation()
        case .idle:
            manager.desiredAccuracy = kCLLocationAccuracyKilometer
            manager.distanceFilter = 200
            manager.pausesLocationUpdatesAutomatically = false
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = false
            manager.startUpdatingLocation()
        case .off:
            manager.stopUpdatingLocation()
        }
    }

    private func handle(locations: [CLLocation]) {
        for location in locations where location.horizontalAccuracy >= 0 {
            lastFix = location
            guard mode == .precise else { continue }
            let point = TrackPoint(location)
            if journal.current != nil { journal.append(point) }
            if !watches.isEmpty { journal.queue(point) }
        }
        if let fix = lastFix, !currentRequests.isEmpty, fix.horizontalAccuracy < 100 {
            for id in currentRequests { deliverCurrent?(id, TrackPoint(fix)) }
            currentRequests.removeAll()
            updateMode()
        }
        flush()
    }
}

extension LocationService: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated { handle(locations: locations) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            let status = manager.authorizationStatus
            if status == .authorizedWhenInUse && autoTrack { manager.requestAlwaysAuthorization() }
            if status == .denied || status == .restricted {
                if !watches.isEmpty || !currentRequests.isEmpty { deliverError?(1, "Location access is off for WalkTracker") }
                currentRequests.removeAll()
            }
            updateMode()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code == .denied ? 1 : 2
        MainActor.assumeIsolated {
            if !watches.isEmpty || !currentRequests.isEmpty { deliverError?(code, error.localizedDescription) }
        }
    }
}
