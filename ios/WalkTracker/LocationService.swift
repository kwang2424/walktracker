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
    private let pedometer = CMPedometer()
    private var steps: Int? // running count while GPS is on (precise mode)
    private var watches = Set<Int>() // web app watchPosition ids
    private var currentRequests = Set<Int>() // web app getCurrentPosition ids
    private var lastFix: CLLocation?
    private var motionOn = false
    private var offFootSince: Date?
    private var finishTimer: Timer?
    private var inVehicle = false // the motion sensor says car, train or bike
    private var lastGoodFixAt = Date()
    private var watchdog: Timer?
    /// An auto walk ends after this long without one usable GPS fix (e.g. the
    /// subway: underground there's only rough Wi-Fi/cell positioning).
    private static let noFixLimit: TimeInterval = 300
    /// An auto walk ends once you've stopped walking for this long (a short
    /// wait at a light or in a shop doesn't split it; longer stops do).
    private static let stopAfter: TimeInterval = 120

    /// A fix good enough to count toward walked streets. Underground and indoors
    /// iOS falls back to Wi-Fi and cell positions (tens of meters off, no speed),
    /// and a moving train gives fixes faster than anyone walks.
    static func usable(_ l: CLLocation) -> Bool {
        let acc = l.horizontalAccuracy
        guard acc >= 0, acc <= 35 else { return false }
        if l.speed > 7 { return false }
        return acc <= 20 || l.speed >= 0
    }

    private enum Mode { case off, idle, precise }
    private var mode = Mode.off

    /// No-tracking areas from the page (your office, home): automatic walks
    /// don't record points inside them. Kept here too, since the page isn't
    /// running when iOS wakes the app in the background.
    /// A circle (r meters around lat/lon) or one city block (`ring` of
    /// [lat, lon] points traced along its streets, plus `pad` meters of slack).
    struct Zone: Codable {
        let lat: Double
        let lon: Double
        let r: Double
        var ring: [[Double]]? = nil
        var pad: Double? = nil

        func contains(_ l: CLLocation) -> Bool {
            guard let ring, ring.count >= 3 else {
                return l.distance(from: CLLocation(latitude: lat, longitude: lon)) <= r
            }
            // Flat meters around the block, good to well under a meter at this size.
            let k = cos(lat * .pi / 180) * 111_320
            let p = ((l.coordinate.longitude - lon) * k, (l.coordinate.latitude - lat) * 111_320)
            let pts = ring.map { (($0[1] - lon) * k, ($0[0] - lat) * 111_320) }
            var inside = false
            var j = pts.count - 1
            for i in 0..<pts.count {
                let (xi, yi) = pts[i], (xj, yj) = pts[j]
                if (yi > p.1) != (yj > p.1), p.0 < (xj - xi) * (p.1 - yi) / (yj - yi) + xi { inside.toggle() }
                j = i
            }
            if inside { return true }
            let slack = pad ?? 8
            for i in 1..<pts.count {
                let (ax, ay) = pts[i - 1], (bx, by) = pts[i]
                let dx = bx - ax, dy = by - ay
                let l2 = dx * dx + dy * dy
                let t = l2 > 0 ? max(0, min(1, ((p.0 - ax) * dx + (p.1 - ay) * dy) / l2)) : 0
                if hypot(ax + t * dx - p.0, ay + t * dy - p.1) <= slack { return true }
            }
            return false
        }
    }
    var zones: [Zone] {
        get { (UserDefaults.standard.data(forKey: "zones")).flatMap { try? JSONDecoder().decode([Zone].self, from: $0) } ?? [] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "zones"); zoneCache = newValue }
    }
    private lazy var zoneCache: [Zone] = zones

    private var zoneGap = false
    private var waitForStop = false

    private func inZone(_ l: CLLocation) -> Bool {
        zoneCache.contains { $0.contains(l) }
    }

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
            startWatchdog()
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
            WalkNotifier.askPermission() // for "Walk recorded" when an automatic walk ends
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
        if (activity.automotive || activity.cycling) && activity.confidence != .low { inVehicle = true }
        if onFoot || activity.stationary { inVehicle = false }
        // After you finish a walk by hand, wait until you've stopped before the
        // next one can start (or it would restart right away).
        if !(activity.walking || activity.running) { waitForStop = false }
        if onFoot {
            offFootSince = nil
            finishTimer?.invalidate()
            if journal.current == nil && watches.isEmpty && !waitForStop {
                journal.begin()
                lastGoodFixAt = Date()
                startWatchdog()
                updateMode()
            }
        } else if journal.current != nil, !(activity.walking || activity.running) {
            // Stopped, on a train or in a car, or the sensor can't tell ("unknown",
            // common on the subway): end the walk if it stays that way.
            if offFootSince == nil { offFootSince = Date() }
            scheduleFinishCheck()
        }
    }

    /// Checks once a minute that an auto walk still gets usable GPS.
    private func startWatchdog() {
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.journal.current != nil else { return }
                if -self.lastGoodFixAt.timeIntervalSinceNow >= Self.noFixLimit { self.finishAutoWalk() }
            }
        }
    }

    private func scheduleFinishCheck() {
        finishTimer?.invalidate()
        finishTimer = Timer.scheduledTimer(withTimeInterval: Self.stopAfter, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finishIfOffFoot() }
        }
    }

    private func finishIfOffFoot() {
        guard let since = offFootSince, Date().timeIntervalSince(since) >= Self.stopAfter - 10 else { return }
        finishAutoWalk()
    }

    private func finishAutoWalk() {
        finishTimer?.invalidate()
        watchdog?.invalidate()
        watchdog = nil
        offFootSince = nil
        let distance = journal.current?.distance ?? 0
        let walk = journal.finishCurrent()
        WalkActivity.shared.end(distance: walk?.distance ?? distance, newBlocks: nil, dismiss: walk == nil)
        if let walk, UIApplication.shared.applicationState != .active {
            // On screen, the page shows its own summary card instead.
            WalkNotifier.walkRecorded(distance: walk.distance, duration: (walk.endedAt - walk.startedAt) / 1000)
        }
        updateMode()
        onAutoWalkFinished?()
    }

    /// "Finish walk" (in the app, or the Lock Screen card's button).
    func finishAutoWalkNow() {
        guard journal.current != nil else { return }
        waitForStop = true
        finishAutoWalk()
    }

    /// The automatic walk being recorded, for the page to show:
    /// { startedAt, distance, points: [[lat, lon, t, acc, speed, steps, gap]] }, or nil.
    func currentWalk() -> [String: Any]? {
        guard let walk = journal.current else { return nil }
        return [
            "startedAt": walk.startedAt,
            "distance": walk.distance,
            "points": walk.points.map { [$0.lat, $0.lon, $0.t, $0.acc, $0.speed, Double($0.steps ?? -1), $0.gap == true ? 1 : 0] },
        ]
    }

    /// The app is on screen during an automatic walk: show it on the Lock
    /// Screen too (iOS only allows starting that while the app is open).
    func showAutoWalkOnLockScreen() {
        guard let walk = journal.current, watches.isEmpty else { return }
        WalkActivity.shared.startIfNeeded(startedAt: Date(timeIntervalSince1970: walk.startedAt / 1000), distance: walk.distance, auto: true)
    }

    /// Steps per day from the phone's pedometer, which keeps the last 7 days:
    /// [{ day: "2026-11-04", steps }], oldest first. The page saves them, so its
    /// history grows past 7 days.
    func dailySteps(days: Int = 7) async -> [[String: Any]] {
        guard CMPedometer.isStepCountingAvailable(), CMPedometer.authorizationStatus() != .denied,
              CMPedometer.authorizationStatus() != .restricted else { return [] }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd"
        var out: [[String: Any]] = []
        for back in stride(from: days - 1, through: 0, by: -1) {
            guard let start = cal.date(byAdding: .day, value: -back, to: today),
                  let end = cal.date(byAdding: .day, value: 1, to: start) else { continue }
            let steps: Int? = await withCheckedContinuation { cont in
                pedometer.queryPedometerData(from: start, to: min(end, Date())) { data, _ in
                    cont.resume(returning: data?.numberOfSteps.intValue)
                }
            }
            if let steps { out.append(["day": format.string(from: start), "steps": steps]) }
        }
        return out
    }

    /// Counts steps while GPS records, so rides (subway, bus, car) can be told
    /// apart from walking: lots of distance, no steps.
    private func startPedometer() {
        guard CMPedometer.isStepCountingAvailable(), CMPedometer.authorizationStatus() != .denied,
              CMPedometer.authorizationStatus() != .restricted else { return }
        steps = 0
        pedometer.startUpdates(from: Date()) { [weak self] data, _ in
            guard let count = data?.numberOfSteps.intValue else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.steps = count } }
        }
    }

    private func stopPedometer() {
        pedometer.stopUpdates()
        steps = nil
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
            startPedometer()
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = 4
            manager.pausesLocationUpdatesAutomatically = false
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
            manager.startUpdatingLocation()
        case .idle:
            stopPedometer()
            manager.desiredAccuracy = kCLLocationAccuracyKilometer
            manager.distanceFilter = 200
            manager.pausesLocationUpdatesAutomatically = false
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = false
            manager.startUpdatingLocation()
        case .off:
            stopPedometer()
            manager.stopUpdatingLocation()
        }
    }

    private func handle(locations: [CLLocation]) {
        for location in locations where location.horizontalAccuracy >= 0 {
            lastFix = location
            guard mode == .precise else { continue }
            let point = TrackPoint(location, steps: steps)
            // Walks started in the app: the page gets every fix and filters them itself.
            if !watches.isEmpty { journal.queue(point) }
            guard Self.usable(location) else { continue }
            lastGoodFixAt = Date()
            if inZone(location) { zoneGap = true; continue } // a no-tracking area: nothing counts here
            if !watches.isEmpty || (journal.current != nil && !inVehicle) { WalkActivity.shared.add(location, steps: steps) }
            if journal.current != nil && !inVehicle {
                var p = point
                if zoneGap { p.gap = true; zoneGap = false } // don't join across the area
                journal.append(p)
            }
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
