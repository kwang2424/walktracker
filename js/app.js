import {
  CoverageEngine, buildBlocks, overpassQuery, placeQuery, placeName, summarize, haversine, polylineLength, midpoint,
} from './geo.js';
import { parseGpx, toGpx } from './gpx.js';
import { db } from './db.js';
import { StillnessDetector, MotionWake, throttle } from './power.js';
import { replayTracks, streak, weekStats } from './stats.js';
import { MapView } from './mapview.js';
import { MAPBOX_TOKEN } from './config.js';
import { loadIndex, covers, fetchFromPack, nearestPlace } from './streets.js';

// Free public OpenStreetMap servers, tried in order. They're sometimes busy,
// so each gets a time limit before the next one is tried.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 30000;
const MAX_AREA_KM2 = 20; // bigger areas often time out on the free street servers
const MAX_AREA_KM2_BUILT_IN = 120; // street data on our own site can handle much more (all of Manhattan is ~60)
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
const engine = new CoverageEngine();
let overrides = {};
let tracks = [];
let areas = [];
let completedAt = new Map(); // block id -> time the block was finished
let newByTrack = new Map(); // track id -> blocks finished on that walk
let nodeNames = new Map(); // OSM node id -> street names meeting there
let lastSummary = null;
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
  onUserMove: () => { lastDrag = Date.now(); },
  onAuthError: (status) => showSetup(`Mapbox didn’t accept this token (error ${status}). Check that it’s copied fully, and if it has URL restrictions, that they include ${location.origin + location.pathname.replace(/index\.html$/, '')}`),
}) : null;

function applyMapStyle() {
  view.setColors(readColors());
  view.setLook(mapLook());
}
if (view) darkQuery.addEventListener('change', applyMapStyle);

const isDone = (id) => (id in overrides ? !!overrides[id] : engine.isWalked(id));

function blockState(id) {
  if (isDone(id)) return 'walked';
  if (engine.fraction(id) > 0.34) return 'partial';
  return 'none';
}

function drawBlocks() {
  view.setBlocks([...engine.blocks.values()].map((s) => s.block));
  for (const id of engine.blocks.keys()) view.setBlockState(id, blockState(id));
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

function drawTracks() {
  view.setTracks(tracks.map((t) => t.points));
  view.setTracksVisible(settings.showTracks);
}

// ---------------------------------------------------------------- block names
function indexNodeNames() {
  nodeNames = new Map();
  for (const { block } of engine.blocks.values()) {
    for (const n of [block.from, block.to]) {
      if (!nodeNames.has(n)) nodeNames.set(n, new Set());
      if (block.name) nodeNames.get(n).add(block.name);
    }
  }
}

function crossStreets(block) {
  const pick = (n) => [...(nodeNames.get(n) || [])].find((x) => x !== block.name) || '';
  const a = pick(block.from);
  const b = pick(block.to);
  if (a && b && a !== b) return `${a} → ${b}`;
  if (a || b) return `near ${a || b}`;
  return '';
}

function openBlockPopup(id, latlng) {
  const { block } = engine.blocks.get(id);
  const f = engine.fraction(id);
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
  el.querySelector('.pop-sub').textContent = [crossStreets(block), `${Math.round(block.length)} m`].filter(Boolean).join(' · ');
  el.querySelector('.pop-status').textContent =
    (done ? 'Walked' : f > 0 ? `${Math.round(f * 100)}% walked` : 'Not walked yet') + (manual ? ' · set by you' : '');
  el.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === 'toggle') { overrides[id] = !done; await db.put('overrides', !done, id); }
    if (act === 'reset') { delete overrides[id]; await db.delete('overrides', id); }
    view.setBlockState(id, blockState(id));
    renderStats();
    view.closePopup();
  });
  view.openPopup(latlng, el);
}

// ---------------------------------------------------------------- stats
const km = (m) => (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000).toLocaleString()) + ' km';
const fmtPct = (p) => (p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)) + '%';

let statsDirty = false;
function renderStats() {
  if (asleep()) { statsDirty = true; return; }
  statsDirty = false;
  const s = (lastSummary = summarize(engine, overrides));
  const pct = s.totalLen ? (100 * s.walkedLen) / s.totalLen : 0;
  $('#ring-fill').style.strokeDashoffset = RING * (1 - pct / 100);
  $('#stat-pct').textContent = fmtPct(pct);
  $('#stat-blocks').textContent = s.walked.toLocaleString();
  $('#stat-total').textContent = s.total.toLocaleString();
  $('#stat-dist').textContent = `${km(s.walkedLen)} of ${km(s.totalLen)} walked`;

  const all = rec ? [...tracks, { startedAt: rec.track.startedAt, distance: rec.dist, points: [] }] : tracks;
  const week = weekStats(all, completedAt);
  $('#chip-week').textContent = `This week · ${km(week.meters)} · ${week.blocks} new block${week.blocks === 1 ? '' : 's'}`;
  const days = streak(all);
  $('#chip-streak').hidden = days < 2;
  $('#chip-streak').textContent = `🔥 ${days}-day streak`;

  const empty = !areas.length;
  $('#empty').hidden = !empty || !!rec;
  $('#hud').hidden = empty || !!rec;
  if ($('#sheet').open) renderSheet();
}
const updateStats = throttle(renderStats, 1000);

// ---------------------------------------------------------------- data loading
// Merge every area's raw OSM data and split it into blocks in one go, so streets
// that cross area borders are split at the same intersections.
function blocksFromAreas() {
  const seen = new Set();
  const elements = [];
  for (const a of areas) {
    for (const el of a.osm) {
      const key = el.type + el.id;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }
  const inside = (p) => areas.some(({ bbox: [s, w, n, e] }) => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e);
  // Overpass returns whole streets; drop the parts outside the chosen areas.
  return buildBlocks({ elements }).filter((b) => inside(midpoint(b.coords)));
}

function rebuild() {
  engine.setBlocks(blocksFromAreas());
  ({ completedAt, newByTrack } = replayTracks(engine, tracks));
  if (rec) engine.addTrack(rec.points);
  indexNodeNames();
  drawBlocks();
  drawTracks();
  renderStats();
}

async function reloadData() {
  [tracks, areas, overrides] = await Promise.all([db.all('tracks'), db.all('areas'), db.overrides()]);
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
  rebuild();
  if (areas.length) {
    view.fitPoints(areas.flatMap(({ bbox: [s, w, n, e] }) => [[s, w], [n, e]]), { animate: false });
  } else {
    view.setView([40.7306, -73.9866], 15);
  }
  centerOnMe({ quiet: true });
}

// ---------------------------------------------------------------- areas
async function addArea() {
  const bbox = view.getBBox();
  const km2 = (haversine([bbox[0], bbox[1]], [bbox[0], bbox[3]]) / 1000) *
    (haversine([bbox[0], bbox[1]], [bbox[2], bbox[1]]) / 1000);
  closeSheet();
  // Street data built into this site is fast and always available; the public
  // servers are only for places outside it.
  const index = await loadIndex();
  let builtIn = covers(index, bbox);
  const limit = builtIn ? MAX_AREA_KM2_BUILT_IN : MAX_AREA_KM2;
  if (km2 > limit) {
    toast(`Zoom in a little: that's ${km2.toFixed(0)} km², the limit is ${limit} km² per area.`, 5000);
    return;
  }
  if (addingArea) return;
  addingArea = true;
  const center = view.getCenter();
  const buttons = [$('#btn-add-area'), $('#btn-empty-add')];
  buttons.forEach((btn) => { btn.disabled = true; btn.dataset.label ||= btn.textContent; btn.textContent = 'Downloading streets…'; });
  const started = Date.now();
  let server = 1;
  const progress = () => {
    const s = Math.round((Date.now() - started) / 1000);
    toast(builtIn ? 'Loading streets…' : `Downloading streets… ${s} s${server > 1 ? ` · trying backup server ${server - 1}` : ''}`, 5000);
  };
  progress();
  const ticker = setInterval(progress, 1000);
  try {
    let osm = builtIn ? await fetchFromPack(index, bbox).catch(() => null) : null;
    // Safety net: if the built-in data is missing or has no streets here, ask the public servers.
    if (!osm?.elements.some((el) => el.type === 'way')) {
      builtIn = false;
      osm = await fetchOverpass(overpassQuery(bbox), { onServer: (n) => { server = n; } });
    }
    const slim = [];
    for (const el of osm.elements) {
      if (el.type === 'node') slim.push({ type: 'node', id: el.id, lat: el.lat, lon: el.lon });
      else if (el.type === 'way') slim.push({ type: 'way', id: el.id, nodes: el.nodes, tags: { name: el.tags?.name, highway: el.tags?.highway } });
    }
    clearInterval(ticker);
    if (!slim.some((el) => el.type === 'way')) { toast('No walkable streets found here.', 4000); return; }
    let name = builtIn ? nearestPlace(index, center, { broad: km2 > 8 }) : '';
    if (!name) {
      toast('Naming the area…', 10000);
      name = await fetchOverpass(placeQuery(center), { timeoutMs: 8000, servers: 1 }).then(placeName).catch(() => '');
    }
    const area = { name: name || `Area ${areas.length + 1}`, bbox, osm: slim, createdAt: Date.now() };
    area.id = await db.put('areas', area);
    const before = engine.blocks.size;
    areas.push(area);
    rebuild();
    toast(`Added ${area.name} · ${(engine.blocks.size - before).toLocaleString()} blocks`, 3500);
  } catch (err) {
    console.error('Street download failed:', err.message);
    toast(navigator.onLine === false
      ? 'You’re offline. Connect to the internet to download streets.'
      : 'The free street servers are busy or slow right now. Try again in a minute, or zoom in to a smaller area.', 7000);
  } finally {
    clearInterval(ticker);
    addingArea = false;
    buttons.forEach((btn) => { btn.disabled = false; btn.textContent = btn.dataset.label; });
  }
}
let addingArea = false;

// Tries each street server with a time limit. Overpass reports some failures
// (like a query timing out) as a normal answer with a "remark", so check that too.
async function fetchOverpass(query, { timeoutMs = OVERPASS_TIMEOUT_MS, servers = OVERPASS.length, onServer } = {}) {
  const problems = [];
  for (const [i, url] of OVERPASS.slice(0, servers).entries()) {
    onServer?.(i + 1);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
      return json;
    } catch (err) {
      problems.push(`${new URL(url).host}: ${err.name === 'AbortError' ? `no answer in ${timeoutMs / 1000} s` : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(problems.join(' | '));
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
    const changed = engine.addSegment(last, p);
    if (changed.size) {
      for (const id of changed) {
        if (!rec.newBlocks.has(id) && engine.isWalked(id)) {
          rec.newBlocks.add(id);
          if (!completedAt.has(id)) completedAt.set(id, rec.track.startedAt);
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
  const { block } = engine.blocks.get(id);
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
  newByTrack.set(r.track.id, r.newBlocks.size);
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
  if (!confirm('Delete all walks, areas and settings on this device? Export a backup first if you want to keep them.')) return;
  if (rec) await stopWalk();
  await Promise.all(['tracks', 'areas', 'overrides'].map((s) => db.clear(s)));
  tracks = []; areas = []; overrides = {};
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
let activeTab = 'streets';
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
  if (activeTab === 'areas') renderAreas();
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
    p.textContent = `${Math.floor(pct)}%`;
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
  progress: { test: (f) => f > 0 && f < 1, sort: (a, b) => b.frac - a.frac, empty: 'Nothing in progress yet. Start a walk!' },
  todo: { test: (f) => f === 0, sort: (a, b) => b.totalLen - a.totalLen, empty: 'You’ve started every street. Nice!' },
  done: { test: (f) => f >= 1, sort: (a, b) => a.name.localeCompare(b.name), empty: 'No streets finished yet.' },
  all: { test: () => true, sort: (a, b) => b.frac - a.frac || b.totalLen - a.totalLen, empty: 'No streets match.' },
};

function renderStreets() {
  const list = $('#street-list');
  list.replaceChildren();
  if (!engine.blocks.size) return list.append(emptyRow('Add an area to see its streets here.'));
  const q = $('#street-search').value.trim().toLowerCase();
  const f = STREET_FILTERS[streetFilter];
  const streets = (lastSummary?.streets || [])
    .map((s) => ({ ...s, frac: s.totalLen ? s.walkedLen / s.totalLen : 0 }))
    .filter((s) => (q ? s.name.toLowerCase().includes(q) : f.test(s.frac)))
    .sort(f.sort);
  if (!streets.length) list.append(emptyRow(q ? 'No streets match.' : f.empty));
  for (const s of streets.slice(0, 300)) {
    list.append(row({
      title: s.name,
      sub: `${s.walked} of ${s.total} block${s.total === 1 ? '' : 's'} · ${km(s.totalLen)}`,
      frac: s.frac,
      pct: s.frac * 100,
      onOpen: () => showStreet(s.name),
    }));
  }
}

let highlightTimer;
function showStreet(name) {
  const ids = [];
  const points = [];
  for (const [id, s] of engine.blocks) {
    if ((s.block.name || '(unnamed)') !== name) continue;
    ids.push(id);
    points.push(...s.block.coords);
  }
  if (!ids.length) return;
  closeSheet();
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
    const n = newByTrack.get(t.id) || 0;
    list.append(row({
      title: when,
      sub: [km(dist), mins ? `${mins} min` : '', t.source === 'gpx' ? 'imported' : ''].filter(Boolean).join(' · '),
      badge: n ? `+${n} block${n === 1 ? '' : 's'}` : '',
      actions: [['Delete', async () => {
        if (!confirm('Delete this walk?')) return;
        await db.delete('tracks', t.id);
        tracks = tracks.filter((x) => x !== t);
        rebuild();
      }]],
      onOpen: () => {
        closeSheet();
        view.fitPoints(t.points);
      },
    }));
  }
}

function renderAreas() {
  const list = $('#area-list');
  list.replaceChildren();
  if (!areas.length) return list.append(emptyRow('No areas yet.'));
  for (const a of areas) {
    const [s, w, n, e] = a.bbox;
    const inA = (p) => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e;
    let tot = 0, done = 0, count = 0;
    for (const [id, st] of engine.blocks) {
      if (!inA(midpoint(st.block.coords))) continue;
      count++;
      tot += st.block.length;
      if (isDone(id)) done += st.block.length;
    }
    const frac = tot ? done / tot : 0;
    list.append(row({
      title: a.name,
      sub: `${count.toLocaleString()} blocks · ${km(tot)}`,
      frac,
      pct: frac * 100,
      actions: [
        ['Rename', async () => {
          const name = prompt('Area name', a.name);
          if (!name) return;
          a.name = name.trim();
          await db.put('areas', a);
          renderAreas();
        }],
        ['Delete', async () => {
          if (!confirm(`Remove "${a.name}"? Your walks are kept.`)) return;
          await db.delete('areas', a.id);
          areas = areas.filter((x) => x !== a);
          rebuild();
        }],
      ],
      onOpen: () => { closeSheet(); view.fitPoints([[s, w], [n, e]]); },
    }));
  }
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
$('#btn-empty-add').addEventListener('click', addArea);
$('#btn-empty-locate').addEventListener('click', locateOnce);
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
document.querySelectorAll('#street-filters button').forEach((b) => b.addEventListener('click', () => {
  streetFilter = b.dataset.f;
  document.querySelectorAll('#street-filters button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderStreets();
}));
$('#street-search').addEventListener('input', renderStreets);
$('#btn-add-area').addEventListener('click', addArea);
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
window.walktracker = { engine, db, rebuild, settings, view, get rec() { return rec; } };
