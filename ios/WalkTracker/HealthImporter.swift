import CoreLocation
import Foundation
import HealthKit

/// Reads walks from Apple Health: walking, running and hiking workouts that have a
/// GPS route (recorded with an Apple Watch, or the iPhone's Fitness/Workout apps).
/// Read-only: WalkTracker never writes to Health. Uses only Apple's HealthKit.
@MainActor
final class HealthImporter {
    private let store = HKHealthStore()
    private let types: [HKWorkoutActivityType] = [.walking, .running, .hiking]

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// Shows Apple's Health permission sheet the first time. (iOS never tells
    /// apps whether reading was allowed; if it wasn't, imports are just empty.)
    func authorize() async throws {
        try await store.requestAuthorization(toShare: [], read: [HKObjectType.workoutType(), HKSeriesType.workoutRoute()])
    }

    /// Workouts that started after `since` (ms since 1970), oldest first, at most
    /// `limit`. Workouts without a GPS route (treadmill, indoor) are skipped.
    func walks(since: Double, limit: Int) async throws -> (walks: [[String: Any]], more: Bool, cursor: Double) {
        let start = Date(timeIntervalSince1970: since / 1000)
        let kinds = NSCompoundPredicate(orPredicateWithSubpredicates: types.map { HKQuery.predicateForWorkouts(with: $0) })
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate),
            kinds,
        ])
        let query = HKSampleQueryDescriptor(
            predicates: [.workout(predicate)],
            sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
            limit: limit + 1
        )
        let workouts = try await query.result(for: store)
        let page = Array(workouts.prefix(limit))
        var walks: [[String: Any]] = []
        for workout in page {
            let points = try await routePoints(for: workout)
            guard points.count >= 2 else { continue }
            walks.append([
                "id": "health-\(workout.uuid.uuidString)",
                "startedAt": (workout.startDate.timeIntervalSince1970 * 1000).rounded(),
                "endedAt": (workout.endDate.timeIntervalSince1970 * 1000).rounded(),
                "points": points,
            ])
        }
        // Next page starts just after the last workout looked at (with or without a route).
        let cursor = page.last.map { ($0.startDate.timeIntervalSince1970 * 1000).rounded() + 1 } ?? since
        return (walks, workouts.count > limit, cursor)
    }

    /// The workout's GPS route as [lat, lon, time ms], thinned to one point every
    /// few meters and skipping poor fixes.
    private func routePoints(for workout: HKWorkout) async throws -> [[Double]] {
        let routeQuery = HKSampleQueryDescriptor(
            predicates: [.workoutRoute(HKQuery.predicateForObjects(from: workout))],
            sortDescriptors: [SortDescriptor(\.startDate, order: .forward)]
        )
        var points: [[Double]] = []
        var last: CLLocation?
        for route in try await routeQuery.result(for: store) {
            for try await location in HKWorkoutRouteQueryDescriptor(route).results(for: store) {
                guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 50 else { continue }
                if let last, location.distance(from: last) < 3 { continue }
                last = location
                points.append([
                    location.coordinate.latitude,
                    location.coordinate.longitude,
                    (location.timestamp.timeIntervalSince1970 * 1000).rounded(),
                ])
            }
        }
        return points
    }
}
