import { haversine, polylineLength, pointInMultiPolygon } from './geo.js';
import { parseGpx, toGpx } from './gpx.js';
import { db } from './db.js';
import { StillnessDetector, MotionWake, throttle } from './power.js';
import { streak, weekStats } from './stats.js';
import { MapView, BLOCKS_MIN_ZOOM } from './mapview.js';
import { MAPBOX_TOKEN } from './config.js';
import { City, CITY_BASE, overrideWalked } from './city.js';

const MAX_VISIBLE_HOODS = 30; // load blocks for at most this many neighborhoods on screen
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
const settings = { autoDark: true, smartGps: true, mapTheme: 'faded', showTracks: true };
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
  $('#setup-url').textContent = location.origin + location.pathname.replace(/index\.html$/, '');
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
  onUserMove: () => { lastDrag = Date.now(); },
  onMoveEnd: () => onMapMoved(),
  onAuthError: (status) => showSetup(`Mapbox didn’t accept this token (error ${status}). Check that it’s copied fully, and if it has URL restrictions, that they include ${location.origin + location.pathname.replace(/index\.html$/, '')}`),
}) : null;

function applyMapStyle() {
  view.setColors(readColors());
  view.setLook(mapLook());
}
if (view) darkQuery.addEventListener('change', applyMapStyle);

const isDone = (id) => city.isWalked(id, overrides);

function blockState(id) {
  if (isDone(id)) return 'walked';
  if (city.fraction(id) > 0.34) return 'partial';
  return 'none';
}

function drawBlocks() {
  const blocks = city.loadedBlocks();
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
    if (asleep()) { blocksDirty = true; return; }
    drawBlocks();
    renderStats();
  }, 120);
}
let blocksDirty = false;

function drawTracks() {
  view.setTracks(tracks.map((t) => t.points));
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
  el.querySelector('.pop-title').textContent = block.name || 'Unnamed street';
  el.querySelector('.pop-sub').textContent = [crossStreets(block), city.hoods.get(block.hood)?.name, `${Math.round(block.length)} m`].filter(Boolean).join(' · ');
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
  const pct = s.length ? (100 * s.walkedLength) / s.length : 0;
  $('#ring-fill').style.strokeDashoffset = RING * (1 - pct / 100);
  $('#stat-pct').textContent = fmtPct(pct);
  $('#stat-blocks').textContent = s.walked.toLocaleString();
  $('#stat-total').textContent = s.blocks.toLocaleString();
  $('#stat-dist').textContent = `${km(s.walkedLength)} of ${km(s.length)} of NYC walked`;

  const all = rec ? [...tracks, { startedAt: rec.track.startedAt, distance: rec.dist, points: [] }] : tracks;
  const week = weekStats(all, city.completedAt);
  $('#chip-week').textContent = `This week · ${km(week.meters)} · ${week.blocks} new block${week.blocks === 1 ? '' : 's'}`;
  const days = streak(all);
  $('#chip-streak').hidden = days < 2;
  $('#chip-streak').textContent = `🔥 ${days}-day streak`;

  // Shade each neighborhood on the map by how much of it you've walked.
  s.hoods.forEach((h, i) => view.setHoodProgress(i, h.length ? h.walkedLength / h.length : 0));
  renderHoodChip();
  $('#hud').hidden = !!rec;
  if ($('#sheet').open) renderSheet();
}
const updateStats = throttle(renderStats, 1000);

// ---------------------------------------------------------------- data loading
async function reloadData() {
  [tracks, overrides] = await Promise.all([db.all('tracks'), db.overrides()]);
}

// Load the neighborhoods your walks and hand-marked blocks are in.
async function rebuild() {
  const ids = new Set(city.setTracks(tracks));
  for (const v of Object.values(overrides)) if (v?.hood) ids.add(v.hood);
  drawTracks();
  if (ids.size > 4) toast('Loading your progress…', 15000);
  await city.ensure([...ids]).catch((err) => console.warn('Some neighborhoods did not load', err));
  if (ids.size > 4) toast('');
  drawBlocks();
  renderStats();
}

async function load() {
  await reloadData();
  // A walk still marked in-progress means the app was closed mid-walk. Keep what was saved.
  for (const t of tracks) {
    if (t.inProgress) {
      t.inProgress = false;
      t.name ||= 'Recovered walk';
      t.distance = polylineLength(t.points);
      await db.put('tracks', t);
    }
  }
  view.setView([40.7306, -73.9866], 14);
  try {
    await city.init();
    outlines = await fetch(CITY_BASE + 'neighborhoods.geojson').then((r) => r.json());
  } catch (err) {
    console.error(err);
    toast('The NYC street data couldn’t load. Check your connection and reopen the app.', 10000);
    return;
  }
  view.setHoods(outlines);
  await rebuild();
  centerOnMe({ quiet: true });
}

// ---------------------------------------------------------------- neighborhoods
// Zoomed in far enough, load the blocks of the neighborhoods on screen.
const onMapMoved = throttle(() => {
  if (!city.index) return;
  renderHoodChip();
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

function hoodPct(id) {
  const h = lastSummary?.hoods.find((x) => x.id === id);
  return h && h.length ? (100 * h.walkedLength) / h.length : 0;
}

function renderHoodChip() {
  const chip = $('#chip-hood');
  const h = view.getZoom() >= 12 ? hoodAtCenter() : null;
  chip.hidden = !h;
  if (!h) return;
  chip.dataset.id = h.id;
  $('#chip-hood-name').textContent = h.name;
  $('#chip-hood-pct').textContent = fmtPct(hoodPct(h.id));
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

async function startWalk() {
  if (!('geolocation' in navigator)) return toast('This browser has no GPS access.');
  if (settings.smartGps) askMotionPermission(); // must run straight from the tap
  const track = { name: '', startedAt: Date.now(), points: [], inProgress: true, source: 'recorded' };
  rec = {
    track, points: track.points, dist: 0, newBlocks: new Set(), lastSave: Date.now(),
    still: new StillnessDetector(), paused: false, pausedAt: 0, pausedMs: 0, watchId: null,
  };
  track.id = await db.put('tracks', track);
  city.startLive(rec.points);
  view.setLive([]);
  startGps('high');
  rec.timer = setInterval(tick, 1000);
  document.body.classList.add('recording');
  $('#rec').hidden = false;
  $('#btn-locate').hidden = true;
  $('#btn-pocket').hidden = false;
  $('#btn-record-label').textContent = 'Finish';
  setGps('wait', 'Finding GPS…');
  renderStats();
  tick();
  await keepAwake();
  armAutoDark();
  if (lowBattery) toast('Battery is low: the saver screen will turn on after 10 s.', 4000);
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
  const p = [latitude, longitude, pos.timestamp || Date.now()];

  if (rec.paused) {
    // Low-power fallback while stopped: wake once we've clearly moved.
    if (rec.still.update(p, accuracy) === 'moving') resume();
    return;
  }
  if (!asleep()) showMe(p);
  if (accuracy > MIN_ACCURACY_M) {
    setGps('weak', `Weak GPS ±${Math.round(accuracy)} m`);
    return;
  }
  setGps('good', `GPS ±${Math.round(accuracy)} m`);
  if (settings.smartGps && rec.still.update(p, accuracy) === 'still') {
    pause();
    return;
  }
  const last = rec.points[rec.points.length - 1];
  if (last && haversine(last, p) < MIN_STEP_M) return;
  rec.points.push(p);
  if (!asleep()) view.setLive(rec.points);
  else rec.liveDirty = true;
  if (last) {
    rec.dist += haversine(last, p);
    const changed = city.addLiveSegment(last, p);
    if (changed.size) {
      for (const id of changed) {
        if (!rec.newBlocks.has(id) && city.isWalked(id)) {
          rec.newBlocks.add(id);
          if (!city.completedAt.has(id)) city.completedAt.set(id, rec.track.startedAt);
          celebrate(id);
        }
      }
      queueRestyle(changed);
      updateStats();
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
  return db.put('tracks', rec.track);
}

async function stopWalk() {
  if (!rec) return;
  const r = rec;
  stopGps();
  clearPauseWatchers();
  clearInterval(r.timer);
  clearTimeout(darkTimer);
  rec = null;
  city.stopLive();
  releaseWake();
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
    name: `Walk on ${new Date(r.track.startedAt).toLocaleDateString([], { weekday: 'long' })}`,
  });
  await db.put('tracks', r.track);
  tracks.push(r.track);
  city.setTracks(tracks); // replays loaded neighborhoods with the saved walk
  drawTracks();
  renderStats();
  toast(`Walk saved · ${km(r.dist)} · ${r.newBlocks.size} new block${r.newBlocks.size === 1 ? '' : 's'}`, 4000);
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
let wakeLock = null;
async function keepAwake() {
  // Browsers stop GPS when the screen locks, so keep it on during a walk.
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
}
function releaseWake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

// Coming back to the app after a while: re-center on where you are now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !rec && view && Date.now() - lastCentered > 5 * 60000) centerOnMe({ quiet: true });
});

document.addEventListener('visibilitychange', () => {
  if (!rec) return;
  if (document.visibilityState === 'hidden') saveRec();
  else { keepAwake(); wakeUpUi(); }
});

let darkTimer = null;
function armAutoDark() {
  clearTimeout(darkTimer);
  if (!rec || !settings.autoDark || pocketOn) return;
  darkTimer = setTimeout(enterPocket, lowBattery ? AUTO_DARK_LOW_BATTERY_MS : AUTO_DARK_MS);
}
document.addEventListener('pointerdown', () => { if (rec && !pocketOn) armAutoDark(); }, { capture: true });

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

async function loadStreetTotals() {
  streetTotals ||= fetch(CITY_BASE + 'streets.json').then((r) => r.json()).catch(() => null);
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
      sub: [km(dist), mins ? `${mins} min` : '', t.source === 'gpx' ? 'imported' : ''].filter(Boolean).join(' · '),
      badge: n ? `+${n} block${n === 1 ? '' : 's'}` : '',
      actions: [['Delete', async () => {
        if (!confirm('Delete this walk?')) return;
        await db.delete('tracks', t.id);
        tracks = tracks.filter((x) => x !== t);
        await rebuild();
      }]],
      onOpen: () => {
        closeSheet();
        view.fitPoints(t.points);
      },
    }));
  }
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
        sub: `${q ? `${h.borough} · ` : ''}${h.walked.toLocaleString()} of ${h.blocks.toLocaleString()} blocks · ${km(h.length)}`,
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
  document.querySelectorAll('#map-theme button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.theme === settings.mapTheme));
  renderStorageInfo();
}

function onSettingChange(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'mapTheme') { applyMapStyle(); renderSettings(); }
  if (key === 'showTracks') drawTracks();
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
$('#chip-hood').addEventListener('click', () => openHood($('#chip-hood').dataset.id));
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
window.walktracker = { city, db, rebuild, settings, view, get rec() { return rec; } };
