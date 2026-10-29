import Foundation

/// Settings for the iPhone app.
enum AppConfig {
    /// The app's own files (HTML, JavaScript, CSS) are built into the app and
    /// served under this private address, so nothing about the app itself is
    /// downloaded at run time.
    static let scheme = "walktracker"
    static let startURL = URL(string: "walktracker://app/index.html")!

    /// Where the NYC street data is published (the GitHub Pages site). Only
    /// /data/... requests go here; they're cached so the app works offline.
    static let dataSite = URL(string: "https://kwang2424.github.io/walktracker/")!
}
