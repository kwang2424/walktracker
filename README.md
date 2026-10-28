# WalkTracker

Walk every block of your city, like WalkNYC or CityStrides, except **your data stays on your device**.
No account, no server, and no tracking. It's a small web app you host yourself for free and add to your phone's home screen.

## What it does

- **Record walks** with your phone's GPS. Blocks turn green as you walk them, with a buzz and a
  "✓ E 15th St done · 1st Ave → 2nd Ave" note each time you finish one.
- **Progress**: a progress ring, blocks and km walked, this week's distance and new blocks, and your daily streak.
- **Per-street progress** with filters: in progress, not started, done.
- **Any city**: pan the map to a neighborhood and tap *Add streets on screen*. Streets come from OpenStreetMap
  and the area is named after the neighborhood automatically.
- **Built-in street data for New York City**: adding an area in NYC loads in about a second from the app's own
  site, with no outside server involved, and you can add up to 120 km² at once (all of Manhattan is ~60).
  Other places use the public Overpass servers, which are often busy.
- **Import past walks** from GPX files (Strava, Garmin, Google Takeout, Apple Health via an export app, etc.).
- **Fix mistakes**: tap any block to mark it walked or not walked by hand.
- **Own your data**: export a full backup (`.json`) or all walks as `.gpx` at any time. Import the backup on another device.
- **Mapbox map** (Mapbox GL JS with the Mapbox Standard style): Calm, Grey or Full color looks, with night
  colors in dark mode. 3D buildings are off to save battery and keep the blocks visible.
- Works offline once loaded (the map itself still needs a connection).

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

- **Don't lock the phone while recording.** Web apps can't use GPS while the phone is locked, so the app keeps
  the screen awake and uses the black battery saver screen instead. If you'd rather lock your phone, record
  with any GPS app that exports GPX and import the file afterward.
- Your data lives in this browser on this device. Export backups now and then. Deleting the home-screen
  app or clearing site data deletes it.
- **What Mapbox receives:** map tile requests for the areas you view (with your token and IP address), a
  "map load" count once per app launch with a random anonymous ID, and a daily active-user ping. Mapbox's
  performance reports are switched off. Your walks, GPS positions and progress are never sent.
- Street data inside the built-in regions comes from the app's own site. Elsewhere it comes from public
  Overpass servers (`overpass-api.de` and two backups, no account). Only the area you add is sent, never your walks.

## Development

No build step: plain HTML, CSS and JavaScript modules. Mapbox GL JS v3.33 loads from Mapbox's CDN, pinned
with an integrity hash (see `index.html`), and is cached for offline use. Map settings live in `js/mapview.js`.

```sh
npm test          # unit tests (Node 20+)
npm start         # serve at http://localhost:8080
```

### Built-in street data

The deploy workflow downloads OpenStreetMap extracts for the regions in `scripts/regions.json` and turns
them into small tiles under `data/streets/`. It runs on every deploy and every Monday, so the data stays fresh.
The tiles aren't committed.

It's built so a download site being down never blocks an update:
1. Each region lists sources in order: [BBBike](https://download.bbbike.org/osm/bbbike/) first, then
   [Geofabrik](https://download.geofabrik.de/) (a bigger file, clipped to the region's box).
2. If every source fails, the last good download is reused from the GitHub Actions cache.
3. If there's still nothing, the site deploys without built-in data and the app uses the public servers.

To add a city, add an entry with its download URL(s) and bounding box to `regions.json`.

To build locally:

```sh
pip install osmium
python3 scripts/download_extracts.py scripts/regions.json osm
python3 scripts/build_streets.py data/streets scripts/regions.json osm
```

| File | What's in it |
| --- | --- |
| `js/geo.js` | Splits OSM streets into blocks, matches GPS tracks to blocks, computes stats |
| `js/gpx.js` | GPX import/export |
| `js/power.js` | Stillness and motion detection for smart GPS |
| `js/stats.js` | Weekly stats, streaks, when each block was finished |
| `js/db.js` | On-device storage (IndexedDB), backup export/import |
| `js/streets.js` | Loads built-in street tiles for an area |
| `scripts/download_extracts.py` | Downloads the OpenStreetMap extracts, with fallbacks |
| `scripts/build_streets.py` | Builds the street tiles from an OpenStreetMap extract |
| `js/mapview.js` | The Mapbox map: look settings, block and walk layers |
| `js/config.js` | Optional Mapbox token for all devices |
| `js/app.js` | Recording, stats, menus |
| `sw.js` | Offline caching |
