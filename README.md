# WalkTracker

Walk every block of New York City, like WalkNYC, except **your data stays on your device**.
No account, no server, and no tracking. It's a small web app you host yourself for free and add to your phone's home screen.

## What it does

- **Record walks** with your phone's GPS. Blocks turn green as you walk them, with a buzz and a
  "✓ E 15th St done · 1st Ave → 2nd Ave" note each time you finish one.
- **All of NYC**: every block in the five boroughs (about 102,000 blocks, 10,000 km of streets) counts toward
  your progress, with no setup.
- **Official neighborhoods**: progress for each of NYC's 2020 Neighborhood Tabulation Areas, grouped by borough.
  Zoomed out, neighborhoods are shaded by how much you've walked; tap one to zoom in. A chip shows the
  neighborhood you're looking at and its %.
- **Progress**: NYC-wide ring, blocks and km walked, this week's distance and new blocks, and your daily streak.
- **Per-street progress** for every street in each borough, with filters: in progress, not started, done.
- **Import past walks** from GPX files (Strava, Garmin, Google Takeout, Apple Health via an export app, etc.).
- **Fix mistakes**: tap any block to mark it walked or not walked by hand.
- **Own your data**: export a full backup (`.json`) or all walks as `.gpx` at any time. Import the backup on another device.
- **Mapbox map** (Mapbox GL JS with the Mapbox Standard style): Calm, Grey or Full color looks, with night
  colors in dark mode. 3D buildings are off to save battery and keep the blocks visible.
- Works offline once loaded (the map itself still needs a connection).

## iPhone app

There's also a real iPhone app in [`ios/`](ios/README.md): the same app, but it keeps recording with the phone
locked and can record walks automatically when you start walking. It uses only Apple's frameworks and installs
from a Mac with a free Apple ID (reinstall every 7 days). See [ios/README.md](ios/README.md).

## Battery

Recording a walk uses GPS and keeps the screen on, which are the two biggest battery costs. The app cuts both:

- **Battery saver screen**: 30 seconds after your last tap the screen turns black (10 seconds when the
  battery is under 20%). On OLED phones (most iPhones since the X, most recent Androids) black pixels use almost no
  power. The map stops redrawing too. Double-tap to wake it.
- **Smart GPS**: if you stand still for 90 seconds (a red light, a coffee), GPS turns off. The motion
  sensor, which uses far less power, watches for your next steps and turns GPS back on. Phones without
  motion access fall back to low-power location. On iPhone the app asks for motion access when you start a walk.
- **Fewer updates**: map redraws are batched, nothing is drawn while the screen is dark or the app is in
  the background, and the walk is saved every 20 seconds rather than on every GPS fix.

Both can be turned off in Settings.

## How "walked" is decided

Streets are split into blocks at every intersection. Each block gets sample points every 10 m, ignoring the
ends so that crossing a street doesn't count. A sample is covered when your GPS track passes within 25 m.
A block counts as walked once 80% of its samples are covered. GPS segments faster than 7 m/s (cars, subway,
bikes) and jumps over 100 m (signal loss) are ignored. You can tune these in `js/geo.js` (`DEFAULTS`).

Counted street types: primary, secondary, tertiary, residential, unclassified, living streets and pedestrian
streets (see `WALKABLE_HIGHWAYS`). Highways, service roads and park footpaths are left out.

## Put it on your phone

1. In this repo on GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or merge this branch). The workflow runs the tests and publishes the site to
   `https://<your-username>.github.io/walktracker/`.
3. Open that URL on your phone, then:
   - **iPhone (Safari)**: Share → *Add to Home Screen*.
   - **Android (Chrome)**: menu → *Install app*.
4. The first time it opens, the app asks for a **Mapbox token**:
   - Sign up or log in at [account.mapbox.com](https://account.mapbox.com/) (free for personal use).
   - Go to **Tokens → Create a token**. Under **URL restrictions** add your site, e.g.
     `https://<your-username>.github.io/walktracker/`, so nobody else can use the token.
   - Copy the token (starts with `pk.`) and paste it into the app. It's saved only on that device.
     To skip this on every device, put it in `js/config.js` instead. Public tokens are meant to be visible;
     the URL restriction is what protects it.
5. In Settings, tap **Protect storage from cleanup** so the browser never clears your data automatically.

Any static host works too (Netlify, Cloudflare Pages, your own server). HTTPS is required for GPS.

## Limitations

- **Keep the app open while recording.** Web apps can't use GPS in the background or with the phone locked.
  The app keeps the screen on for you (the Wake Lock API, plus a tiny silent looping video on iPhone, where
  Wake Lock is unreliable) and switches to the black battery saver screen. If you lock the phone or switch apps
  anyway, that stretch isn't tracked; when you come back, GPS restarts and the app tells you how long it missed.
  If the phone closes the app mid-walk, reopening it offers to continue the walk. To lock your phone while
  walking, record with any GPS app that exports GPX and import the file afterward.
- **iPhone: use it from the Home Screen.** In a Safari tab, iOS erases a site's data after 7 days without a visit,
  which would delete your walks. Home Screen apps are exempt; the app reminds you if you're in a tab.
  Export a backup now and then either way.
- **What Mapbox receives:** map tile requests for the areas you view (with your token and IP address), a
  "map load" count once per app launch with a random anonymous ID, and a daily active-user ping. Mapbox's
  performance reports are switched off. Your walks, GPS positions and progress are never sent.
- Street and neighborhood data comes from the app's own site; no other service is involved.
- NYC only for now. Other cities would need their own neighborhood boundaries (see below).

## Development

No build step: plain HTML, CSS and JavaScript modules. Mapbox GL JS v3.33 loads from Mapbox's CDN, pinned
with an integrity hash (see `index.html`), and is cached for offline use. Map settings live in `js/mapview.js`.

```sh
npm test          # unit tests (Node 20+)
npm start         # serve at http://localhost:8080
```

### NYC street data

The deploy workflow builds NYC's blocks and publishes them with the site under `data/nyc/` (not committed).
It runs on every deploy and every Monday, so street changes in OpenStreetMap show up within a week.

1. `scripts/download_extracts.py` downloads the OpenStreetMap extract listed in `scripts/regions.json`:
   [BBBike](https://download.bbbike.org/osm/bbbike/) first, then [Geofabrik](https://download.geofabrik.de/)
   as a backup. If both are down, the last good download is reused from the GitHub Actions cache.
2. `scripts/extract_streets.py` pulls out the walkable streets.
3. `scripts/build_city.mjs` splits them into blocks (with the same code the app uses) and files each block
   under the neighborhood its midpoint is in, using NYC's official 2020 Neighborhood Tabulation Areas
   (`scripts/data/nyc-neighborhoods-2020.geojson`, from NYC Open Data). Blocks outside the five boroughs are dropped.

The phone downloads a small index and the neighborhood outlines (~85 KB) at startup, then only the
neighborhoods you look at or have walked in (~20–60 KB each).

To build locally:

```sh
pip install osmium
python3 scripts/download_extracts.py scripts/regions.json osm
python3 scripts/extract_streets.py streets.json scripts/regions.json osm
node scripts/build_city.mjs streets.json data/nyc
```

| File | What's in it |
| --- | --- |
| `js/geo.js` | Splits OSM streets into blocks, matches GPS tracks to blocks, computes stats |
| `js/gpx.js` | GPX import/export |
| `js/power.js` | Stillness and motion detection for smart GPS |
| `js/awake.js` | Keeps the screen on during walks |
| `js/native.js` | Extra features when running inside the iPhone app |
| `js/stats.js` | Weekly stats, streaks, when each block was finished |
| `js/db.js` | On-device storage (IndexedDB), backup export/import |
| `js/city.js` | Loads NYC neighborhoods on demand and tracks progress in each |
| `scripts/download_extracts.py` | Downloads the OpenStreetMap extract, with fallbacks |
| `scripts/extract_streets.py` | Pulls the walkable streets out of the extract |
| `scripts/build_city.mjs`, `scripts/citylib.mjs` | Splits NYC into blocks and files them by neighborhood |
| `scripts/data/nyc-neighborhoods-2020.geojson` | NYC's official neighborhood boundaries |
| `js/mapview.js` | The Mapbox map: look settings, block and walk layers |
| `js/config.js` | Optional Mapbox token for all devices |
| `js/app.js` | Recording, stats, menus |
| `sw.js` | Offline caching |
