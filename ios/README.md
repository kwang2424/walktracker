# WalkTracker for iPhone

The same WalkTracker app, as a real iPhone app, so it can:

- **keep recording with the phone locked** or the app in the background, and
- **record walks automatically**: the motion sensor notices when you start walking, and the walk is
  recorded even if the app is closed. Between walks only low-power location runs, and
- **import walks from Apple Health**: walking, running and hiking workouts with a GPS route (Apple Watch or
  iPhone), so your past walks count too. Read-only; new workouts are added whenever you open the app.

It's built only from Apple's own frameworks (WebKit, Core Location, Core Motion, HealthKit, SwiftUI): no third-party
code or plugins. The web app's files are built into the app; only NYC's street data is downloaded from the
website (and cached for offline use). Your walks stay in the app's private storage on your phone.

## Install it on your iPhone (about 10 minutes the first time)

You need a Mac with **Xcode** (free from the Mac App Store, version 16 or newer) and your iPhone's cable.

1. **Get the code on the Mac.** In Terminal:
   ```sh
   git clone https://github.com/kwang2424/walktracker.git
   open walktracker/ios/WalkTracker.xcodeproj
   ```
   (Or on GitHub: **Code → Download ZIP**, unzip, and double-click `ios/WalkTracker.xcodeproj`.)
2. **Sign in with your Apple ID.** Xcode → Settings → Accounts → **+** → Apple ID. A free Apple ID is fine.
3. **Pick your signing team.** Click **WalkTracker** at the top of the left sidebar → **Signing & Capabilities**
   → set **Team** to your name (Personal Team). Do the same for the **WalkTrackerWidgets** target (pick it
   in the target list on the left of that screen): it's the Lock Screen / Dynamic Island card.
   If Xcode says the bundle identifier isn't available, change it to something unique, like
   `io.github.yourname.walktracker`, and the widget's to the same plus `.widgets`.
4. **Connect your iPhone** with the cable and unlock it. Tap **Trust** if asked.
   On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** (it restarts the phone).
5. **Pick your iPhone** in the device menu at the top of Xcode, then press **▶ Run**.
6. The first time, iPhone blocks apps from a new developer: on the iPhone, go to **Settings → General →
   VPN & Device Management**, tap your Apple ID, and tap **Trust**. Then open WalkTracker.

### In the app

- Paste your Mapbox token. Make a **separate token for the app with no URL restrictions**
  (the app has no web address to restrict it to).
- Allow location. To record walks automatically: Menu → Settings → **Record walks automatically**, then
  allow motion access and set location to **Always** (iPhone asks; or Settings → WalkTracker → Location).
- To bring in past walks: Menu → Settings → **Import walks from Apple Health**, and allow access to Workouts
  and Workout Routes when Apple asks. (Apple Health works with a free Apple ID.)
- Walks you start with **Start walk** show a running clock, distance and steps on the Lock Screen and in
  the Dynamic Island. Automatic walks send a "Walk recorded" notification when they end (allow
  notifications when asked); open the app for a summary card with your new blocks.
- To keep a copy off the phone: Menu → Settings → **Choose backup folder**, and pick a folder in iCloud
  Drive. After every change the app saves `WalkTracker backup.json` there (plus daily copies in
  `Older backups`, last 10 days). To restore, use **Import backup** and pick that file.
- Your walks from the website don't move over automatically. Export a backup there (Settings → Export
  backup) and import it in the app.

## Every 7 days (free Apple ID)

Apps installed with a free Apple ID stop opening after 7 days. Plug the phone into the Mac and press
**▶ Run** again; your walks are kept. A paid Apple Developer account ($99/year) makes installs last a year.

## Updating

Pull the latest code (`git pull` in the `walktracker` folder) and press **▶ Run**.

If `git pull` says your local changes to `project.pbxproj` would be overwritten (Xcode saves your team
there), run `git checkout -- ios/WalkTracker.xcodeproj/project.pbxproj`, pull again, and pick your team
again (step 3).

## How it fits together

| File | What it does |
| --- | --- |
| `WalkTracker/WalkTrackerApp.swift` | App entry point; starts GPS handling even when iOS launches the app in the background |
| `WalkTracker/WebHost.swift` | The web view, plus pop-ups, links, and saving exports via the share sheet |
| `WalkTracker/AppSchemeHandler.swift` | Serves the built-in web app, and the street data from the website (cached) |
| `WalkTracker/NativeBridge.swift` | Connects the page to the phone: GPS in place of the browser's, and app commands |
| `WalkTracker/LocationService.swift` | GPS and motion: walks you start, and automatic walks |
| `WalkTracker/WalkJournal.swift` | Saves walks recorded in the background until the app takes them |
| `WalkTracker/WalkActivity.swift` | Lock Screen / Dynamic Island card for a walk, and "Walk recorded" notifications |
| `WalkTrackerWidgets/` | The widget extension that draws that card |
| `Shared/WalkActivityAttributes.swift` | What the card shows (used by the app and the widget) |
| `WalkTracker/BackupFolder.swift` | Automatic backups to a folder you pick once in Files (e.g. iCloud Drive) |
| `WalkTracker/HealthImporter.swift` | Reads walking workouts and their routes from Apple Health (read-only) |
| `WalkTracker.entitlements` | Turns on Apple Health access |
| `WalkTracker/AppConfig.swift` | The website address for street data |
| `copy-web-app.sh` | Build step that copies the web app into the iPhone app |

The GitHub Actions workflow `.github/workflows/ios.yml` builds the app on every change, to catch mistakes early.
