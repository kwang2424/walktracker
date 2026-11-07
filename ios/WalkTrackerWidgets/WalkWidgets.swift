import ActivityKit
import SwiftUI
import WidgetKit

@main
struct WalkTrackerWidgets: WidgetBundle {
    var body: some Widget {
        WalkLiveActivity()
    }
}

/// A walk in progress on the Lock Screen and in the Dynamic Island: a running
/// clock, distance and steps. Once the walk ends: the totals and new blocks.
struct WalkLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WalkActivityAttributes.self) { context in
            LockScreenView(start: context.attributes.startedAt, state: context.state, auto: context.attributes.auto)
                .activityBackgroundTint(Color(.systemBackground).opacity(0.9))
        } dynamicIsland: { context in
            let state = context.state
            let start = context.attributes.startedAt
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label { ElapsedText(start: start, end: state.endedAt) } icon: { Image(systemName: "figure.walk") }
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(Theme.green)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(Format.distance(state.distance)).font(.headline.monospacedDigit())
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(Format.detail(state)).font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        if context.attributes.auto && state.endedAt == nil { FinishButton() }
                    }
                }
            } compactLeading: {
                Image(systemName: state.endedAt == nil ? "figure.walk" : "checkmark.circle.fill").foregroundStyle(Theme.green)
            } compactTrailing: {
                Text(Format.distance(state.distance)).monospacedDigit().foregroundStyle(Theme.green)
            } minimal: {
                Image(systemName: "figure.walk").foregroundStyle(Theme.green)
            }
        }
    }
}

private enum Theme {
    static let green = Color(red: 0.02, green: 0.59, blue: 0.41)
}

/// Ends an automatic walk from the Lock Screen (runs in the app; see Shared/WalkIntents.swift).
private struct FinishButton: View {
    var body: some View {
        Button(intent: FinishWalkIntent()) {
            Label("Finish", systemImage: "stop.fill").font(.caption.weight(.semibold))
        }
        .tint(Theme.green)
    }
}

private struct LockScreenView: View {
    let start: Date
    let state: WalkActivityAttributes.ContentState
    let auto: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            row
            if auto && state.endedAt == nil {
                HStack {
                    Text("Recording automatically").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    FinishButton()
                }
            }
        }
        .padding(16)
    }

    private var row: some View {
        HStack(spacing: 14) {
            Image(systemName: state.endedAt == nil ? "figure.walk" : "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Theme.green))
            VStack(alignment: .leading, spacing: 2) {
                Text(state.endedAt == nil ? "Walking" : "Walk saved").font(.subheadline.weight(.semibold))
                Text(Format.detail(state)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.distance(state.distance)).font(.title3.weight(.bold).monospacedDigit())
                ElapsedText(start: start, end: state.endedAt).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }
}

/// A clock that keeps counting on its own while walking, fixed once ended.
private struct ElapsedText: View {
    let start: Date
    let end: Date?

    var body: some View {
        if let end {
            Text(Format.duration(end.timeIntervalSince(start)))
        } else {
            Text(timerInterval: start...Date.distantFuture, countsDown: false)
        }
    }
}

enum Format {
    static func distance(_ meters: Double) -> String {
        meters < 10000 ? String(format: "%.1f km", meters / 1000) : String(format: "%.0f km", meters / 1000)
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let m = Int(seconds / 60)
        return m < 60 ? "\(m) min" : "\(m / 60) h \(m % 60) min"
    }

    static func detail(_ s: WalkActivityAttributes.ContentState) -> String {
        var parts: [String] = []
        if let steps = s.steps { parts.append("\(steps.formatted()) steps") }
        if s.endedAt != nil, let blocks = s.newBlocks { parts.append("\(blocks) new block\(blocks == 1 ? "" : "s")") }
        if parts.isEmpty { parts.append(s.endedAt == nil ? "Recording with the phone locked" : "Open WalkTracker for details") }
        return parts.joined(separator: " · ")
    }
}
