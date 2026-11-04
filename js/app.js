import { haversine, midpoint, polylineLength, pointInMultiPolygon } from './geo.js';
import { parseGpx, toGpx } from './gpx.js';
import { db } from './db.js';
import { StillnessDetector, MotionWake, throttle } from './power.js';
import { streak, weekStats, totals, bestStreak, weeklyTotals, dailyTotals } from './stats.js';
import { evaluate, factsFrom } from './achievements.js';
import { weeklyChart, calendarChart, stepsChart } from './charts.js';
import { MapView, BLOCKS_MIN_ZOOM } from './mapview.js';
import { Places, ROUTE_COLORS } from './places.js';
import { drawBadge } from './placeicons.js';
import { LiveFilter, isRiding } from './track.js';
import { ZONE_SIZES, BLOCK_PAD, inZone, withoutZones, runsOf } from './zones.js';
import { blockAround } from './blockface.js';
import { walkDetails, formatPace, trimWalk, untrimWalk } from './walkstats.js';
import { MAPBOX_TOKEN } from './config.js';
import { City, overrideWalked } from './city.js';
import { KeepAwake, isIOS } from './awake.js';
import { native, nativeWalkToTrack } from './native.js';

const MAX_VISIBLE_HOODS = 30; // load blocks for at most this many neighborhoods on screen
const RESUME_WITHIN_MS = 3 * 3600000; // offer to continue a walk the phone closed within this time
const INSTALL_TIP_EVERY_MS = 3 * 86400000;
const MIN_ACCURACY_M = 35; // ignore GPS fixes worse than this
const MIN_STEP_M = 4; // ignore jitter while standing still
const SAVE_EVERY_MS = 20000;
const AUTO_DARK_MS = 30000;
const AUTO_DARK_LOW_BATTERY_MS = 10000;
const SAFETY_CHECK_MS = 180000; // while paused, peek at GPS this often in case motion was missed
const RING = 175.93; // circumference of the progress ring (r = 28)

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'walktracker.settings';
const settings = { autoDark: true, smartGps: true, mapTheme: 'faded', showTracks: true, hudScope: 'hood', showLandmarks: true, showStations: true, showHeatmap: false, zones: [] };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* private mode */ }
if (settings.detailedMap) settings.mapTheme = 'default'; // older setting
delete settings.detailedMap;
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- state
// All of NYC by neighborhood; only the ones you look at or walked in are loaded.
const city = new City({ onLoad: (id) => onHoodLoaded(id) });
let overrides = {}; // block id -> { walked, hood }
let tracks = [];
let nodeNames = new Map(); // OSM node id -> street names meeting there
let lastSummary = null;
let outlines = null; // neighborhood outlines (GeoJSON)
let places = null; // landmarks and subway stations
let placeVisits = new Map(); // place key -> first visit time
let streetTotals = null; // every street with its block count, loaded when needed
let rec = null; // the walk being recorded
let pocketOn = false;
let lowBattery = false;

const asleep = () => pocketOn || document.hidden;

// ---------------------------------------------------------------- map
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const mapLook = () => ({ theme: settings.mapTheme, dark: darkQuery.matches });
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const colors = {};
  for (const k of ['walked', 'partial', 'unwalked', 'track']) colors[k] = cs.getPropertyValue(`--${k}`).trim();
  return colors;
}

// ---------------------------------------------------------------- Mapbox token
// The token lives on this device (pasted in the app) or in js/config.js. It's
// saved twice, in localStorage and IndexedDB, so it survives if the browser
// clears one of them.
const TOKEN_KEY = 'walktracker.mapboxToken';
let savedToken = '';

function readLocalToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function loadToken() {
  let t = readLocalToken();
  if (!t) {
    // Don't let a stuck IndexedDB hold up the app.
    const fromDb = db.get('meta', 'mapboxToken').catch(() => '');
    t = (await Promise.race([fromDb, new Promise((r) => setTimeout(() => r(''), 2000))])) || '';
    if (t) { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } }
  }
  return t || MAPBOX_TOKEN;
}

async function saveToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  try { await db.put('meta', token, 'mapboxToken'); } catch { /* ignore */ }
  // Ask the browser not to clear this site's storage on its own.
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
}

const getToken = () => savedToken;

function showSetup(message = '') {
  const token = getToken();
  $('#setup').hidden = false;
  $('#setup-error').hidden = !message;
  $('#setup-error').textContent = message;
  if (native) {
    // The app has no web address to restrict a token to.
    $('#setup-step-url').textContent = 'Open Tokens and tap Create a token. Leave URL restrictions empty: the iPhone app has no web address to restrict it to.';
  } else {
    $('#setup-url').textContent = location.origin + location.pathname.replace(/index\.html$/, '');
  }
  $('#setup-token').value = token || '';
  $('#setup-cancel').hidden = !token || !!message;
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#setup-token').value.trim();
  if (!/^pk\.[\w-]+\.[\w-]+$/.test(token)) {
    $('#setup-error').hidden = false;
    $('#setup-error').textContent = 'That doesn’t look like a public Mapbox token. It should start with “pk.”';
    return;
  }
  await saveToken(token);
  location.reload();
});
$('#setup-cancel').addEventListener('click', () => { $('#setup').hidden = true; });

let lastDrag = 0;
savedToken = await loadToken();
const token = savedToken;
const mapLibLoaded = typeof window.mapboxgl !== 'undefined';
const view = token && mapLibLoaded ? new MapView($('#map'), {
  token,
  ...mapLook(),
  colors: readColors(),
  onBlockClick: (id, at) => openBlockPopup(id, at),
  onHoodClick: (i) => openHood(city.index.hoods[i].id),
  onPlaceClick: (i) => openPlacePopup(i),
  onUserMove: () => { lastDrag = Date.now(); },
  onMoveEnd: () => onMapMoved(),
  onAuthError: (status) => showSetup(`Mapbox didn’t accept this token (error ${status}). Check that it’s copied fully, and if it has URL restrictions, that they include ${location.origin + location.pathname.replace(/index\.html$/, '')}`),
}) : null;
view?.setPlaceKinds({ landmark: settings.showLandmarks, station: settings.showStations });
view?.setHeatVisible(settings.showHeatmap);
queueMicrotask(() => renderLegend());

function applyMapStyle() {
  view.setColors(readColors());
  view.setLook(mapLook());
  renderLegend();
}
if (view) darkQuery.addEventListener('change', applyMapStyle);

const isDone = (id) => city.isWalked(id, overrides);

function blockState(id) {
  if (isDone(id)) return 'walked';
  if (city.fraction(id) > 0.34) return 'partial';
  return 'none';
}

function drawBlocks() {
  const blocks = [...city.loadedBlocks(), ...city.loadedPaths()];
  view.setBlocks(blocks);
  for (const b of blocks) view.setBlockState(b.id, blockState(b.id));
}

// Map updates are batched to one per frame, and skipped entirely while the
// screen is dark or the app is in the background.
const pendingRestyle = new Set();
let flushQueued = false;
function queueRestyle(ids) {
  for (const id of ids) pendingRestyle.add(id);
  scheduleFlush();
}
function scheduleFlush() {
  if (flushQueued || asleep() || !pendingRestyle.size) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    flushQueued = false;
    for (const id of pendingRestyle) view.setBlockState(id, blockState(id));
    pendingRestyle.clear();
  });
}

// Neighborhoods finish loading one by one; redraw once they settle.
let redrawTimer = null;
function onHoodLoaded(id) {
  indexNodeNames(city.loaded.get(id).blocks);
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    city.refreshMatches();
    if (asleep()) { blocksDirty = true; return; }
    drawBlocks();
    renderStats();
  }, 120);
}
let blocksDirty = false;

// Legend badges are drawn by the same code as the map's, so they always match.
function renderLegend() {
  const { dark } = mapLook();
  for (const [kind, on] of [['landmark', settings.showLandmarks], ['station', settings.showStations]]) {
    const el = document.querySelector(`#legend [data-kind="${kind}"]`);
    if (!el) continue;
    el.hidden = !on;
    const img = el.querySelector('img');
    img.src = drawBadge(kind, false, { dark, ratio: 3 }).toDataURL();
  }
}

// Walks as they count: with the parts inside no-tracking areas left out.
const zonedCache = new WeakMap();
function zoned(list) {
  return list.map((t) => {
    const hit = zonedCache.get(t);
    if (hit && hit.zones === settings.zones) return hit.track;
    const track = withoutZones(t, settings.zones);
    zonedCache.set(t, { zones: settings.zones, track });
    return track;
  });
}

function drawTracks() {
  view.setTracks(zoned(tracks).flatMap(runsOf));
  drawHeat();
  view.setTracksVisible(settings.showTracks);
}

// ---------------------------------------------------------------- block names
// Block ids are "<way>:<from node>-<to node>:<n>", so the end nodes give the cross streets.
const endsOf = (block) => block.id.split(':')[1].split('-');

function indexNodeNames(blocks) {
  for (const block of blocks) {
    for (const n of endsOf(block)) {
      if (!nodeNames.has(n)) nodeNames.set(n, new Set());
      if (block.name) nodeNames.get(n).add(block.name);
    }
  }
}

function crossStreets(block) {
  const [from, to] = endsOf(block);
  const pick = (n) => [...(nodeNames.get(n) || [])].find((x) => x !== block.name) || '';
  const a = pick(from);
  const b = pick(to);
  if (a && b && a !== b) return `${a} → ${b}`;
  if (a || b) return `near ${a || b}`;
  return '';
}

function openBlockPopup(id, latlng) {
  const block = city.block(id);
  if (!block) return;
  const f = city.fraction(id);
  const manual = id in overrides;
  const done = isDone(id);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="pop-title"></div>
    <div class="pop-sub"></div>
    <span class="pop-status ${done ? 'walked' : f > 0.34 ? 'partial' : ''}"></span>
    <div class="pop-actions">
      <button data-act="toggle">${done ? 'Mark not walked' : 'Mark walked'}</button>
      ${manual ? '<button data-act="reset">Use GPS</button>' : ''}
    </div>`;
  el.querySelector('.pop-title').textContent = block.name || (block.plaza ? 'Plaza' : block.path ? 'Path' : 'Unnamed street');
  el.querySelector('.pop-sub').textContent = [
    block.path ? 'Not counted in blocks' : crossStreets(block),
    city.hoods.get(block.hood)?.name, `${Math.round(block.length)} m`,
  ].filter(Boolean).join(' · ');
  el.querySelector('.pop-status').textContent =
    (done ? 'Walked' : f > 0 ? `${Math.round(f * 100)}% walked` : 'Not walked yet') + (manual ? ' · set by you' : '');
  el.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === 'toggle') {
      overrides[id] = { walked: !done, hood: block.hood };
      await db.put('overrides', overrides[id], id);
    }
    if (act === 'reset') { delete overrides[id]; await db.delete('overrides', id); }
    view.setBlockState(id, blockState(id));
    renderStats();
    view.closePopup();
  });
  view.openPopup(latlng, el);
}

// ---------------------------------------------------------------- stats
const km = (m) => (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000).toLocaleString()) + ' km';
const fmtPct = (p) => (p > 0 && p < 0.1 ? '<0.1' : p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)) + '%';

let statsDirty = false;
function renderStats() {
  if (!city.index) return;
  if (asleep()) { statsDirty = true; return; }
  statsDirty = false;
  const s = (lastSummary = city.summary(overrides));
  renderHud();

  const all = rec ? [...tracks, { startedAt: rec.track.startedAt, distance: rec.dist, points: [] }] : tracks;
  const week = weekStats(all, city.completedAt);
  $('#chip-week').textContent = `This week · ${km(week.meters)} · ${week.blocks} new block${week.blocks === 1 ? '' : 's'}`;
  const days = streak(all);
  $('#chip-streak').hidden = days < 2;
  $('#chip-streak').textContent = `🔥 ${days}-day streak`;

  // Shade each neighborhood on the map by how much of it you've walked.
  s.hoods.forEach((h, i) => view.setHoodProgress(i, h.length ? h.walkedLength / h.length : 0));
  $('#hud').hidden = !!rec;
  if ($('#sheet').open) renderSheet();
  checkAchievements();
}
const updateStats = throttle(renderStats, 1000);

// ---------------------------------------------------------------- data loading
async function reloadData() {
  [tracks, overrides] = await Promise.all([db.all('tracks'), db.overrides()]);
}

// Load the neighborhoods your walks and hand-marked blocks are in.
async function rebuild() {
  const ids = new Set(city.setTracks(zoned(tracks)));
  for (const v of Object.values(overrides)) if (v?.hood) ids.add(v.hood);
  drawTracks();
  const missing = [...ids].filter((id) => !city.loaded.has(id));
  if (missing.length > 4) toast('Loading your progress…', 15000);
  await city.ensure([...ids]).catch((err) => console.warn('Some neighborhoods did not load', err));
  city.refreshMatches(); // every walk's neighborhoods are loaded: map-match them
  if (missing.length > 4) toast('');
  drawBlocks();
  updatePlaceVisits();
  renderStats();
}

// Which landmarks and stations your walks have passed (the walk in progress too).
function updatePlaceVisits() {
  if (!places) return;
  const all = rec ? [...tracks, { startedAt: rec.track.startedAt, points: rec.points }] : tracks;
  placeVisits = places.visits(zoned(all));
  for (const item of places.items) view.setPlaceVisited(item.index, placeVisits.has(item.key));
}

async function load() {
  await reloadData();
  // A walk still marked in-progress means the phone closed the app mid-walk.
  // Offer to continue the most recent one; save any older ones as finished.
  const unfinished = tracks.filter((t) => t.inProgress).sort((a, b) => b.startedAt - a.startedAt);
  for (const t of unfinished) {
    if (!t.points.length) {
      await db.delete('tracks', t.id);
      tracks = tracks.filter((x) => x !== t);
    } else if (!resumable && Date.now() - lastTimeOf(t) < RESUME_WITHIN_MS) {
      resumable = t;
    } else {
      await finishTrack(t);
    }
  }
  view.setView([40.7306, -73.9866], 14);
  try {
    await city.init();
    outlines = await fetch(city.url('neighborhoods.geojson')).then((r) => r.json());
  } catch (err) {
    console.error(err);
    toast('The NYC street data couldn’t load. Check your connection and reopen the app.', 10000);
    return;
  }
  view.setHoods(outlines);
  places = await fetch(city.url('places.json')).then((r) => r.json()).then((d) => new Places(d)).catch(() => null);
  if (places) view.setPlaces(places.items);
  syncZones();
  const autoWalks = await importNativeWalks();
  if (settings.healthAuto) await importHealth({ quiet: true });
  await rebuild();
  queueWalkSummaries(autoWalks);
  if (resumable) showResumeCard(resumable);
  else centerOnMe({ quiet: true });
  maybeShowInstallTip();
  refreshSteps();
  loadStreetTotals().then(() => checkAchievements()); // street totals are needed for street achievements
}

// ---------------------------------------------------------------- unfinished walks + install tip
let resumable = null;
const lastTimeOf = (t) => t.endedAt || t.points[t.points.length - 1]?.[2] || t.startedAt;
const walkName = (t) => `Walk on ${new Date(t.startedAt).toLocaleDateString([], { weekday: 'long' })}`;

async function finishTrack(t) {
  Object.assign(t, {
    inProgress: false,
    endedAt: lastTimeOf(t),
    distance: polylineLength(t.points),
    duration: t.duration ?? lastTimeOf(t) - t.startedAt - (t.pausedMs || 0),
    name: t.name || walkName(t),
  });
  await db.put('tracks', t);
}

function showResumeCard(t) {
  const mins = Math.round((Date.now() - lastTimeOf(t)) / 60000);
  $('#resume-info').textContent = `Started ${new Date(t.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ` +
    `${km(polylineLength(t.points))} so far · stopped ${mins < 1 ? 'just now' : `${mins} min ago`}`;
  $('#resume').hidden = false;
  const last = t.points[t.points.length - 1];
  if (last) view.setView([last[0], last[1]], 16);
}

async function finishResumable() {
  if (!resumable) return;
  const t = resumable;
  resumable = null;
  $('#resume').hidden = true;
  await finishTrack(t);
  if (!tracks.includes(t)) tracks = [...tracks.filter((x) => x.id !== t.id), t];
  await rebuild();
  queueWalkSummaries([t]);
}

const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// In a Safari tab, iPhone erases a site's data after 7 days without a visit.
// Home Screen apps are exempt, so nudge people there (every few days at most).
function maybeShowInstallTip() {
  if (native || !isIOS() || isStandalone()) return; // the iPhone app keeps its data
  let last = 0;
  try { last = Number(localStorage.getItem('walktracker.installTip')) || 0; } catch { /* ignore */ }
  if (Date.now() - last < INSTALL_TIP_EVERY_MS) return;
  $('#install').hidden = false;
}

function dismissInstallTip() {
  $('#install').hidden = true;
  try { localStorage.setItem('walktracker.installTip', String(Date.now())); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- neighborhoods
// Zoomed in far enough, load the blocks of the neighborhoods on screen.
const onMapMoved = throttle(() => {
  if (!city.index) return;
  renderHud();
  if (view.getZoom() < BLOCKS_MIN_ZOOM - 0.5) return;
  const ids = city.hoodsIn(view.getBBox()).filter((id) => !city.loaded.has(id));
  if (ids.length && ids.length <= MAX_VISIBLE_HOODS) city.ensure(ids).catch(() => {});
}, 400);

// The neighborhood in the middle of the map.
function hoodAtCenter() {
  if (!outlines) return null;
  const c = view.getCenter();
  for (const [i, h] of city.index.hoods.entries()) {
    const [s, w, n, e] = h.bbox;
    if (c[0] < s || c[0] > n || c[1] < w || c[1] > e) continue;
    if (pointInMultiPolygon(c, outlines.features[i].geometry.coordinates)) return h;
  }
  return null;
}

// What the progress card shows: the neighborhood (or its borough) in the middle
// of the map, or all of NYC. Zoomed far out, or outside NYC, it shows NYC.
function hudTarget() {
  const s = lastSummary;
  const h = settings.hudScope !== 'city' && view.getZoom() >= 11 ? hoodAtCenter() : null;
  if (h && settings.hudScope === 'hood') {
    return { kind: 'hood', id: h.id, name: h.name, ...s.hoods.find((x) => x.id === h.id) };
  }
  if (h) {
    const b = s.boroughs.find((x) => x.name === h.borough);
    return { kind: 'borough', ...b, name: b.name };
  }
  return { kind: 'city', name: 'New York City', blocks: s.blocks, length: s.length, walked: s.walked, walkedLength: s.walkedLength,
    pathLength: s.pathLength, pathWalkedLength: s.pathWalkedLength };
}

let hudShown = null;
function renderHud() {
  if (!lastSummary) return;
  const t = (hudShown = hudTarget());
  const pct = t.length ? (100 * t.walkedLength) / t.length : 0;
  $('#ring-fill').style.strokeDashoffset = RING * (1 - pct / 100);
  $('#stat-pct').textContent = fmtPct(pct);
  $('#hud-place-name').textContent = t.name;
  $('#stat-blocks').textContent = t.walked.toLocaleString();
  $('#stat-total').textContent = t.blocks.toLocaleString();
  $('#stat-dist').textContent = `${km(t.walkedLength)} of ${km(t.length)} walked`;
  // Park paths and plazas, kept apart from the street count.
  $('#chip-paths').hidden = !t.pathLength;
  $('#chip-paths').textContent = `Paths · ${km(t.pathWalkedLength || 0)} of ${km(t.pathLength || 0)}`;
  document.querySelectorAll('#hud-scope button').forEach((b) => b.setAttribute('aria-checked', b.dataset.scope === settings.hudScope));
}

function setHudScope(scope) {
  settings.hudScope = scope;
  saveSettings();
  renderHud();
}

// Tapping the place name zooms the map to it.
function showHudPlace() {
  const t = hudShown;
  if (!t) return;
  if (t.kind === 'hood') return openHood(t.id);
  const hoods = city.index.hoods.filter((h) => t.kind === 'city' || h.borough === t.name);
  view.fitPoints(hoods.flatMap(({ bbox: [s, w, n, e] }) => [[s, w], [n, e]]), { maxZoom: 14 });
}

let hoodLitTimer;
function openHood(id) {
  const h = city.hoods.get(id);
  if (!h) return;
  closeSheet();
  const [s, w, n, e] = h.bbox;
  view.fitPoints([[s, w], [n, e]], { maxZoom: 16 });
  view.highlightHood(h.idx);
  clearTimeout(hoodLitTimer);
  hoodLitTimer = setTimeout(() => view.highlightHood(null), 4000);
  city.ensure([id]).catch(() => toast('Couldn’t load that neighborhood. Check your connection.'));
}

// ---------------------------------------------------------------- recording
//
// Battery plan while walking:
//  - GPS runs at full accuracy only while you're moving.
//  - Stop for 90 s and GPS switches off; the (much cheaper) motion sensor
//    watches for steps and turns GPS back on. Without a motion sensor, a
//    low-power location watch does the same job.
//  - The screen goes black after 30 s without a tap. Black pixels cost almost
//    nothing on modern phones, and the map stops redrawing.

let motionAllowed = 'DeviceMotionEvent' in window && typeof DeviceMotionEvent.requestPermission !== 'function';

function askMotionPermission() {
  // iPhone asks once per session, and only from a tap.
  if (typeof window.DeviceMotionEvent?.requestPermission !== 'function') return;
  DeviceMotionEvent.requestPermission().then((r) => { motionAllowed = r === 'granted'; }).catch(() => {});
}

async function startWalk(resume = null) {
  if (!('geolocation' in navigator)) return toast('This browser has no GPS access.');
  // These must run straight from the tap: the keep-awake video and iPhone's motion prompt.
  if (!native) awake.start(); // the iPhone app records with the screen off
  if (settings.smartGps && !native) askMotionPermission();
  if (!resume && resumable) await finishResumable(); // starting fresh: save the old one
  const track = resume || { name: '', startedAt: Date.now(), points: [], inProgress: true, source: 'recorded' };
  rec = {
    track, points: track.points, dist: resume ? polylineLength(track.points) : 0, newBlocks: new Set(), lastSave: Date.now(),
    still: new StillnessDetector(), paused: false, pausedAt: 0, watchId: null,
    // Time the app was closed doesn't count toward your pace.
    pausedMs: resume ? (track.pausedMs || 0) + (Date.now() - lastTimeOf(track)) : 0,
  };
  if (resume) {
    // It was counted as a saved walk at startup; make it the live walk again.
    resumable = null;
    $('#resume').hidden = true;
    tracks = tracks.filter((t) => t !== resume);
    city.startLive(rec.points);
    city.setTracks(zoned(tracks));
    drawTracks();
    drawBlocks();
    view.setLive(rec.points);
  } else {
    track.id = await db.put('tracks', track);
    city.startLive(rec.points);
    view.setLive([]);
  }
  startGps('high');
  rec.timer = setInterval(tick, 1000);
  document.body.classList.add('recording');
  $('#rec').hidden = false;
  $('#btn-locate').hidden = true;
  $('#btn-pocket').hidden = false;
  $('#btn-record-label').textContent = 'Finish';
  setGps('wait', 'Finding GPS…');
  // Lock Screen / Dynamic Island card (iPhone app).
  native?.call('walkActivity', { action: 'start', startedAt: rec.track.startedAt, distance: rec.dist || 0 }).catch(() => {});
  renderStats();
  tick();
  armAutoDark();
  if (resume) toast('Continuing your walk', 3000);
  else if (lowBattery) toast('Battery is low: the saver screen will turn on after 10 s.', 4000);
}

function startGps(mode) {
  stopGps();
  rec.gpsMode = mode;
  rec.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, mode === 'high'
    ? { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    : { enableHighAccuracy: false, maximumAge: 30000, timeout: 120000 });
}

function stopGps() {
  if (rec?.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
  if (rec) rec.watchId = null;
}

function onPosition(pos) {
  if (!rec) return;
  const { latitude, longitude, accuracy } = pos.coords;
  let p = [latitude, longitude, pos.timestamp || Date.now()];
  // Steps (iPhone app): the phone's running count, which restarts with GPS.
  if (pos.steps != null) {
    if (rec.lastSteps != null && pos.steps >= rec.lastSteps) rec.track.steps = (rec.track.steps || 0) + pos.steps - rec.lastSteps;
    rec.lastSteps = pos.steps;
  }

  if (rec.paused) {
    // Low-power fallback while stopped: wake once we've clearly moved.
    if (rec.still.update(p, accuracy) === 'moving') resume();
    return;
  }
  if (!asleep()) showMe(p);
  // In the iPhone app a fix with no speed and over 20 m off is a Wi-Fi or cell
  // position (underground, e.g. a subway station), not real GPS.
  const wifiFix = native && pos.coords.speed == null && accuracy > 20;
  if (accuracy > MIN_ACCURACY_M || wifiFix) {
    setGps('weak', `Weak GPS ±${Math.round(accuracy)} m`);
    return;
  }
  if (inZone(p, settings.zones)) {
    rec.zoneGap = true; // the walk resumes after the area without joining across it
    setGps('weak', 'In a no-tracking area: not recorded');
    return;
  }
  // Moved a long way without taking steps (iPhone app only): a train or bus.
  const raw = [latitude, longitude, p[2], accuracy, pos.steps ?? undefined];
  rec.recent = (rec.recent || []).filter((q) => raw[2] - q[2] <= 45000);
  rec.recent.push(raw);
  if (isRiding(rec.recent[0], raw)) {
    rec.recent = [raw]; // walking right after the ride still counts
    setGps('weak', 'Riding, not walking: not counted');
    return;
  }
  setGps('good', `GPS ±${Math.round(accuracy)} m`);
  // (The iPhone app manages GPS power itself, and must keep recording in the background.)
  if (settings.smartGps && !native && rec.still.update(p, accuracy) === 'still') {
    pause();
    return;
  }
  // Smooth out GPS zigzags and drop one-off spikes (see js/track.js).
  const smooth = (rec.filter ||= new LiveFilter()).push(raw);
  if (!smooth) return;
  p = smooth.slice(0, 3);
  let last = rec.points[rec.points.length - 1];
  if (rec.zoneGap && last) {
    rec.zoneGap = false;
    (rec.track.breaks ||= []).push(rec.points.length);
    last = null;
  }
  if (last && haversine(last, p) < MIN_STEP_M) return;
  rec.points.push(p);
  if (!asleep()) view.setLive(rec.points);
  else rec.liveDirty = true;
  if (last) {
    rec.dist += haversine(last, p);
    discoverPlaces(last, p);
    const changed = city.addLiveSegment(last, p);
    if (changed.size) {
      for (const id of changed) {
        if (city.isPath(id)) continue; // paths don't count as new blocks
        if (!rec.newBlocks.has(id) && city.isWalked(id)) {
          rec.newBlocks.add(id);
          if (!city.completedAt.has(id)) city.completedAt.set(id, rec.track.startedAt);
          celebrate(id);
        }
      }
      queueRestyle(changed);
      updateStats();
      updateWalkActivity();
    }
  }
  if (!asleep() && Date.now() - lastDrag > 20000 && view.isNearEdge(p)) {
    view.panTo(p);
  }
  if (Date.now() - rec.lastSave > SAVE_EVERY_MS) saveRec();
}

function onGpsError(err) {
  if (!rec) return;
  if (err.code === 1) {
    toast('Location is blocked. Allow location for this site in your browser settings.', 6000);
    stopWalk();
    return;
  }
  setGps('off', 'GPS unavailable…');
}

// Stopped for a while: switch GPS off and wait for motion.
function pause() {
  stopGps();
  rec.paused = true;
  rec.pausedAt = Date.now();
  saveRec();
  $('#rec').classList.add('paused');
  $('#rec-label').textContent = 'Paused';
  setStatus('You stopped, so GPS is off to save battery. It turns back on when you start moving.');
  setGps('wait', 'GPS off');

  let gotMotion = false;
  const wake = new MotionWake();
  rec.onMotion = (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    gotMotion = true;
    if (wake.update(Math.hypot(a.x, a.y, a.z), e.timeStamp || performance.now())) resume();
  };
  if (motionAllowed) window.addEventListener('devicemotion', rec.onMotion);
  // No motion sensor (or no permission)? Fall back to low-power location.
  rec.motionCheck = setTimeout(() => { if (rec?.paused && !gotMotion) startGps('low'); }, 3000);
  // Safety net in case motion was missed (e.g. very smooth movement).
  rec.safety = setInterval(() => {
    if (!rec?.paused) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const q = [pos.coords.latitude, pos.coords.longitude, pos.timestamp];
        if (rec?.paused && rec.still.update(q, pos.coords.accuracy) === 'moving') resume();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }, SAFETY_CHECK_MS);
  renderPocket();
}

function clearPauseWatchers() {
  if (rec?.onMotion) window.removeEventListener('devicemotion', rec.onMotion);
  clearTimeout(rec?.motionCheck);
  clearInterval(rec?.safety);
}

function resume() {
  if (!rec?.paused) return;
  clearPauseWatchers();
  rec.paused = false;
  rec.pausedMs += Date.now() - rec.pausedAt;
  rec.still.reset();
  startGps('high');
  $('#rec').classList.remove('paused');
  $('#rec-label').textContent = 'Recording';
  setStatus('');
  setGps('wait', 'Finding GPS…');
  renderPocket();
}

function celebrate(id) {
  navigator.vibrate?.(35);
  if (asleep()) return;
  const block = city.block(id);
  if (!block) return;
  const where = crossStreets(block);
  toast(`✓ ${block.name || 'Block'} done${where ? ` · ${where}` : ''}`, 2500);
  view.highlight([id], true);
  setTimeout(() => view.highlight([id], false), 900);
}

function saveRec() {
  if (!rec) return;
  rec.lastSave = Date.now();
  rec.track.endedAt = Date.now();
  rec.track.distance = rec.dist;
  rec.track.pausedMs = rec.pausedMs;
  return db.put('tracks', rec.track);
}

// Keep the Lock Screen card's distance in step with the page (iPhone app).
const updateWalkActivity = throttle(() => {
  if (rec && native) native.call('walkActivity', { action: 'update', distance: rec.dist, newBlocks: rec.newBlocks.size }).catch(() => {});
}, 10000);

async function stopWalk() {
  if (!rec) return;
  const r = rec;
  stopGps();
  clearPauseWatchers();
  clearInterval(r.timer);
  clearTimeout(darkTimer);
  rec = null;
  city.stopLive();
  awake.stop();
  exitPocket();
  view.setLive([]);
  document.body.classList.remove('recording');
  $('#rec').hidden = true;
  $('#rec').classList.remove('paused');
  $('#rec-label').textContent = 'Recording';
  setStatus('');
  $('#btn-locate').hidden = false;
  $('#btn-pocket').hidden = true;
  $('#btn-record-label').textContent = 'Start walk';
  if (r.points.length < 2) {
    native?.call('walkActivity', { action: 'discard' }).catch(() => {});
    await db.delete('tracks', r.track.id);
    renderStats();
    toast('Walk discarded: no GPS points were recorded.', 3500);
    return;
  }
  Object.assign(r.track, {
    inProgress: false,
    endedAt: Date.now(),
    distance: r.dist,
    duration: Date.now() - r.track.startedAt - r.pausedMs,
    name: r.track.name || walkName(r.track),
  });
  await db.put('tracks', r.track);
  tracks.push(r.track);
  // Replays loaded neighborhoods with the saved walk, map-matched (js/match.js).
  await city.ensure(city.setTracks(zoned(tracks))).catch(() => {});
  city.refreshMatches();
  drawTracks();
  drawBlocks();
  updatePlaceVisits();
  renderStats();
  native?.call('walkActivity', { action: 'end', distance: r.dist, newBlocks: city.newByTrack.get(r.track.id) ?? r.newBlocks.size }).catch(() => {});
  queueWalkSummaries([r.track]);
}

// ---------------------------------------------------------------- walk summary
// A card after each walk: distance, time, new blocks, streets finished,
// neighborhood progress and landmarks or stations collected. Walks recorded
// automatically get one when the app next opens.
const summaryQueue = [];
let summaryShown = null;

function queueWalkSummaries(list) {
  summaryQueue.push(...list.filter((t) => t.points?.length > 1));
  if (!summaryShown) showNextSummary();
}

async function showNextSummary() {
  if (summaryShown) view.highlight(summaryShown.ids, false);
  const t = summaryQueue.shift();
  summaryShown = t ? await walkSummary(t) : null;
  $('#summary').hidden = !summaryShown;
  if (!summaryShown) return;
  const s = summaryShown;
  const when = new Date(t.startedAt);
  $('#sum-title').textContent = t.source === 'auto' ? 'Walk recorded' : 'Walk saved';
  $('#sum-when').textContent = `${when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ` +
    `${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${t.source === 'auto' ? ' · automatic' : ''}`;
  $('#sum-dist').textContent = km(t.distance || 0);
  $('#sum-time').textContent = minutes(t.duration ?? (t.endedAt - t.startedAt));
  $('#sum-blocks').textContent = s.ids.length.toLocaleString();
  const lines = $('#sum-lines');
  lines.replaceChildren();
  const line = (icon, text) => {
    const li = document.createElement('li');
    if (icon instanceof HTMLElement) li.append(icon); else li.append(Object.assign(document.createElement('span'), { className: 'sum-ic', textContent: icon }));
    li.append(Object.assign(document.createElement('span'), { textContent: text }));
    lines.append(li);
  };
  if (t.steps) line('👟', `${t.steps.toLocaleString()} steps`);
  for (const st of s.finished.slice(0, 3)) line('🏁', `Finished ${st}`);
  for (const h of s.hoods.slice(0, 3)) line('▲', `${h.name}: +${fmtPct(h.gain)} (now ${fmtPct(h.now)})`);
  for (const p of s.places.slice(0, 4)) {
    const img = Object.assign(document.createElement('img'), { className: 'badge-ic', alt: '' });
    img.src = drawBadge(p.kind, true, { dark: mapLook().dark, ratio: 3 }).toDataURL();
    line(img, p.name);
  }
  if (!s.ids.length && !s.places.length) line('·', 'No new blocks this time: every street was already walked.');
  $('#sum-next').textContent = summaryQueue.length ? `Next (${summaryQueue.length} more)` : 'Done';
}

const minutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

async function walkSummary(t) {
  const ids = [...city.completedAt].filter(([, time]) => time === t.startedAt).map(([id]) => id);
  // Neighborhoods: how much this walk added, and where they stand now.
  const byHood = new Map();
  for (const id of ids) {
    const b = city.block(id);
    if (b) byHood.set(b.hood, (byHood.get(b.hood) || 0) + b.length);
  }
  const hoods = [...byHood].map(([id, len]) => {
    const h = lastSummary?.hoods.find((x) => x.id === id);
    return h && h.length ? { name: h.name, gain: (100 * len) / h.length, now: (100 * h.walkedLength) / h.length } : null;
  }).filter(Boolean).sort((a, b) => b.gain - a.gain);
  // Streets this walk finished: every block of the street (NYC-wide) walked.
  const finished = [];
  const totals = await loadStreetTotals();
  if (totals) {
    const total = new Map(totals.map(([name, borough, blocks]) => [`${name}|${borough}`, blocks]));
    const walked = city.streetProgress(overrides);
    const touched = new Set(ids.map((id) => city.block(id)).filter((b) => b?.name).map((b) => `${b.name}|${b.borough}`));
    for (const key of touched) if (walked.get(key)?.walked >= total.get(key)) finished.push(key.split('|')[0]);
  }
  // Landmarks and stations first reached on this walk.
  const end = t.endedAt || t.points[t.points.length - 1][2] || t.startedAt;
  const places_ = places ? places.items.filter((item) => {
    const time = placeVisits.get(item.key);
    return time != null && time >= t.startedAt && time <= end;
  }) : [];
  return { track: t, ids, hoods, finished, places: places_ };
}

function showSummaryOnMap() {
  const s = summaryShown;
  if (!s) return;
  $('#summary').hidden = true;
  view.fitPoints(s.track.points.map((p) => [p[0], p[1]]), { maxZoom: 16 });
  view.highlight(s.ids, true);
  setTimeout(() => { if (summaryShown === s) $('#summary').hidden = false; }, 4000);
}

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0');
};

function elapsed() {
  return Date.now() - rec.track.startedAt;
}

function tick() {
  if (!rec || document.hidden) return;
  if (pocketOn) return renderPocket();
  $('#rec-time').textContent = clock(elapsed());
  $('#rec-dist').textContent = (rec.dist / 1000).toFixed(2);
  $('#rec-new').textContent = rec.newBlocks.size;
  const moving = elapsed() - rec.pausedMs - (rec.paused ? Date.now() - rec.pausedAt : 0);
  $('#rec-pace').textContent = rec.dist > 100 ? clock(moving / (rec.dist / 1000)) : '–';
}

function setGps(q, text) {
  $('#rec-gps').dataset.q = q;
  $('#rec-gps-text').textContent = text;
}

function setStatus(text) {
  $('#rec-status').hidden = !text;
  $('#rec-status').textContent = text;
}

// ---------------------------------------------------------------- screen + battery saver
// Browsers stop GPS when the screen locks, so keep it on during a walk.
const awake = new KeepAwake();

// Coming back to the app after a while: re-center on where you are now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !rec && view && Date.now() - lastCentered > 5 * 60000) centerOnMe({ quiet: true });
});

// Mid-walk, the app was hidden (screen locked, another app): phones pause web
// apps then, so GPS stops. Coming back, restart GPS and say what was missed.
document.addEventListener('visibilitychange', () => {
  if (!rec) return;
  if (document.visibilityState === 'hidden') {
    rec.hiddenAt = Date.now();
    saveRec();
    return;
  }
  const away = rec.hiddenAt ? Date.now() - rec.hiddenAt : 0;
  rec.hiddenAt = 0;
  // The iPhone app kept recording in the background and hands the points over itself.
  if (native) { wakeUpUi(); return; }
  if (!rec.paused) startGps('high'); // the old GPS watch often doesn't survive
  wakeUpUi();
  if (away > 30000) {
    const mins = Math.round(away / 60000);
    toast(`Tracking stopped for ${mins < 1 ? 'under a minute' : `${mins} min`} while WalkTracker was closed or the screen was locked. ` +
      'Keep it open while you walk; the black battery saver screen is fine.', 8000);
  }
});

let darkTimer = null;
function armAutoDark() {
  clearTimeout(darkTimer);
  if (!rec || !settings.autoDark || pocketOn || native) return; // in the iPhone app, just lock the phone
  darkTimer = setTimeout(enterPocket, lowBattery ? AUTO_DARK_LOW_BATTERY_MS : AUTO_DARK_MS);
}
document.addEventListener('pointerdown', () => {
  if (!rec) return;
  if (!pocketOn) armAutoDark();
  if (!native && awake.method === 'none') awake.start(); // a tap lets the keep-awake video start if it was blocked
}, { capture: true });

function enterPocket() {
  if (!rec || pocketOn) return;
  pocketOn = true;
  view.closePopup();
  closeSheet();
  $('#pocket').hidden = false;
  renderPocket();
}

function exitPocket() {
  if (!pocketOn) return;
  pocketOn = false;
  $('#pocket').hidden = true;
  wakeUpUi();
  armAutoDark();
}

// Catch the map and numbers up after the screen was dark or the app hidden.
function wakeUpUi() {
  if (asleep()) return;
  if (blocksDirty) { blocksDirty = false; drawBlocks(); }
  scheduleFlush();
  if (statsDirty) renderStats();
  if (rec) {
    if (rec.liveDirty) { view.setLive(rec.points); rec.liveDirty = false; }
    const last = rec.points[rec.points.length - 1];
    if (last) { showMe(last); view.panTo(last); }
    tick();
  }
}

let pocketShift = 0;
function renderPocket() {
  if (!pocketOn || !rec) return;
  $('#pk-time').textContent = clock(elapsed());
  $('#pk-stats').textContent = `${(rec.dist / 1000).toFixed(2)} km · ${rec.newBlocks.size} new block${rec.newBlocks.size === 1 ? '' : 's'}`;
  $('#pk-status').textContent = rec.paused ? 'Paused · GPS off until you move' : 'Recording';
  // Nudge the text around now and then so nothing burns into the screen.
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== pocketShift) {
    pocketShift = minute;
    $('#pocket-inner').style.transform = `translate(${(Math.random() - 0.5) * 60}px, ${(Math.random() - 0.5) * 160}px)`;
  }
}

let lastTap = 0;
$('#pocket').addEventListener('pointerup', () => {
  const now = Date.now();
  if (now - lastTap < 450) exitPocket();
  lastTap = now;
});

navigator.getBattery?.().then((b) => {
  const check = () => {
    const wasLow = lowBattery;
    lowBattery = !b.charging && b.level <= 0.2;
    if (lowBattery !== wasLow) armAutoDark();
  };
  check();
  b.addEventListener('levelchange', check);
  b.addEventListener('chargingchange', check);
}).catch(() => {});

// ---------------------------------------------------------------- location
function showMe(p) {
  view.showMe(p);
}

// Quietly move the map to where you are (used when the app opens). Asks for
// location permission the first time.
let lastCentered = 0;
function centerOnMe({ quiet = false } = {}) {
  if (!('geolocation' in navigator) || rec) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (rec) return;
      lastCentered = Date.now();
      const p = [pos.coords.latitude, pos.coords.longitude];
      showMe(p);
      view.flyTo(p, Math.max(view.getZoom(), 16));
    },
    () => { if (!quiet) toast('Could not get your location.'); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

function locateOnce() {
  if (!('geolocation' in navigator)) return toast('This browser has no GPS access.');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      showMe(p);
      view.setView(p, Math.max(view.getZoom(), 16));
      toast('');
    },
    () => toast('Could not get your location.'),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ---------------------------------------------------------------- import / export
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

async function exportBackup() {
  download(`walktracker-backup-${stamp()}.json`, JSON.stringify(await db.exportAll()), 'application/json');
}

function exportGpx() {
  if (!tracks.length) return toast('No walks to export yet.');
  download(`walktracker-walks-${stamp()}.gpx`, toGpx(tracks), 'application/gpx+xml');
}

async function importFiles(files) {
  let walks = 0, backups = 0;
  try {
    for (const file of files) {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{')) {
        await db.importAll(JSON.parse(text));
        backups++;
      } else {
        for (const t of parseGpx(text)) {
          if (t.points.length < 2) continue;
          await db.put('tracks', {
            name: t.name || file.name.replace(/\.gpx$/i, ''),
            startedAt: t.points[0][2] || Date.now(),
            endedAt: t.points[t.points.length - 1][2] || Date.now(),
            distance: polylineLength(t.points),
            points: t.points,
            source: 'gpx',
          });
          walks++;
        }
      }
    }
  } catch (err) {
    console.error(err);
    toast(`Import failed: ${err.message}`, 5000);
  }
  await reloadData();
  rebuild();
  toast([walks && `${walks} walk${walks === 1 ? '' : 's'} imported`, backups && 'Backup restored'].filter(Boolean).join(' · ') || 'Nothing to import', 4000);
}

async function wipe() {
  if (!confirm('Delete all your walks and progress on this device? Export a backup first if you want to keep them.')) return;
  if (rec) await stopWalk();
  await Promise.all(['tracks', 'areas', 'overrides'].map((s) => db.clear(s)));
  tracks = []; overrides = {};
  rebuild();
  closeSheet();
  toast('All data deleted.');
}

async function persistStorage() {
  if (!navigator.storage?.persist) return toast('This browser does not support protected storage.');
  const ok = await navigator.storage.persist();
  toast(ok ? 'Storage protected: the browser won’t clear it on its own.' : 'The browser said no. Adding the app to your home screen usually helps.', 5000);
  renderStorageInfo();
}

async function renderStorageInfo() {
  if (!navigator.storage?.estimate) return;
  const { usage = 0 } = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted?.();
  $('#storage-info').textContent = `Using ${(usage / 1e6).toFixed(1)} MB on this device${persisted ? ' · protected' : ''}.`;
}

// ---------------------------------------------------------------- sheet
let activeTab = 'hoods';
let streetFilter = 'progress';

function openSheet() {
  $('#sheet').showModal();
  renderSheet();
}

function closeSheet() {
  const s = $('#sheet');
  if (s.open) s.close();
  s.style.transform = '';
}

function renderSheet() {
  if (activeTab === 'streets') renderStreets();
  if (activeTab === 'walks') renderWalks();
  if (activeTab === 'hoods') renderHoods();
  if (activeTab === 'settings') renderSettings();
  if (activeTab === 'progress') renderProgress();
}

function row({ title, sub, frac, pct, badge, actions = [], onOpen }) {
  const el = document.createElement('li');
  el.innerHTML = `<div class="main"><div class="title"></div><div class="sub"></div>${
    frac == null ? '' : `<div class="bar"><div style="width:${(frac * 100).toFixed(1)}%"></div></div>`}</div>`;
  el.querySelector('.title').textContent = title;
  el.querySelector('.sub').textContent = sub;
  if (onOpen) el.querySelector('.main').addEventListener('click', onOpen);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = badge;
    el.appendChild(b);
  }
  if (pct != null) {
    const p = document.createElement('span');
    p.className = 'pct' + (pct >= 100 ? ' done' : '');
    p.textContent = pct > 0 && pct < 1 ? '<1%' : `${Math.floor(pct)}%`;
    el.appendChild(p);
  }
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.addEventListener('click', fn);
    el.appendChild(b);
  }
  return el;
}

function emptyRow(text) {
  const el = document.createElement('li');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

const STREET_FILTERS = {
  progress: { test: (f) => f > 0 && f < 1, sort: (a, b) => b.frac - a.frac || b.length - a.length, empty: 'Nothing in progress yet. Start a walk!' },
  todo: { test: (f) => f === 0, sort: (a, b) => b.length - a.length, empty: 'You’ve started every street. Wow.' },
  done: { test: (f) => f >= 1, sort: (a, b) => a.name.localeCompare(b.name), empty: 'No streets finished yet.' },
  all: { test: () => true, sort: (a, b) => b.frac - a.frac || b.length - a.length, empty: 'No streets match.' },
};

// ---------------------------------------------------------------- progress: stats + achievements
let progressView = 'stats';

// ---------------------------------------------------------------- landmarks & stations
function discoverPlaces(a, b) {
  if (!places) return;
  for (const item of places.passed(a, b)) {
    if (placeVisits.has(item.key)) continue;
    placeVisits.set(item.key, b[2] || Date.now());
    view.setPlaceVisited(item.index, true);
    navigator.vibrate?.([20, 40, 20]);
    if (!asleep()) toast(item.kind === 'landmark' ? `🏛️ Discovered: ${item.name}` : `🚇 New station: ${item.name} · ${item.routes.join(' ')}`, 3500);
    updateStats();
  }
}

function bullet(route, small = false) {
  const b = document.createElement('span');
  b.className = `bullet${small ? ' small' : ''}${route.length > 1 ? ' wide' : ''}${['N', 'Q', 'R', 'W'].includes(route) ? ' dark-text' : ''}`;
  b.style.background = ROUTE_COLORS[route] || '#808183';
  b.textContent = route;
  return b;
}

const visitDate = (time) => new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function openPlacePopup(index) {
  const item = places?.items[index];
  if (!item) return;
  const el = document.createElement('div');
  el.innerHTML = '<div class="pop-title"></div><div class="pop-routes"></div><div class="pop-sub"></div><span class="pop-status"></span>';
  el.querySelector('.pop-title').textContent = item.name;
  const hood = item.hood >= 0 ? city.index.hoods[item.hood]?.name : '';
  if (item.kind === 'station') {
    item.routes.forEach((r) => el.querySelector('.pop-routes').append(bullet(r, true)));
    el.querySelector('.pop-sub').textContent = ['Subway station', hood].filter(Boolean).join(' · ');
  } else {
    el.querySelector('.pop-routes').remove();
    const year = (item.designated.match(/\d{4}/) || [])[0];
    el.querySelector('.pop-sub').textContent = [item.address, hood, year && `Landmark since ${year}`].filter(Boolean).join(' · ');
  }
  const when = placeVisits.get(item.key);
  const status = el.querySelector('.pop-status');
  status.textContent = when ? `Visited ${visitDate(when)}` : 'Not visited yet';
  if (when) status.classList.add('walked');
  view.openPopup([item.lat, item.lon], el);
}

function showPlace(item) {
  closeSheet();
  view.flyTo([item.lat, item.lon], Math.max(view.getZoom(), 16));
  setTimeout(() => openPlacePopup(item.index), 850);
}

let placeFilter = 'near';
function renderPlacesView() {
  if (!places) {
    $('#place-tiles').replaceChildren(tile('Landmarks & stations', '–', 'Couldn’t load'));
    return;
  }
  const visitedL = places.landmarks.filter((i) => placeVisits.has(i.key)).length;
  const visitedS = places.stations.filter((i) => placeVisits.has(i.key)).length;
  $('#place-tiles').replaceChildren(
    tile('Landmarks', `${visitedL.toLocaleString()}`, `of ${places.landmarks.length.toLocaleString()} in NYC`),
    tile('Subway stations', `${visitedS}`, `of ${places.stations.length}`),
  );
  const lines = $('#line-list');
  lines.replaceChildren();
  for (const l of places.lineProgress(placeVisits)) {
    const li = row({ title: `${l.route === 'SIR' ? 'Staten Island Railway' : l.route === 'S' ? 'Shuttles' : `${l.route} train`}`,
      sub: `${l.visited} of ${l.total} stations`, frac: l.visited / l.total, pct: (100 * l.visited) / l.total });
    li.prepend(bullet(l.route));
    lines.append(li);
  }

  const q = $('#place-search').value.trim().toLowerCase();
  const c = view.getCenter();
  const dist = (i) => (i.lat - c[0]) ** 2 + ((i.lon - c[1]) * 0.76) ** 2;
  let items = places.items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.address || '').toLowerCase().includes(q));
  if (!q && placeFilter === 'visited') items = items.filter((i) => placeVisits.has(i.key)).sort((a, b) => placeVisits.get(b.key) - placeVisits.get(a.key));
  else if (!q && placeFilter === 'todo') items = items.filter((i) => !placeVisits.has(i.key)).sort((a, b) => dist(a) - dist(b));
  else items = items.sort((a, b) => dist(a) - dist(b));
  const list = $('#place-list');
  list.replaceChildren();
  if (!items.length) list.append(emptyRow(placeFilter === 'visited' && !q ? 'Nothing visited yet. Walk past a landmark or a subway station.' : 'Nothing matches.'));
  for (const item of items.slice(0, 40)) {
    const when = placeVisits.get(item.key);
    const hood = item.hood >= 0 ? city.index.hoods[item.hood]?.name : '';
    const li = row({
      title: item.name,
      sub: [item.kind === 'station' ? item.routes.join(' ') : item.address, hood, when && `visited ${visitDate(when)}`].filter(Boolean).join(' · '),
      onOpen: () => showPlace(item),
    });
    const icon = document.createElement('span');
    icon.className = `place-icon${when ? ' done' : ''}`;
    icon.textContent = item.kind === 'station' ? '🚇' : '🏛️';
    li.prepend(icon);
    list.append(li);
  }
}

function placeFacts() {
  if (!places) return {};
  return {
    landmarks: places.landmarks.filter((i) => placeVisits.has(i.key)).length,
    stations: places.stations.filter((i) => placeVisits.has(i.key)).length,
    linesDone: places.lineProgress(placeVisits).filter((l) => l.visited === l.total).length,
  };
}

function progressFacts(streets) {
  return factsFrom({
    summary: lastSummary,
    tracksTotals: totals(tracks),
    streets,
    walkedByStreet: city.streetProgress(overrides),
    bestStreak: bestStreak(tracks),
    places: placeFacts(),
  });
}

async function renderProgress() {
  document.querySelectorAll('#progress-switch button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === progressView));
  $('#stats-view').hidden = progressView !== 'stats';
  $('#awards-view').hidden = progressView !== 'awards';
  $('#places-view').hidden = progressView !== 'places';
  if (!lastSummary) return;
  if (progressView === 'stats') renderStatsView();
  else if (progressView === 'places') renderPlacesView();
  else renderAwards(await loadStreetTotals());
}

function tile(label, value, sub = '') {
  const d = document.createElement('div');
  d.className = 'tile';
  d.innerHTML = '<div class="label"></div><div class="value"></div><div class="sub"></div>';
  d.querySelector('.label').textContent = label;
  d.querySelector('.value').textContent = value;
  d.querySelector('.sub').textContent = sub;
  return d;
}

function renderStatsView() {
  const t = totals(tracks);
  const s = lastSummary;
  const visited = s.hoods.filter((h) => h.walked > 0).length;
  const finished = s.hoods.filter((h) => h.length && h.walkedLength >= 0.9 * h.length).length;
  const cityPct = s.length ? (100 * s.walkedLength) / s.length : 0;
  $('#stat-tiles').replaceChildren(
    tile('Distance walked', km(t.meters), `${t.walks.toLocaleString()} walk${t.walks === 1 ? '' : 's'}`),
    tile('Blocks walked', s.walked.toLocaleString(), `${fmtPct(cityPct)} of NYC`),
    tile('Neighborhoods', `${visited} visited`, `${finished} finished`),
    tile('Longest walk', km(t.longest), ''),
    tile('Paths & plazas', km(s.pathWalkedLength || 0), `of ${km(s.pathLength || 0)} in NYC parks and plazas`),
    tile('Best streak', `${bestStreak(tracks)} day${bestStreak(tracks) === 1 ? '' : 's'}`, `Current: ${streak(tracks)}`),
    tile('This week', km(weekStats(tracks, city.completedAt).meters), `${weekStats(tracks, city.completedAt).blocks} new blocks`),
  );
  weeklyChart($('#chart-weekly'), weeklyTotals(tracks, city.completedAt, 12));
  calendarChart($('#chart-days'), dailyTotals(tracks, 16));
  renderSteps();
}

// ---------------------------------------------------------------- steps
// Daily steps from the phone's pedometer (iPhone app). It only keeps 7 days,
// so each day it reports is saved here and the history grows from there.
const STEPS_KEY = 'walktracker.steps';
let stepHistory = {};
try { stepHistory = JSON.parse(localStorage.getItem(STEPS_KEY) || '{}'); } catch { /* private mode */ }

async function refreshSteps() {
  if (!native) return;
  let days;
  try { days = await native.call('dailySteps'); } catch { return; }
  if (!days?.length) return;
  for (const { day, steps } of days) stepHistory[day] = Math.max(steps, stepHistory[day] || 0);
  try { localStorage.setItem(STEPS_KEY, JSON.stringify(stepHistory)); } catch { /* ignore */ }
  if ($('#sheet').open && !$('#stats-view').hidden) renderSteps();
}

const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function renderSteps() {
  const has = Object.keys(stepHistory).length > 0;
  $('#steps-section').hidden = !has;
  if (!has) return;
  const days = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push({ date: d.getTime(), steps: stepHistory[dayKeyOf(d)] || 0 });
  }
  const week = days.slice(-7).reduce((n, d) => n + d.steps, 0);
  const counted = days.filter((d) => d.steps > 0);
  const avg = counted.length ? Math.round(counted.reduce((n, d) => n + d.steps, 0) / counted.length) : 0;
  const best = Object.entries(stepHistory).sort((a, b) => b[1] - a[1])[0];
  $('#step-tiles').replaceChildren(
    tile('Steps today', days[days.length - 1].steps.toLocaleString(), `${week.toLocaleString()} this week`),
    tile('Daily average', avg.toLocaleString(), best ? `Best: ${best[1].toLocaleString()} on ${new Date(best[0] + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''),
  );
  stepsChart($('#chart-steps'), days);
}

function renderAwards(streets) {
  const list = evaluate(progressFacts(streets));
  const earned = list.filter((a) => a.earned).length;
  $('#awards-head').textContent = `${earned} of ${list.length} earned`;
  const box = $('#awards-list');
  box.replaceChildren();
  const groups = [...new Set(list.map((a) => a.group))];
  for (const g of groups) {
    const section = document.createElement('div');
    section.className = 'award-group';
    section.innerHTML = '<h4></h4>';
    section.querySelector('h4').textContent = g;
    for (const a of list.filter((x) => x.group === g)) {
      const d = document.createElement('div');
      d.className = `award ${a.earned ? 'earned' : 'locked'}`;
      d.innerHTML = `<div class="icon" aria-hidden="true"></div><div class="text"><div class="title"></div><div class="desc"></div>${
        a.earned ? '' : `<div class="bar"><div style="width:${(a.progress * 100).toFixed(1)}%"></div></div>`}</div><div class="state"></div>`;
      d.querySelector('.icon').textContent = a.icon;
      d.querySelector('.title').textContent = a.title;
      d.querySelector('.desc').textContent = a.desc;
      d.querySelector('.state').textContent = a.earned ? 'Earned' : `${Math.min(a.value, a.target).toLocaleString()} / ${a.target.toLocaleString()}`;
      section.append(d);
    }
    box.append(section);
  }
}

// A note (and a buzz) the first time each achievement is earned. The first check
// on a device just records what's already earned, so nothing old is announced.
const SEEN_KEY = 'walktracker.achievementsSeen';
let checkingAwards = false;
async function checkAchievements() {
  if (!lastSummary || checkingAwards || !streetTotals) return;
  checkingAwards = true;
  try {
    const earned = evaluate(progressFacts(await loadStreetTotals())).filter((a) => a.earned);
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch { /* ignore */ }
    const fresh = seen ? earned.filter((a) => !seen.includes(a.id)) : [];
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(earned.map((a) => a.id))); } catch { /* ignore */ }
    if (fresh.length) {
      navigator.vibrate?.([30, 60, 30]);
      const a = fresh[fresh.length - 1];
      toast(`🏆 New achievement: ${a.title}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`, 4000);
    }
  } finally {
    checkingAwards = false;
  }
}

async function loadStreetTotals() {
  streetTotals ||= fetch(city.url('streets.json')).then((r) => r.json()).catch(() => null);
  return streetTotals;
}

async function renderStreets() {
  const list = $('#street-list');
  const totals = await loadStreetTotals();
  list.replaceChildren();
  if (!totals) return list.append(emptyRow('The street list couldn’t load. Check your connection.'));
  const walked = city.streetProgress(overrides);
  const q = $('#street-search').value.trim().toLowerCase();
  const f = STREET_FILTERS[streetFilter];
  const streets = [];
  for (const [name, borough, blocks, length, hoods] of totals) {
    const w = walked.get(`${name}|${borough}`);
    const frac = w ? Math.min(1, w.walkedLength / length) : 0;
    if (q ? !name.toLowerCase().includes(q) : !f.test(frac)) continue;
    streets.push({ name, borough, blocks, length, hoods, walked: w?.walked || 0, frac });
  }
  streets.sort(f.sort);
  if (!streets.length) list.append(emptyRow(q ? 'No streets match.' : f.empty));
  for (const st of streets.slice(0, 200)) {
    list.append(row({
      title: st.name,
      sub: `${st.borough} · ${st.walked} of ${st.blocks} block${st.blocks === 1 ? '' : 's'} · ${km(st.length)}`,
      frac: st.frac,
      pct: st.frac * 100,
      onOpen: () => showStreet(st),
    }));
  }
  if (streets.length > 200) list.append(emptyRow(`Showing 200 of ${streets.length.toLocaleString()}. Search to find others.`));
}

let highlightTimer;
async function showStreet(st) {
  closeSheet();
  const hoodIds = st.hoods.map((i) => city.index.hoods[i].id);
  await city.ensure(hoodIds).catch(() => {});
  const ids = [];
  const points = [];
  for (const id of hoodIds) {
    for (const b of city.loaded.get(id)?.blocks || []) {
      if (b.name !== st.name) continue;
      ids.push(b.id);
      points.push(...b.coords);
    }
  }
  if (!ids.length) return;
  drawBlocks();
  view.highlight(ids, true);
  view.fitPoints(points);
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => view.highlight(ids, false), 3500);
}

function renderWalks() {
  const list = $('#walk-list');
  list.replaceChildren();
  if (!tracks.length) return list.append(emptyRow('No walks yet. Tap Start walk, or import GPX files in Settings.'));
  for (const t of [...tracks].sort((a, b) => b.startedAt - a.startedAt)) {
    const dist = t.distance ?? polylineLength(t.points);
    const when = new Date(t.startedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const mins = t.duration ? Math.round(t.duration / 60000) : t.endedAt ? Math.round((t.endedAt - t.startedAt) / 60000) : 0;
    const n = city.newByTrack.get(t.id) || 0;
    list.append(row({
      title: when,
      sub: [km(dist), mins ? `${mins} min` : '', SOURCE_LABEL[t.source] || ''].filter(Boolean).join(' · '),
      badge: n ? `+${n} block${n === 1 ? '' : 's'}` : '',
      actions: [['Delete', async () => {
        if (!confirm('Delete this walk?')) return;
        await db.delete('tracks', t.id);
        tracks = tracks.filter((x) => x !== t);
        await rebuild();
      }]],
      onOpen: () => openWalkDetail(t),
    }));
  }
}

// ---------------------------------------------------------------- heatmap
// Every walk's points about every 10 m (no-tracking areas left out), so busy
// streets glow and one-off walks stay faint. Built only while it's shown.
function drawHeat() {
  if (!view || !settings.showHeatmap) return;
  const pts = [];
  for (const t of zoned(tracks)) {
    let last = null;
    for (const p of t.points) {
      if (last && haversine(last, p) < 10) continue;
      pts.push(p);
      last = p;
    }
  }
  view.setHeat(pts);
}

// ---------------------------------------------------------------- one walk
let walkOpen = null; // { track, i0, i1 } while the details card is up

function openWalkDetail(t) {
  closeSheet();
  $('#summary').hidden = true;
  const base = t.original || t.points;
  const [i0, i1] = t.trim || [0, base.length - 1];
  walkOpen = { track: t, i0, i1 };
  const d = walkDetails(t.points);
  const n = city.newByTrack.get(t.id) || 0;
  $('#wd-title').textContent = new Date(t.startedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('#wd-dist').textContent = km(d.distance);
  $('#wd-moving').textContent = minutes(d.movingMs);
  $('#wd-pace').textContent = formatPace(d.pace);
  $('#wd-sub').textContent = [`${minutes(d.totalMs)} in all`, `${n} new block${n === 1 ? '' : 's'}`,
    t.steps ? `${t.steps.toLocaleString()} steps` : '', SOURCE_LABEL[t.source] || '', t.original ? 'trimmed' : '']
    .filter(Boolean).join(' · ');
  // Splits: a bar per kilometer, longer = slower.
  const splits = $('#wd-splits');
  splits.replaceChildren();
  const paces = d.splits.map((s) => s.ms / (s.full ? 1 : s.meters / 1000));
  const slowest = Math.max(...paces, 1);
  d.splits.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'wd-split';
    el.innerHTML = '<span></span><div class="bar"><div></div></div><span></span>';
    el.children[0].textContent = s.full ? `km ${s.km}` : `${(s.meters / 1000).toFixed(2)} km`;
    el.querySelector('.bar div').style.width = `${Math.round((100 * paces[i]) / slowest)}%`;
    el.children[2].textContent = formatPace(paces[i]);
    splits.append(el);
  });
  // Trim sliders over the original points.
  const max = base.length - 1;
  $('#wd-start').max = $('#wd-end').max = max;
  $('#wd-start').value = i0;
  $('#wd-end').value = i1;
  $('#wd-trim-undo').hidden = !t.original;
  $('#walk-detail').hidden = false;
  previewTrim();
  view.fitPoints(base, { bottom: Math.min(innerHeight * 0.55, $('#walk-detail').getBoundingClientRect().height + 40) });
}

function previewTrim() {
  if (!walkOpen) return;
  const base = walkOpen.track.original || walkOpen.track.points;
  let i0 = Number($('#wd-start').value), i1 = Number($('#wd-end').value);
  if (i1 - i0 < 1) { // keep at least two points
    if (document.activeElement === $('#wd-start')) i0 = Math.max(0, i1 - 1); else i1 = Math.min(base.length - 1, i0 + 1);
    $('#wd-start').value = i0;
    $('#wd-end').value = i1;
  }
  Object.assign(walkOpen, { i0, i1 });
  view.setTrim(base, i0, i1);
  const kept = polylineLength(base.slice(i0, i1 + 1));
  const at = (p) => (p[2] ? new Date(p[2]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  $('#wd-trim-info').textContent = `Keeps ${km(kept)} of ${km(polylineLength(base))} · ${at(base[i0])} to ${at(base[i1])}`;
  const [t0, t1] = walkOpen.track.trim || [0, base.length - 1];
  $('#wd-trim-save').disabled = i0 === t0 && i1 === t1;
}

// ---------------------------------------------------------------- replay
// The walk draws itself on the map (8-20 s), and the blocks it finished go
// from grey to green as the line reaches them.
let replay = null;

function startReplay() {
  if (!walkOpen) return;
  stopReplay(false);
  const t = walkOpen.track;
  const runs = runsOf(zoned([t])[0]);
  const pts = runs.flat();
  if (pts.length < 2) return toast('Nothing to replay.');
  const ids = [...city.completedAt].filter(([, time]) => time === t.startedAt).map(([id]) => id).filter((id) => city.block(id));
  // When each new block lights up: the walk point closest to its middle.
  const lights = ids.map((id) => {
    const mid = midpoint(city.block(id).coords);
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => { const d = haversine(p, mid); if (d < bestD) { bestD = d; best = i; } });
    return { at: best, id };
  }).sort((a, b) => a.at - b.at);
  for (const { id } of lights) view.setBlockState(id, 'none');
  const ms = Math.min(20000, Math.max(8000, pts.length * 15));
  replay = { t, pts, lights, next: 0, start: performance.now(), ms, raf: 0, dist: 0, lit: 0 };
  $('#walk-detail').hidden = true;
  $('#replay-bar').hidden = false;
  $('#rp-title').textContent = `Replaying ${new Date(t.startedAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
  view.setTrim([], 0, 0);
  view.fitPoints(pts, { bottom: 140 });
  const frame = (now) => {
    if (!replay) return;
    const f = Math.min(1, (now - replay.start) / replay.ms);
    const k = Math.max(1, Math.floor(f * (pts.length - 1)));
    view.setReplay(pts, k);
    while (replay.next < lights.length && lights[replay.next].at <= k) {
      const { id } = lights[replay.next++];
      view.setBlockState(id, blockState(id));
      view.highlight([id], true);
      setTimeout(() => view.highlight([id], false), 600);
    }
    const elapsed = (pts[k][2] || 0) - (pts[0][2] || 0);
    $('#rp-fill').style.width = `${Math.round(f * 100)}%`;
    $('#rp-info').textContent = `${km(polylineLength(pts.slice(0, k + 1)))}${elapsed > 0 ? ` · ${minutes(elapsed)}` : ''} · ${replay.next} new block${replay.next === 1 ? '' : 's'}`;
    if (f < 1) replay.raf = requestAnimationFrame(frame);
    else setTimeout(() => { if (replay?.t === t) stopReplay(); }, 1500);
  };
  replay.raf = requestAnimationFrame(frame);
}

// Back to the walk card, with every block showing its real state again.
function stopReplay(reopen = true) {
  if (!replay) return;
  const { t, lights } = replay;
  cancelAnimationFrame(replay.raf);
  replay = null;
  for (const { id } of lights) view.setBlockState(id, blockState(id));
  view.setReplay(null);
  $('#replay-bar').hidden = true;
  if (reopen) openWalkDetail(tracks.find((x) => x.id === t.id) || t);
}

function closeWalkDetail() {
  stopReplay(false);
  walkOpen = null;
  $('#walk-detail').hidden = true;
  view.setTrim([], 0, 0);
}

async function saveWalk(next) {
  await db.put('tracks', next);
  tracks = tracks.map((x) => (x.id === next.id ? next : x));
  await rebuild();
  openWalkDetail(next);
}

async function saveTrim() {
  if (!walkOpen) return;
  const { track, i0, i1 } = walkOpen;
  const base = track.original || track.points;
  const next = i0 === 0 && i1 === base.length - 1 ? untrimWalk(track) : trimWalk(track, i0, i1);
  await saveWalk(next);
  toast('Walk trimmed: blocks recounted', 2500);
}

async function undoTrim() {
  if (!walkOpen?.track.original) return;
  await saveWalk(untrimWalk(walkOpen.track));
  toast('Trim undone', 2000);
}

// Neighborhoods grouped by borough, most-walked first.
function renderHoods() {
  const list = $('#hood-list');
  list.replaceChildren();
  if (!lastSummary) return list.append(emptyRow('Loading neighborhoods…'));
  const q = $('#hood-search').value.trim().toLowerCase();
  const frac = (x) => (x.length ? x.walkedLength / x.length : 0);
  const boroughs = [...lastSummary.boroughs].sort((a, b) => frac(b) - frac(a) || a.name.localeCompare(b.name));
  let shown = 0;
  for (const boro of boroughs) {
    const hoods = lastSummary.hoods
      .filter((h) => h.borough === boro.name && (!q || h.name.toLowerCase().includes(q)))
      .sort((a, b) => frac(b) - frac(a) || a.name.localeCompare(b.name));
    if (!hoods.length) continue;
    if (!q) {
      const head = row({
        title: boro.name,
        sub: `${boro.walked.toLocaleString()} of ${boro.blocks.toLocaleString()} blocks · ${km(boro.walkedLength)} of ${km(boro.length)}`,
        frac: frac(boro),
        pct: frac(boro) * 100,
      });
      head.classList.add('group-head');
      list.append(head);
    }
    for (const h of hoods) {
      shown++;
      list.append(row({
        title: h.name,
        sub: `${q ? `${h.borough} · ` : ''}${h.walked.toLocaleString()} of ${h.blocks.toLocaleString()} blocks · ${km(h.length)}`
          + (h.pathWalkedLength ? ` · ${km(h.pathWalkedLength)} of paths` : ''),
        frac: frac(h),
        pct: frac(h) * 100,
        onOpen: () => openHood(h.id),
      }));
    }
  }
  if (!shown) list.append(emptyRow('No neighborhoods match.'));
}

function renderSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => { el.checked = !!settings[el.dataset.setting]; });
  $('#native-settings').hidden = !native;
  $('#battery-settings').hidden = !!native;
  if (native) native.call('status').then(renderNativeStatus).catch(() => {});
  if (native) native.call('healthAvailable').then((ok) => { $('#health-settings').hidden = !ok; }).catch(() => {});
  if (native) renderBackupStatus();
  document.querySelectorAll('#map-theme button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.theme === settings.mapTheme));
  renderZones();
  renderStorageInfo();
}

// ---------------------------------------------------------------- no-tracking areas
const sizeLabel = (r) => (ZONE_SIZES.find((s) => s.r === r)?.label || `${r} m`).toLowerCase();
let zoneDraft = null; // { shape: 'circle' | 'block', r, ring? } while placing a new area

function renderZones() {
  const list = $('#zone-list');
  list.replaceChildren();
  for (const z of settings.zones) {
    const row = document.createElement('div');
    row.className = 'setting';
    row.innerHTML = '<span><b></b><small></small></span><button class="act">Remove</button>';
    row.querySelector('b').textContent = z.name;
    row.querySelector('small').textContent = z.ring ? 'one block' : `${sizeLabel(z.r)} · ${Math.round(z.r)} m around`;
    row.querySelector('b').addEventListener('click', () => { closeSheet(); view.setView([z.lat, z.lon], 16); });
    row.querySelector('button').addEventListener('click', () => removeZone(z.id));
    list.append(row);
  }
}

function drawZones() {
  const preview = !zoneDraft ? null
    : zoneDraft.shape === 'block' ? (zoneDraft.ring ? { ring: zoneDraft.ring, lat: zoneDraft.ring[0][0] } : null)
      : { r: zoneDraft.r, lat: view.getCenter()[0], lon: view.getCenter()[1] };
  view?.setZones(settings.zones, preview);
}

// The map, and the iPhone app (which leaves these areas out of automatic walks).
function syncZones() {
  drawZones();
  native?.call('setZones', {
    zones: settings.zones.map(({ lat, lon, r, ring, pad }) => (ring ? { lat, lon, r: 0, ring, pad: pad ?? BLOCK_PAD } : { lat, lon, r })),
  }).catch(() => {});
}

function startZoneDraft() {
  closeSheet();
  zoneDraft = { shape: 'circle', r: ZONE_SIZES[1].r };
  $('#zone-name').value = '';
  renderZoneSizes();
  setZoneShape('circle');
  $('#zone-edit').hidden = false;
  // Center the circle in the part of the map the card doesn't cover.
  const covered = $('#zone-edit').getBoundingClientRect();
  view.map.setPadding({ top: 0, left: 0, right: 0, bottom: Math.max(0, innerHeight - covered.top) });
  if (view.getZoom() < 15.5) view.setView(view.getCenter(), 16);
  drawZones();
}

// Circle: follows the middle of the map. Block: tap a block to pick it.
function setZoneShape(shape) {
  zoneDraft.shape = shape;
  document.querySelectorAll('#zone-shape button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.shape === shape));
  $('#zone-size').hidden = shape === 'block';
  $('#zone-hint').textContent = shape === 'block'
    ? (zoneDraft.ring ? 'Got it. Tap another block to change it.' : 'Tap your block on the map. Zoom in close if it’s small.')
    : 'Move the map so the circle covers the place.';
  view.onPick = shape === 'block' ? pickZoneBlock : null;
  $('#zone-save').disabled = shape === 'block' && !zoneDraft.ring;
  drawZones();
}

function pickZoneBlock(latlon) {
  const ring = blockAround(city.graph, latlon);
  if (!ring) return toast('No block there (a park or the edge of the map?). Try a circle instead.', 3500);
  zoneDraft.ring = ring;
  setZoneShape('block');
}

function renderZoneSizes() {
  document.querySelectorAll('#zone-size button').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.r) === zoneDraft?.r));
}

function endZoneDraft() {
  zoneDraft = null;
  view.onPick = null;
  $('#zone-edit').hidden = true;
  view.map.setPadding({ top: 0, left: 0, right: 0, bottom: 0 });
  drawZones();
}

async function saveZone() {
  const name = $('#zone-name').value.trim() || `Area ${settings.zones.length + 1}`;
  const id = Date.now().toString(36);
  let zone;
  if (zoneDraft.shape === 'block') {
    if (!zoneDraft.ring) return toast('Tap your block on the map first.');
    const ring = zoneDraft.ring.map(([la, lo]) => [+la.toFixed(6), +lo.toFixed(6)]);
    const lat = ring.reduce((s, p) => s + p[0], 0) / ring.length, lon = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    zone = { id, name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), ring, pad: BLOCK_PAD };
  } else {
    const [lat, lon] = view.getCenter();
    zone = { id, name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), r: zoneDraft.r };
  }
  settings.zones = [...settings.zones, zone];
  saveSettings();
  endZoneDraft();
  syncZones();
  await rebuild();
  toast(`“${name}” added: walking there won’t count`, 3500);
}

async function removeZone(id) {
  const z = settings.zones.find((x) => x.id === id);
  if (!z || !confirm(`Remove “${z.name}”? Walks there will count again.`)) return;
  settings.zones = settings.zones.filter((x) => x.id !== id);
  saveSettings();
  syncZones();
  renderZones();
  await rebuild();
}

// ---------------------------------------------------------------- iPhone app
// Walks the phone recorded by itself (app closed or in the background).
async function importNativeWalks() {
  if (!native) return [];
  let walks;
  try { walks = await native.call('takeWalks'); } catch { return []; }
  const have = new Set(tracks.map((t) => t.nativeId).filter(Boolean));
  const added = [];
  for (const w of walks || []) {
    if (have.has(w.id) || w.points.length < 2) continue;
    const t = nativeWalkToTrack(w);
    if (t.points.length < 2) continue; // nothing usable (e.g. all underground)
    t.id = await db.put('tracks', t);
    tracks.push(t);
    added.push(t);
  }
  // Only now that they're saved here can the phone forget them.
  if (walks?.length) await native.call('ackWalks', { ids: walks.map((w) => w.id) }).catch(() => {});
  return added;
}

window.addEventListener('native-walks', async () => {
  if (!city.index) return;
  refreshSteps(); // the app came back to the screen: today's steps moved on
  const added = await importNativeWalks();
  const fromHealth = settings.healthAuto ? await importHealth({ quiet: true, rebuildAfter: false }) : 0;
  if (!added.length && !fromHealth) return;
  await rebuild();
  if (fromHealth) toast(`${fromHealth} walk${fromHealth === 1 ? '' : 's'} added from Apple Health`, 4000);
  queueWalkSummaries(added);
});

const SOURCE_LABEL = { gpx: 'imported', auto: 'automatic', health: 'Apple Health' };

// Walking/running/hiking workouts with a GPS route from Apple Health. Fetched in
// pages after a saved cursor, so each workout is only read once.
let importingHealth = false;
async function importHealth({ quiet = false, rebuildAfter = true } = {}) {
  if (!native || importingHealth) return 0;
  importingHealth = true;
  let added = 0;
  try {
    let since = (await db.get('meta', 'healthCursor').catch(() => 0)) || 0;
    const have = new Set(tracks.map((t) => t.nativeId).filter(Boolean));
    for (let page = 0; page < 200; page++) {
      const res = await native.call('healthImport', { since, limit: 20 });
      for (const w of res.walks) {
        if (have.has(w.id)) continue;
        const t = nativeWalkToTrack(w, 'health');
        t.id = await db.put('tracks', t);
        tracks.push(t);
        have.add(w.id);
        added++;
      }
      since = res.cursor;
      await db.put('meta', since, 'healthCursor');
      if (!quiet) toast(`Importing from Apple Health… ${added} walk${added === 1 ? '' : 's'}`, 30000);
      if (!res.more) break;
    }
    if (!settings.healthAuto) { settings.healthAuto = true; saveSettings(); }
    if (added && rebuildAfter) await rebuild();
    if (!quiet) {
      toast(added
        ? `Imported ${added} walk${added === 1 ? '' : 's'} from Apple Health`
        : 'No new walks with a route in Apple Health. (If you didn’t allow access, turn it on in the Health app › Sharing › Apps › WalkTracker.)', 6000);
    }
  } catch (err) {
    if (!quiet) toast(`Couldn’t read Apple Health: ${err.message || err}`, 6000);
  } finally {
    importingHealth = false;
  }
  return added;
}

// Automatic backup (iPhone app): after any change to walks or blocks, the whole
// backup is written to a folder picked once in Files, e.g. in iCloud Drive.
let backupFolder = null;
let backupTimer = 0;
let lastBackupAt = Number(localStorage.getItem('walktracker.lastBackup')) || 0;
const BACKUP_DELAY = 10000;     // wait for a burst of changes to settle
const BACKUP_MIN_GAP = 120000;  // and back up at most every 2 minutes while things keep changing

async function loadBackupFolder() {
  if (!native) return;
  try { backupFolder = await native.call('backupFolder'); } catch { backupFolder = null; }
}

function scheduleBackup() {
  if (!native || !backupFolder) return;
  clearTimeout(backupTimer);
  const wait = Math.max(BACKUP_DELAY, lastBackupAt + BACKUP_MIN_GAP - Date.now());
  backupTimer = setTimeout(() => runBackup({ quiet: true }), wait);
}

async function runBackup({ quiet = false } = {}) {
  clearTimeout(backupTimer);
  backupTimer = 0;
  if (!native || !backupFolder) return;
  // A walk in progress saves itself every few seconds; back up once it's over.
  if (rec && quiet) { backupTimer = setTimeout(() => runBackup({ quiet: true }), BACKUP_MIN_GAP); return; }
  try {
    const json = JSON.stringify(await db.exportAll());
    await native.call('writeBackup', { json, day: stamp() });
    lastBackupAt = Date.now();
    try { localStorage.setItem('walktracker.lastBackup', String(lastBackupAt)); } catch {}
    if (!quiet) toast(`Backed up to “${backupFolder}”`);
  } catch (err) {
    toast(`Backup failed: ${err.message || err}`, 6000);
  }
  if (!$('#native-settings').hidden) renderBackupStatus();
}

function renderBackupStatus() {
  const on = !!backupFolder;
  $('#btn-backup-folder').textContent = on ? `Backup folder: ${backupFolder}` : 'Choose backup folder';
  $('#btn-backup-now').hidden = !on;
  $('#btn-backup-stop').hidden = !on;
  $('#backup-status').textContent = on
    ? `On. Saves “WalkTracker backup.json” (plus a copy for each of the last 10 days) after every change. `
      + (lastBackupAt ? `Last backup ${new Date(lastBackupAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : 'No backup yet.')
      + ' To restore, use Import backup below and pick the file.'
    : 'Pick a folder (an iCloud Drive folder keeps it off this phone) and WalkTracker saves a backup there after every change. To restore, use Import backup below and pick the file.';
}

async function chooseBackupFolder() {
  try {
    const name = await native.call('chooseBackupFolder');
    if (!name) return;
    backupFolder = name;
    await runBackup();
  } catch (err) {
    toast(`Couldn’t use that folder: ${err.message || err}`, 6000);
  }
  renderBackupStatus();
}

async function stopBackup() {
  if (!confirm('Stop backing up automatically? Backups already saved stay in the folder.')) return;
  await native.call('forgetBackupFolder').catch(() => {});
  backupFolder = null;
  clearTimeout(backupTimer);
  renderBackupStatus();
}

if (native) {
  db.onChange = scheduleBackup;
  loadBackupFolder();
  // Leaving the app: don't wait for the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && backupTimer) runBackup({ quiet: true });
  });
  $('#btn-backup-folder').addEventListener('click', chooseBackupFolder);
  $('#btn-backup-now').addEventListener('click', () => runBackup());
  $('#btn-backup-stop').addEventListener('click', stopBackup);
}

function renderNativeStatus(st) {
  if (!st) return;
  $('#opt-autotrack').checked = !!st.autoTrack;
  const problems = [];
  if (st.autoTrack && st.location !== 'always') problems.push('set Location to “Always”');
  if (st.autoTrack && st.motion === 'denied') problems.push('turn on Motion & Fitness');
  $('#btn-native-settings').hidden = !problems.length;
  $('#native-status').textContent = !st.autoTrack
    ? 'Off: walks are only recorded when you tap Start walk (they keep recording with the phone locked).'
    : problems.length
      ? `Almost there: in iPhone Settings › WalkTracker, ${problems.join(' and ')}.`
      : st.recording ? 'On. Recording a walk right now.' : 'On. Walks are recorded automatically.';
}

function onSettingChange(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'mapTheme') { applyMapStyle(); renderSettings(); }
  if (key === 'showTracks') drawTracks();
  if (key === 'showHeatmap') { view?.setHeatVisible(value); drawHeat(); }
  if (key === 'showLandmarks' || key === 'showStations') {
    view?.setPlaceKinds({ landmark: settings.showLandmarks, station: settings.showStations });
    renderLegend();
  }
  if (key === 'autoDark') armAutoDark();
  if (key === 'smartGps') {
    if (value) askMotionPermission();
    else if (rec?.paused) resume();
  }
}

function selectTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  $('#sheet').scrollTop = 0;
  renderSheet();
}

// Swipe the sheet down to close it.
(() => {
  const sheet = $('#sheet');
  const head = $('#sheet-head');
  let y0 = null, dy = 0;
  head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; }, { passive: true });
  head.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  head.addEventListener('touchend', () => {
    sheet.style.transition = 'transform 0.2s';
    if (dy > 90) closeSheet();
    else sheet.style.transform = '';
    y0 = null;
  });
  // Tap on the dimmed backdrop closes too.
  sheet.addEventListener('click', (e) => {
    const r = sheet.getBoundingClientRect();
    if (e.clientY < r.top || e.clientX < r.left || e.clientX > r.right) closeSheet();
  });
})();

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  if (!msg) { el.classList.remove('show'); return; }
  el.textContent = msg;
  el.classList.add('show');
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- wiring
$('#btn-record').addEventListener('click', () => (rec ? stopWalk() : startWalk()));
$('#btn-locate').addEventListener('click', locateOnce);
$('#btn-pocket').addEventListener('click', enterPocket);
$('#btn-menu').addEventListener('click', openSheet);
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
document.querySelectorAll('#street-filters button').forEach((b) => b.addEventListener('click', () => {
  streetFilter = b.dataset.f;
  document.querySelectorAll('#street-filters button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderStreets();
}));
$('#street-search').addEventListener('input', renderStreets);
$('#hood-search').addEventListener('input', renderHoods);
$('#btn-resume').addEventListener('click', () => resumable && startWalk(resumable));
$('#sum-next').addEventListener('click', showNextSummary);
$('#wd-close').addEventListener('click', closeWalkDetail);
$('#wd-replay').addEventListener('click', startReplay);
$('#rp-stop').addEventListener('click', () => stopReplay());
$('#wd-start').addEventListener('input', previewTrim);
$('#wd-end').addEventListener('input', previewTrim);
$('#wd-trim-save').addEventListener('click', saveTrim);
$('#wd-trim-undo').addEventListener('click', undoTrim);
$('#btn-zone-add').addEventListener('click', startZoneDraft);
$('#zone-cancel').addEventListener('click', endZoneDraft);
$('#zone-save').addEventListener('click', saveZone);
document.querySelectorAll('#zone-shape button').forEach((b) => b.addEventListener('click', () => setZoneShape(b.dataset.shape)));
document.querySelectorAll('#zone-size button').forEach((b) => b.addEventListener('click', () => {
  zoneDraft.r = Number(b.dataset.r);
  renderZoneSizes();
  syncZones();
}));
view?.map.on('move', () => { if (zoneDraft) drawZones(); });
$('#sum-map').addEventListener('click', showSummaryOnMap);
$('#btn-resume-finish').addEventListener('click', finishResumable);
$('#btn-install-ok').addEventListener('click', dismissInstallTip);
$('#opt-autotrack').addEventListener('change', (e) => native?.call('setAutoTrack', { on: e.target.checked }).then(renderNativeStatus));
$('#btn-native-settings').addEventListener('click', () => native?.call('openSettings'));
$('#btn-health-import').addEventListener('click', () => importHealth());
$('#hud-place').addEventListener('click', showHudPlace);
$('#hud-ring').addEventListener('click', () => { openSheet(); selectTab('progress'); });
$('#place-search').addEventListener('input', renderPlacesView);
document.querySelectorAll('#place-filters button').forEach((b) => b.addEventListener('click', () => {
  placeFilter = b.dataset.f;
  document.querySelectorAll('#place-filters button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderPlacesView();
}));
document.querySelectorAll('#progress-switch button').forEach((b) => b.addEventListener('click', () => {
  progressView = b.dataset.view;
  renderProgress();
}));
document.querySelectorAll('#hud-scope button').forEach((b) => b.addEventListener('click', () => setHudScope(b.dataset.scope)));
$('#btn-export-backup').addEventListener('click', exportBackup);
$('#btn-export-gpx').addEventListener('click', exportGpx);
$('#btn-import').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
$('#btn-persist').addEventListener('click', persistStorage);
$('#btn-wipe').addEventListener('click', wipe);
document.querySelectorAll('[data-setting]').forEach((el) => {
  el.addEventListener('change', () => onSettingChange(el.dataset.setting, el.checked));
});
window.addEventListener('pagehide', () => { if (rec) saveRec(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.querySelectorAll('#map-theme button').forEach((b) => b.addEventListener('click', () => onSettingChange('mapTheme', b.dataset.theme)));
$('#btn-token').addEventListener('click', () => { closeSheet(); showSetup(); });

if (view) load().catch((err) => { console.error(err); toast('Could not open storage on this device.', 6000); });
else if (!token) showSetup();
else toast('The map couldn’t load. Check your connection and reopen the app.', 60000);

// Handy for debugging from the browser console.
window.walktracker = { city, db, rebuild, settings, view, awake, native, get rec() { return rec; } };

// iOS scrolls the whole page up to show the keyboard and sometimes leaves it
// there after the keyboard closes, which pushes the map and cards off-screen.
document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('input, textarea')) setTimeout(() => window.scrollTo(0, 0), 50);
});
