import SwiftUI
import WebKit

@main
struct WalkTrackerApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var host = WebHost()

    init() {
        // Start GPS handling right away: iOS may launch the app in the
        // background just to deliver location (auto-tracking), with no screen.
        _ = LocationService.shared
    }

    var body: some Scene {
        WindowGroup {
            WebView(webView: host.webView)
                .ignoresSafeArea()
        }
        .onChange(of: scenePhase) { _, phase in
            host.scenePhaseChanged(phase)
        }
    }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
