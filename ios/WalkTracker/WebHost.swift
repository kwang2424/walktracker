import SwiftUI
import UIKit
import WebKit

/// The web view that runs the app, plus the small things a browser normally
/// does for it: alert/confirm pop-ups, opening links in Safari, and saving
/// downloads (backup and GPX exports) through the share sheet.
@MainActor
final class WebHost: NSObject, ObservableObject {
    let webView: WKWebView
    private let location = LocationService.shared
    private var downloadFile: URL?

    override init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppConfig.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default() // walks and settings, kept in the app's private storage

        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: NativeBridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(LocationMessages(location: location), name: "location")
        content.addScriptMessageHandler(NativeCalls(location: location), contentWorld: .page, name: "native")
        config.userContentController = content

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true } // Safari > Develop, for debugging
        #endif

        location.deliver = { [weak self] points in self?.send(points) }
        location.deliverCurrent = { [weak self] id, point in
            self?.run("window.__nativeCurrent(\(id), \(Self.json(point)))")
        }
        location.deliverError = { [weak self] code, message in
            self?.run("window.__nativeLocationError(\(code), \(Self.json(message)))")
        }
        location.onAutoWalkFinished = { [weak self] in self?.notifyPage() }

        webView.load(URLRequest(url: AppConfig.startURL))
    }

    /// The app came to the foreground or went to the background.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            location.flush()
            notifyPage()
        case .background:
            location.journal.save()
        default:
            break
        }
    }

    private func send(_ points: [TrackPoint]) {
        guard !points.isEmpty else { return }
        run("window.__nativeLocations(\(Self.json(points)))")
    }

    /// Lets js/native.js pick up walks recorded while the app wasn't open.
    private func notifyPage() {
        run("window.dispatchEvent(new Event('native-walks'))")
    }

    private func run(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func json<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    private var presenter: UIViewController? {
        var top = webView.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

extension WebHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.shouldPerformDownload { return .download }
        guard let url = navigationAction.request.url else { return .cancel }
        if url.scheme == AppConfig.scheme || url.scheme == "blob" || url.scheme == "about" || url.scheme == "data" {
            return .allow
        }
        // Links to websites (like the Mapbox sign-up page) open in Safari.
        if navigationAction.targetFrame?.isMainFrame ?? true, url.scheme == "https" || url.scheme == "http" {
            await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS reclaimed the page's memory in the background; reload it.
        webView.load(URLRequest(url: AppConfig.startURL))
    }
}

extension WebHost: WKUIDelegate {
    // target="_blank" links
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume() })
            guard let presenter else { done.resume(); return }
            presenter.present(alert, animated: true)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: true) })
            guard let presenter else { done.resume(returning: false); return }
            presenter.present(alert, animated: true)
        }
    }
}

extension WebHost: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: url)
        downloadFile = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloadFile, let presenter else { return }
        // Save to Files, AirDrop, email...
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = webView
        presenter.present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadFile = nil
    }
}
