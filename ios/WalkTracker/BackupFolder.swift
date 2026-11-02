import Foundation
import UIKit
import UniformTypeIdentifiers

/// Automatic backups to a folder the person picks once (for example a folder in
/// iCloud Drive). iOS hands back a bookmark that lets the app keep writing there
/// later, without needing an iCloud entitlement (so it works with a free Apple ID).
@MainActor
final class BackupFolder: NSObject, UIDocumentPickerDelegate {
    private static let bookmarkKey = "backupFolderBookmark"
    /// Dated copies kept next to the main file, so one bad backup can't wipe out the rest.
    private static let keepDailyCopies = 10
    static let fileName = "WalkTracker backup.json"

    private var pick: CheckedContinuation<URL?, Never>?

    /// The chosen folder's name, or nil if none is set (or it can't be reached any more).
    var folderName: String? {
        guard let url = resolve() else { return nil }
        return FileManager.default.displayName(atPath: url.path)
    }

    /// Shows the Files folder picker. Returns the folder name, or nil if cancelled.
    func choose() async throws -> String? {
        guard let presenter = Self.topViewController() else { throw BackupError.noScreen }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        let url: URL? = await withCheckedContinuation { cont in
            pick = cont
            presenter.present(picker, animated: true)
        }
        guard let url else { return nil }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
        return FileManager.default.displayName(atPath: url.path)
    }

    func forget() {
        UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
    }

    /// Writes the backup as the main file plus a copy for today.
    func write(_ json: String, day: String) throws {
        guard let folder = resolve() else { throw BackupError.noFolder }
        let accessing = folder.startAccessingSecurityScopedResource()
        defer { if accessing { folder.stopAccessingSecurityScopedResource() } }
        let data = Data(json.utf8)

        try coordinatedWrite(data, to: folder.appendingPathComponent(Self.fileName))

        let copies = folder.appendingPathComponent("Older backups", isDirectory: true)
        try FileManager.default.createDirectory(at: copies, withIntermediateDirectories: true)
        try coordinatedWrite(data, to: copies.appendingPathComponent("WalkTracker backup \(day).json"))
        let old = (try? FileManager.default.contentsOfDirectory(atPath: copies.path)) ?? []
        for name in old.filter({ $0.hasPrefix("WalkTracker backup ") }).sorted().dropLast(Self.keepDailyCopies) {
            try? FileManager.default.removeItem(at: copies.appendingPathComponent(name))
        }
    }

    // MARK: - Helpers

    private func resolve() -> URL? {
        guard let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            return nil
        }
        if stale {
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
            }
        }
        return url
    }

    /// Files in iCloud Drive must be written through a file coordinator.
    private func coordinatedWrite(_ data: Data, to url: URL) throws {
        var coordError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { target in
            do { try data.write(to: target, options: .atomic) } catch { writeError = error }
        }
        if let error = coordError ?? writeError { throw error }
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController ?? scene?.windows.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    // MARK: - UIDocumentPickerDelegate

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        MainActor.assumeIsolated { finishPick(urls.first) }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { finishPick(nil) }
    }

    private func finishPick(_ url: URL?) {
        pick?.resume(returning: url)
        pick = nil
    }
}

enum BackupError: LocalizedError {
    case noFolder, noScreen
    var errorDescription: String? {
        switch self {
        case .noFolder: "The backup folder can't be reached. Choose it again in Settings."
        case .noScreen: "Can't show the folder picker right now."
        }
    }
}
