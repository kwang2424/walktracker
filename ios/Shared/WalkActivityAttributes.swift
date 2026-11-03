import ActivityKit
import Foundation

/// The Lock Screen / Dynamic Island card for a walk started in the app. Shared
/// by the app (which starts and updates it) and the widget extension (which
/// draws it).
struct WalkActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// Meters walked so far.
        var distance: Double
        /// Steps from the phone's pedometer since the walk started, if known.
        var steps: Int?
        /// New blocks, as last counted by the app (counting pauses while the
        /// phone is locked, so this is only shown once the walk has ended).
        var newBlocks: Int?
        /// Set when the walk is over: the card then shows the final numbers.
        var endedAt: Date?
    }

    var startedAt: Date
}
