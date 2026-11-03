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
        steps: p.steps, // running step count from the phone's pedometer, if known
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
    private let backup = BackupFolder()

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
                    "points": walk.points.map { [$0.lat, $0.lon, $0.t, $0.acc, $0.speed, Double($0.steps ?? -1), $0.gap == true ? 1 : 0] },
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
        case "backupFolder":
            return (backup.folderName.map { $0 as Any } ?? NSNull(), nil)
        case "chooseBackupFolder":
            do {
                let name = try await backup.choose()
                return (name.map { $0 as Any } ?? NSNull(), nil)
            } catch {
                return (nil, error.localizedDescription)
            }
        case "forgetBackupFolder":
            backup.forget()
            return (true, nil)
        case "writeBackup":
            guard let json = body["json"] as? String else { return (nil, "No backup data") }
            do {
                try backup.write(json, day: body["day"] as? String ?? "latest")
                return (true, nil)
            } catch {
                return (nil, error.localizedDescription)
            }
        case "setZones":
            let raw = body["zones"] as? [[String: Any]] ?? []
            location.zones = raw.compactMap { z in
                guard let lat = (z["lat"] as? NSNumber)?.doubleValue, let lon = (z["lon"] as? NSNumber)?.doubleValue,
                      let r = (z["r"] as? NSNumber)?.doubleValue else { return nil }
                let ring = (z["ring"] as? [[NSNumber]])?.map { $0.map(\.doubleValue) }
                return LocationService.Zone(lat: lat, lon: lon, r: r, ring: ring, pad: (z["pad"] as? NSNumber)?.doubleValue)
            }
            return (true, nil)
        case "walkActivity":
            // The Lock Screen / Dynamic Island card for a walk started in the app.
            let distance = (body["distance"] as? NSNumber)?.doubleValue ?? 0
            let blocks = (body["newBlocks"] as? NSNumber)?.intValue
            switch body["action"] as? String {
            case "start":
                let started = (body["startedAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } ?? Date()
                WalkActivity.shared.start(startedAt: started, distance: distance)
            case "update": WalkActivity.shared.update(distance: distance, newBlocks: blocks)
            case "end": WalkActivity.shared.end(distance: distance, newBlocks: blocks)
            case "discard": WalkActivity.shared.end(distance: distance, newBlocks: nil, dismiss: true)
            default: break
            }
            return (true, nil)
        case "openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
            return (true, nil)
        default:
            return (nil, "Unknown command \(cmd)")
        }
    }
}
