import Foundation
import UIKit
import WebKit

/// JavaScript added to the page before anything else runs. It replaces
/// navigator.geolocation with the phone's own GPS (which keeps working in the
/// background), and exposes `window.walktrackerNative` to js/native.js.
enum NativeBridge {
    static let script = #"""
    (() => {
      const watches = new Map();
      const once = new Map();
      let nextId = 1;
      const post = (msg) => window.webkit.messageHandlers.location.postMessage(msg);
      const toPosition = (p) => ({
        coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc, speed: p.speed >= 0 ? p.speed : null,
                  altitude: null, altitudeAccuracy: null, heading: null },
        timestamp: p.t,
      });
      const toError = (code, message) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });

      // Called by the app with points in time order (possibly a batch recorded in the background).
      window.__nativeLocations = (points) => {
        for (const p of points) for (const w of [...watches.values()]) w.ok(toPosition(p));
      };
      window.__nativeCurrent = (id, p) => {
        const req = once.get(id);
        if (req) { once.delete(id); clearTimeout(req.timer); req.ok(toPosition(p)); }
      };
      window.__nativeLocationError = (code, message) => {
        for (const w of watches.values()) w.err?.(toError(code, message));
        for (const [id, req] of once) { once.delete(id); clearTimeout(req.timer); req.err?.(toError(code, message)); }
      };

      const geolocation = {
        watchPosition(ok, err) {
          const id = nextId++;
          watches.set(id, { ok, err });
          post({ cmd: 'watch', id });
          return id;
        },
        clearWatch(id) {
          if (watches.delete(id)) post({ cmd: 'clearWatch', id });
        },
        getCurrentPosition(ok, err, opts = {}) {
          const id = nextId++;
          const timer = setTimeout(() => { if (once.delete(id)) err?.(toError(3, 'Timed out')); }, opts.timeout || 20000);
          once.set(id, { ok, err, timer });
          post({ cmd: 'getCurrent', id });
        },
      };
      Object.defineProperty(navigator, 'geolocation', { value: geolocation, configurable: true });

      window.walktrackerNative = {
        platform: 'ios',
        call: (cmd, args = {}) => window.webkit.messageHandlers.native.postMessage({ cmd, ...args }),
      };
    })();
    """#
}

/// Geolocation messages from the page (no reply needed).
@MainActor
final class LocationMessages: NSObject, WKScriptMessageHandler {
    private let location: LocationService

    init(location: LocationService) {
        self.location = location
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String,
              let id = (body["id"] as? NSNumber)?.intValue else { return }
        switch cmd {
        case "watch": location.watch(id: id)
        case "clearWatch": location.clearWatch(id: id)
        case "getCurrent": location.getCurrent(id: id)
        default: break
        }
    }
}

/// Calls from js/native.js that return an answer.
@MainActor
final class NativeCalls: NSObject, WKScriptMessageHandlerWithReply {
    private let location: LocationService
    private let health = HealthImporter()

    init(location: LocationService) {
        self.location = location
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return (nil, "Bad message")
        }
        switch cmd {
        case "status":
            return (location.status(), nil)
        case "takeWalks":
            // Plain JSON-compatible values only.
            let walks = location.journal.pending().map { walk in
                [
                    "id": walk.id,
                    "startedAt": walk.startedAt,
                    "endedAt": walk.endedAt,
                    "points": walk.points.map { [$0.lat, $0.lon, $0.t] },
                ] as [String: Any]
            }
            return (walks, nil)
        case "ackWalks":
            location.journal.acknowledge(body["ids"] as? [String] ?? [])
            return (true, nil)
        case "setAutoTrack":
            location.setAutoTrack(body["on"] as? Bool ?? false)
            return (location.status(), nil)
        case "healthAvailable":
            return (health.isAvailable, nil)
        case "healthImport":
            // A page of workouts after `since`; the page keeps asking while `more` is true.
            guard health.isAvailable else { return (nil, "Apple Health isn't available on this device") }
            do {
                try await health.authorize()
                let since = (body["since"] as? NSNumber)?.doubleValue ?? 0
                let limit = (body["limit"] as? NSNumber)?.intValue ?? 20
                let page = try await health.walks(since: since, limit: limit)
                return (["walks": page.walks, "more": page.more, "cursor": page.cursor] as [String: Any], nil)
            } catch {
                return (nil, error.localizedDescription)
            }
        case "openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
            return (true, nil)
        default:
            return (nil, "Unknown command \(cmd)")
        }
    }
}
