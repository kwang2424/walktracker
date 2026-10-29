import CoreLocation
import Foundation

/// One GPS fix. Times are milliseconds since 1970, like JavaScript's Date.now().
struct TrackPoint: Codable {
    let lat: Double
    let lon: Double
    let t: Double
    let acc: Double
    let speed: Double

    init(_ location: CLLocation) {
        lat = location.coordinate.latitude
        lon = location.coordinate.longitude
        t = (location.timestamp.timeIntervalSince1970 * 1000).rounded()
        acc = location.horizontalAccuracy
        speed = location.speed
    }

    var location: CLLocation { CLLocation(latitude: lat, longitude: lon) }
}

/// Walks recorded by the phone itself (auto-tracking), plus GPS points waiting
/// to be handed to the web app. Saved to a file in the app's private storage,
/// so nothing is lost if iOS closes the app in the background. The web app
/// takes finished walks when it opens and confirms once it has saved them.
final class WalkJournal {
    struct Walk: Codable {
        var id: String
        var startedAt: Double
        var endedAt: Double
        var points: [TrackPoint]

        var distance: Double {
            zip(points, points.dropFirst()).reduce(0) { $0 + $1.0.location.distance(from: $1.1.location) }
        }
    }

    private struct State: Codable {
        var finished: [Walk] = []
        var current: Walk?
        var outbox: [TrackPoint] = [] // points for a walk started in the web app
    }

    private var state = State()
    private var unsaved = 0
    private let file: URL

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("walk-journal.json")
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(State.self, from: data) {
            state = saved
        }
    }

    var current: Walk? { state.current }
    var finishedCount: Int { state.finished.count }

    // MARK: Auto-tracked walks

    func begin() {
        let now = Date().timeIntervalSince1970 * 1000
        state.current = Walk(id: UUID().uuidString, startedAt: now, endedAt: now, points: [])
        save()
    }

    func append(_ point: TrackPoint) {
        guard state.current != nil else { return }
        state.current!.points.append(point)
        state.current!.endedAt = point.t
        saveSoon()
    }

    /// Ends the current walk. Very short ones (GPS noise, a few steps) are dropped.
    func finishCurrent(minDistance: Double = 100) {
        guard let walk = state.current else { return }
        state.current = nil
        if walk.points.count >= 2 && walk.distance >= minDistance {
            state.finished.append(walk)
        }
        save()
    }

    /// Finished walks the web app hasn't saved yet.
    func pending() -> [Walk] { state.finished }

    /// The web app saved these; forget them.
    func acknowledge(_ ids: [String]) {
        let done = Set(ids)
        state.finished.removeAll { done.contains($0.id) }
        save()
    }

    // MARK: Points for a walk running in the web app

    func queue(_ point: TrackPoint) {
        state.outbox.append(point)
        saveSoon()
    }

    func takeOutbox() -> [TrackPoint] {
        let points = state.outbox
        state.outbox.removeAll()
        if !points.isEmpty { saveSoon() }
        return points
    }

    func clearOutbox() {
        guard !state.outbox.isEmpty else { return }
        state.outbox.removeAll()
        save()
    }

    // MARK: Saving

    private func saveSoon() {
        unsaved += 1
        if unsaved >= 15 { save() }
    }

    func save() {
        unsaved = 0
        guard let data = try? JSONEncoder().encode(state) else { return }
        // Readable/writable while the phone is locked (after the first unlock),
        // so background walks can be saved, but encrypted when it restarts.
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
