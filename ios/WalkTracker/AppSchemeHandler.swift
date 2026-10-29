import Foundation
import WebKit

/// Serves walktracker://app/... to the web view.
/// - /data/... is the NYC street data, fetched from the website and cached on
///   the phone (so it keeps working offline).
/// - Everything else is a file built into the app (Resources/web).
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let webRoot: URL
    private let session: URLSession
    private var stopped = Set<ObjectIdentifier>()

    override init() {
        webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(memoryCapacity: 20_000_000, diskCapacity: 300_000_000)
        config.requestCachePolicy = .useProtocolCachePolicy
        session = URLSession(configuration: config)
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        if path.hasPrefix("/data/") {
            fetchData(path: String(path.dropFirst()), query: url.query, task: task)
        } else {
            serveFile(path: String(path.dropFirst()), task: task)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    // MARK: - Built-in files

    private func serveFile(path: String, task: WKURLSchemeTask) {
        let file = webRoot.appendingPathComponent(path).standardizedFileURL
        // Never serve anything outside the web folder (e.g. "../").
        guard file.path.hasPrefix(webRoot.path + "/"), let data = try? Data(contentsOf: file) else {
            respond(task, status: 404, type: "text/plain", data: Data("Not found".utf8), url: task.request.url!)
            return
        }
        respond(task, status: 200, type: Self.mimeType(for: file.pathExtension), data: data, url: task.request.url!)
    }

    // MARK: - Street data from the website, cached

    private func fetchData(path: String, query: String?, task: WKURLSchemeTask) {
        var components = URLComponents(url: AppConfig.dataSite.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.query = query
        let remote = components.url!
        let original = task.request.url!
        Task { @MainActor in
            var request = URLRequest(url: remote)
            var result = try? await session.data(for: request)
            if result == nil {
                // Offline: fall back to whatever was cached last time.
                request.cachePolicy = .returnCacheDataDontLoad
                result = try? await session.data(for: request)
            }
            guard let result, let http = result.1 as? HTTPURLResponse else {
                respond(task, status: 503, type: "text/plain", data: Data("Offline".utf8), url: original)
                return
            }
            respond(task, status: http.statusCode, type: Self.mimeType(for: remote.pathExtension), data: result.0, url: original)
        }
    }

    // MARK: - Helpers

    private func respond(_ task: WKURLSchemeTask, status: Int, type: String, data: Data, url: URL) {
        guard !stopped.contains(ObjectIdentifier(task)) else { return }
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "geojson": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        default: return "application/octet-stream"
        }
    }
}
