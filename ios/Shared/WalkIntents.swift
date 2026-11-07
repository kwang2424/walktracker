import AppIntents
import Foundation

/// What the Lock Screen card's Finish button calls. The app sets it at launch;
/// iOS runs Live Activity buttons inside the app, starting it if needed.
enum WalkControl {
    @MainActor static var finish: (@MainActor () -> Void)?
}

/// The Finish button on an automatic walk's Lock Screen / Dynamic Island card.
struct FinishWalkIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Finish walk"
    static var description = IntentDescription("Ends the automatic walk being recorded and saves it.")

    init() {}

    func perform() async throws -> some IntentResult {
        await MainActor.run { WalkControl.finish?() }
        return .result()
    }
}
