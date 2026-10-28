// Street data built into this site at deploy time (see scripts/build_streets.py).
// Inside the covered region, adding an area just downloads a few small files
// from the app's own site. Pure helpers here; fetching is passed in so the
// logic can be tested in Node.
import { haversine } from './geo.js';

export const STREETS_BASE = 'data/streets/';

let indexPromise = null;

// The index of built-in street tiles, or null if this site has none.
export function loadIndex(fetchImpl = fetch) {
  indexPromise ||= fetchImpl(STREETS_BASE + 'index.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return indexPromise;
}

// True when the box lies inside one of the regions this site has street data for.
export function covers(index, [s, w, n, e]) {
  return (index?.regions || []).some(({ bounds: [S, W, N, E] }) => s >= S && w >= W && n <= N && e <= E);
}

export function tileKeys(index, [s, w, n, e]) {
  const d = index.tileDeg;
  const have = new Set(index.tiles);
  const keys = [];
  for (let x = Math.floor(w / d); x <= Math.floor(e / d); x++) {
    for (let y = Math.floor(s / d); y <= Math.floor(n / d); y++) {
      if (have.has(`${x}_${y}`)) keys.push(`${x}_${y}`);
    }
  }
  return keys;
}

// Keep only streets with at least one point inside the box (plus a small
// margin), and the nodes they use. Tiles cover more than the area you added.
export function clipToBbox(elements, [s, w, n, e], margin = 0.002) {
  const nodes = new Map();
  for (const el of elements) if (el.type === 'node') nodes.set(el.id, el);
  const inside = (id) => {
    const p = nodes.get(id);
    return p && p.lat >= s - margin && p.lat <= n + margin && p.lon >= w - margin && p.lon <= e + margin;
  };
  const ways = elements.filter((el) => el.type === 'way' && el.nodes.some(inside));
  const used = new Set(ways.flatMap((wy) => wy.nodes));
  return [...[...used].map((id) => nodes.get(id)).filter(Boolean), ...ways];
}

export async function fetchFromPack(index, bbox, fetchImpl = fetch) {
  const files = await Promise.all(tileKeys(index, bbox).map(async (key) => {
    const res = await fetchImpl(`${STREETS_BASE}${key}.json`);
    if (!res.ok) throw new Error(`street tile ${key}: HTTP ${res.status}`);
    return res.json();
  }));
  const seen = new Set();
  const elements = [];
  for (const f of files) {
    for (const el of f.elements) {
      const k = el.type + el.id;
      if (!seen.has(k)) { seen.add(k); elements.push(el); }
    }
  }
  return { elements: clipToBbox(elements, bbox) };
}

// Most local named place near `center`: a neighborhood within 1.5 km beats a
// borough within 5 km. For a big area, skip neighborhoods and name it after
// the district or borough instead.
const PLACE_REACH_KM = { neighbourhood: 1.5, quarter: 1.5, suburb: 2.5, city_district: 4, borough: 5, village: 3, town: 5, city: 10 };
const PLACE_ORDER = Object.keys(PLACE_REACH_KM);

const SMALL_PLACES = new Set(['neighbourhood', 'quarter']);

export function nearestPlace(index, center, { broad = false } = {}) {
  let best = null;
  for (const [lat, lon, name, place] of index?.places || []) {
    if (broad && SMALL_PLACES.has(place)) continue;
    const km = haversine(center, [lat, lon]) / 1000;
    if (km > (PLACE_REACH_KM[place] ?? 0) * (broad ? 3 : 1)) continue;
    const rank = PLACE_ORDER.indexOf(place);
    if (!best || rank < best.rank || (rank === best.rank && km < best.km)) best = { name, rank, km };
  }
  return best ? best.name : '';
}
