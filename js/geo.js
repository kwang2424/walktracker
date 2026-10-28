// Pure geometry + coverage logic. No DOM, so it runs in the browser and in Node tests.
// Coordinates are [lat, lon] arrays. Track points are [lat, lon, timeMs?].

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function polylineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1], coords[i]);
  return len;
}

// Flat projection around a reference latitude. Accurate to well under a meter
// at street scale, which is all the matching needs.
export function makeProjector(lat0) {
  const k = Math.cos(toRad(lat0));
  return (p) => [toRad(p[1]) * R * k, toRad(p[0]) * R];
}

// Distance from point p to segment ab, all in projected meters.
export function pointSegDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}

// Evenly spaced points along a polyline. The first and last `trim` meters are
// skipped so that crossing an intersection doesn't count toward the side streets.
export function sampleAlong(coords, step, trim = 0) {
  const total = polylineLength(coords);
  const t0 = Math.min(trim, total * 0.35);
  const span = total - 2 * t0;
  const n = Math.max(1, Math.round(span / step));
  const targets = [];
  for (let i = 0; i < n; i++) targets.push(t0 + ((i + 0.5) * span) / n);
  const out = [];
  let walked = 0;
  let seg = 1;
  for (const target of targets) {
    while (seg < coords.length) {
      const d = haversine(coords[seg - 1], coords[seg]);
      if (walked + d >= target || seg === coords.length - 1) {
        const t = d ? Math.min(1, (target - walked) / d) : 0;
        const a = coords[seg - 1];
        const b = coords[seg];
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        break;
      }
      walked += d;
      seg++;
    }
  }
  return out;
}

// --- OpenStreetMap -> blocks -------------------------------------------------

// Streets people walk along. Footpaths, service roads and highways are left
// out, matching how block-walking apps count "every street".
export const WALKABLE_HIGHWAYS = [
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary',
  'tertiary_link', 'residential', 'unclassified', 'living_street', 'pedestrian',
];

// `center` ([lat, lon]) also asks which neighborhood the area is in, to name it.
export function overpassQuery([south, west, north, east], center) {
  const hw = WALKABLE_HIGHWAYS.join('|');
  let q =
    `[out:json][timeout:90];` +
    `way["highway"~"^(${hw})$"]["area"!="yes"]["access"!~"^(private|no)$"]["foot"!="no"]` +
    `(${south},${west},${north},${east});(._;>;);out body;`;
  if (center) {
    q += `is_in(${center[0]},${center[1]})->.a;` +
      `area.a["name"]["place"~"^(neighbourhood|quarter|suburb|borough|city_district|town|village|city)$"];out tags;`;
  }
  return q;
}

// Just the neighborhood lookup, sent separately so a slow lookup never holds up the streets.
export function placeQuery(center) {
  return `[out:json][timeout:15];is_in(${center[0]},${center[1]})->.a;` +
    `area.a["name"]["place"~"^(neighbourhood|quarter|suburb|borough|city_district|town|village|city)$"];out tags;`;
}

const PLACE_RANK = ['neighbourhood', 'quarter', 'suburb', 'city_district', 'borough', 'village', 'town', 'city'];

// The most local place name in an Overpass response, or '' if none.
export function placeName(osm) {
  const places = (osm.elements || []).filter((e) => e.type === 'area' && e.tags && e.tags.name);
  places.sort((a, b) => PLACE_RANK.indexOf(a.tags.place) - PLACE_RANK.indexOf(b.tags.place));
  return places.length ? places[0].tags.name : '';
}

// Split OSM ways at intersections. Each piece between two intersections is a "block".
export function buildBlocks(osm, { minLength = 5 } = {}) {
  const nodes = new Map();
  const ways = [];
  for (const el of osm.elements || []) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way') ways.push(el);
  }
  const uses = new Map();
  for (const w of ways) {
    for (const id of w.nodes) uses.set(id, (uses.get(id) || 0) + 1);
    // A way that loops back on itself has its first node counted twice already.
  }
  const blocks = [];
  for (const w of ways) {
    const ids = w.nodes.filter((id) => nodes.has(id));
    if (ids.length < 2) continue;
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      const isEnd = i === ids.length - 1;
      if (!isEnd && (uses.get(ids[i]) || 0) < 2) continue;
      const part = ids.slice(start, i + 1);
      const coords = part.map((id) => nodes.get(id));
      const length = polylineLength(coords);
      if (length >= minLength) {
        blocks.push({
          id: `${w.id}:${part[0]}-${part[part.length - 1]}:${start}`,
          name: (w.tags && w.tags.name) || '',
          highway: (w.tags && w.tags.highway) || '',
          coords,
          length,
          from: part[0], // OSM node ids at each end, used to name cross streets
          to: part[part.length - 1],
        });
      }
      start = i;
    }
  }
  return blocks;
}

// --- Coverage ------------------------------------------------------------------

export const DEFAULTS = {
  threshold: 25, // meters a GPS point may be from the street centerline
  step: 10, // meters between sample points along a block
  walkedFraction: 0.8, // share of a block's samples that must be covered
  maxGap: 100, // don't connect track points further apart than this (GPS dropout)
  maxSpeed: 7, // m/s; faster segments (car, subway, bike) are ignored
};

export class CoverageEngine {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.cell = this.opts.threshold * 2;
    this.setBlocks([]);
  }

  setBlocks(blocks) {
    this.blocks = new Map();
    this.grid = new Map();
    const lat0 = blocks.length
      ? blocks.reduce((s, b) => s + b.coords[0][0], 0) / blocks.length
      : 0;
    this.project = makeProjector(lat0);
    for (const b of blocks) {
      const samples = sampleAlong(b.coords, this.opts.step, this.opts.threshold * 1.5).map(this.project);
      const state = { block: b, samples, covered: new Uint8Array(samples.length), count: 0 };
      this.blocks.set(b.id, state);
      samples.forEach((s, i) => {
        const key = this._key(Math.floor(s[0] / this.cell), Math.floor(s[1] / this.cell));
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push(state, i);
      });
    }
  }

  _key(cx, cy) {
    return cx + ',' + cy;
  }

  // Mark samples near the segment a->b. Returns ids of blocks whose coverage changed.
  addSegment(a, b, changed = new Set()) {
    const dist = haversine(a, b);
    if (dist > this.opts.maxGap) return changed;
    if (a[2] != null && b[2] != null && b[2] > a[2] && dist / ((b[2] - a[2]) / 1000) > this.opts.maxSpeed) {
      return changed;
    }
    const pa = this.project(a);
    const pb = this.project(b);
    const th = this.opts.threshold;
    const x0 = Math.floor((Math.min(pa[0], pb[0]) - th) / this.cell);
    const x1 = Math.floor((Math.max(pa[0], pb[0]) + th) / this.cell);
    const y0 = Math.floor((Math.min(pa[1], pb[1]) - th) / this.cell);
    const y1 = Math.floor((Math.max(pa[1], pb[1]) + th) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.grid.get(this._key(cx, cy));
        if (!list) continue;
        for (let j = 0; j < list.length; j += 2) {
          const state = list[j];
          const i = list[j + 1];
          if (state.covered[i]) continue;
          if (pointSegDist(state.samples[i], pa, pb) <= th) {
            state.covered[i] = 1;
            state.count++;
            changed.add(state.block.id);
          }
        }
      }
    }
    return changed;
  }

  addTrack(points, changed = new Set()) {
    if (points.length === 1) this.addSegment(points[0], points[0], changed);
    for (let i = 1; i < points.length; i++) this.addSegment(points[i - 1], points[i], changed);
    return changed;
  }

  fraction(id) {
    const s = this.blocks.get(id);
    return s && s.samples.length ? s.count / s.samples.length : 0;
  }

  isWalked(id) {
    return this.fraction(id) >= this.opts.walkedFraction;
  }
}

// Totals and per-street breakdown. `overrides` maps block id -> true/false.
export function summarize(engine, overrides = {}) {
  let total = 0, walked = 0, totalLen = 0, walkedLen = 0;
  const streets = new Map();
  for (const [id, s] of engine.blocks) {
    const b = s.block;
    const done = id in overrides ? !!overrides[id] : engine.isWalked(id);
    total++;
    totalLen += b.length;
    if (done) { walked++; walkedLen += b.length; }
    const name = b.name || '(unnamed)';
    let st = streets.get(name);
    if (!st) streets.set(name, (st = { name, total: 0, walked: 0, totalLen: 0, walkedLen: 0 }));
    st.total++;
    st.totalLen += b.length;
    if (done) { st.walked++; st.walkedLen += b.length; }
  }
  return { total, walked, totalLen, walkedLen, streets: [...streets.values()] };
}
