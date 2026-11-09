// Places to collect (landmarks, subway stations, public art, public plazas
// and bridges), and which ones your walks have passed.
// Data comes from data/nyc/places.json (built by scripts/build_city.mjs).
// No DOM here, so it runs in Node tests too.
import { makeProjector, pointSegDist, haversine } from './geo.js';

export const LANDMARK_RADIUS = 40; // meters from the landmark's outline (you walked past it)
export const STATION_RADIUS = 60; // meters from a platform (the street above it, or an entrance)
export const ART_RADIUS = 30; // meters from a public artwork
export const POPS_RADIUS = 35; // meters from a public plaza's address point
export const BRIDGE_NEAR = 25; // a bridge spot counts as walked within this many meters...
export const BRIDGE_SHARE = 0.6; // ...and the bridge once this share of it is walked
const BRIDGE_STEP = 10; // meters between checked spots along a bridge
const CELL = 0.002; // ~200 m grid for finding nearby places quickly

export const ROUTE_ORDER = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'SIR'];

// Official MTA line colors, for the line bullets.
export const ROUTE_COLORS = {
  1: '#EE352E', 2: '#EE352E', 3: '#EE352E', 4: '#00933C', 5: '#00933C', 6: '#00933C', 7: '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6', B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45', J: '#996633', Z: '#996633', L: '#A7A9AC', N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  S: '#808183', SIR: '#0039A6',
};

export const KINDS = ['landmark', 'station', 'art', 'pops', 'bridge'];
const KIND_LISTS = { landmark: 'landmarks', station: 'stations', art: 'art', pops: 'pops', bridge: 'bridges' };

const pointInRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export class Places {
  constructor(data) {
    this.project = makeProjector(40.7);
    this.items = [];
    for (const [id, name, address, designated, hood, flats] of data.landmarks) {
      // One or more outlines (a designation can cover several lots), as [lat, lon].
      const outlines = flats.map((flat) => {
        const o = [];
        for (let i = 0; i < flat.length; i += 2) o.push([flat[i + 1], flat[i]]);
        return o;
      });
      const all = outlines.flat();
      const lat = all.reduce((s, p) => s + p[0], 0) / all.length;
      const lon = all.reduce((s, p) => s + p[1], 0) / all.length;
      this.items.push({ key: `L:${id}`, kind: 'landmark', id, name, address, designated, hood, lat, lon, latlngs: all,
        shapes: outlines.map((o) => o.map((p) => this.project(p))), radius: LANDMARK_RADIUS });
    }
    for (const [id, name, routes, borough, hood, flat] of data.stations) {
      const platforms = [];
      for (let i = 0; i < flat.length; i += 2) platforms.push([flat[i], flat[i + 1]]);
      const lat = platforms.reduce((s, p) => s + p[0], 0) / platforms.length;
      const lon = platforms.reduce((s, p) => s + p[1], 0) / platforms.length;
      // Where to draw it: each platform, merging ones within ~50 m of each other.
      const spots = [];
      for (const p of platforms) if (!spots.some((q) => Math.abs(q[0] - p[0]) < 0.00045 && Math.abs(q[1] - p[1]) < 0.0006)) spots.push(p);
      this.items.push({ key: `S:${id}`, kind: 'station', id, name, routes, borough, hood, lat, lon, latlngs: platforms, spots,
        points: platforms.map((p) => this.project(p)), radius: STATION_RADIUS });
    }
    // Privately owned public spaces (plazas, arcades) and public art: a point each.
    for (const [id, name, address, type, year, hood, lat, lon] of data.pops || []) {
      this.items.push({ key: `P:${id}`, kind: 'pops', id, name, address, type, year, hood, lat, lon, latlngs: [[lat, lon]],
        points: [this.project([lat, lon])], radius: POPS_RADIUS });
    }
    for (const [id, name, artist, year, type, address, hood, lat, lon] of data.art || []) {
      this.items.push({ key: `A:${id}`, kind: 'art', id, name, artist, year, type, address, hood, lat, lon, latlngs: [[lat, lon]],
        points: [this.project([lat, lon])], radius: ART_RADIUS });
    }
    // Bridges: walked across once most of their length is walked (on one walk or several).
    for (const [id, name, length, hood, flats] of data.bridges || []) {
      const pieces = flats.map((flat) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; });
      const samples = [];
      for (const piece of pieces) {
        for (let i = 1; i < piece.length; i++) {
          const n = Math.max(1, Math.round(haversine(piece[i - 1], piece[i]) / BRIDGE_STEP));
          for (let k = i === 1 ? 0 : 1; k <= n; k++) {
            const t = k / n;
            samples.push([piece[i - 1][0] + (piece[i][0] - piece[i - 1][0]) * t, piece[i - 1][1] + (piece[i][1] - piece[i - 1][1]) * t]);
          }
        }
      }
      const longest = pieces.reduce((a, b) => (b.length > a.length ? b : a));
      const [lat, lon] = longest[Math.floor(longest.length / 2)];
      this.items.push({ key: `B:${id}`, kind: 'bridge', id, name, length, hood, lat, lon, latlngs: samples, pieces,
        samples: samples.map((p) => this.project(p)), need: Math.ceil(BRIDGE_SHARE * samples.length), radius: BRIDGE_NEAR });
    }
    this.items.forEach((item, i) => { item.index = i; });
    this.byKey = new Map(this.items.map((item) => [item.key, item]));
    for (const kind of KINDS) this[KIND_LISTS[kind]] = this.items.filter((i) => i.kind === kind);

    // Grid: each item in every cell its catch area touches. Bridges are found
    // through their spots instead (sampleGrid).
    this.grid = new Map();
    this.sampleGrid = new Map();
    const pad = (BRIDGE_NEAR / 111000) * 1.4;
    for (const b of this.bridges) {
      b.latlngs.forEach((p, si) => {
        const keys = new Set();
        for (const dx of [-pad, pad]) for (const dy of [-pad, pad]) keys.add(`${Math.floor((p[1] + dx) / CELL)},${Math.floor((p[0] + dy) / CELL)}`);
        for (const k of keys) {
          if (!this.sampleGrid.has(k)) this.sampleGrid.set(k, []);
          this.sampleGrid.get(k).push([b, si]);
        }
      });
    }
    for (const item of this.items) {
      if (item.kind === 'bridge') continue;
      const pts = item.latlngs;
      const pad = item.radius / 111000 + CELL / 4;
      const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
      for (let cx = Math.floor((Math.min(...lons) - pad) / CELL); cx <= Math.floor((Math.max(...lons) + pad) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(...lats) - pad) / CELL); cy <= Math.floor((Math.max(...lats) + pad) / CELL); cy++) {
          const k = `${cx},${cy}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(item);
        }
      }
    }
  }

  // Items whose catch area contains this point ([lat, lon]).
  near(p) {
    const list = this.grid.get(`${Math.floor(p[1] / CELL)},${Math.floor(p[0] / CELL)}`);
    if (!list) return [];
    const [x, y] = this.project(p);
    return list.filter((item) => {
      if (item.points) {
        return item.points.some(([px, py]) => Math.hypot(px - x, py - y) <= item.radius);
      }
      return item.shapes.some((s) => {
        if (pointInRing(x, y, s)) return true;
        for (let i = 1; i < s.length; i++) if (pointSegDist([x, y], s[i - 1], s[i]) <= item.radius) return true;
        return false;
      });
    });
  }

  // Places passed between two GPS points (checked every ~15 m along the way).
  // Jumps over 150 m are GPS gaps and aren't filled in.
  passed(a, b) {
    const d = haversine(a, b);
    if (d > 150) return this.near(b);
    const steps = Math.max(1, Math.ceil(d / 15));
    const found = new Set();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      for (const item of this.near([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) found.add(item);
    }
    return [...found];
  }

  // Bridges walked across between two GPS points. `cover` (Map key -> Set of
  // spot numbers) remembers what's been walked so far, across walks; returns
  // the bridges that just reached BRIDGE_SHARE.
  crossed(a, b, cover) {
    if (!this.bridges.length) return [];
    const d = haversine(a, b);
    if (d > 150) return []; // a GPS gap, not a walk across
    const steps = Math.max(1, Math.ceil(d / 8));
    const done = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const list = this.sampleGrid.get(`${Math.floor(p[1] / CELL)},${Math.floor(p[0] / CELL)}`);
      if (!list) continue;
      const [x, y] = this.project(p);
      for (const [bridge, si] of list) {
        const [sx, sy] = bridge.samples[si];
        if (Math.hypot(sx - x, sy - y) > BRIDGE_NEAR) continue;
        let set = cover.get(bridge.key);
        if (!set) cover.set(bridge.key, (set = new Set()));
        if (set.has(si)) continue;
        set.add(si);
        if (set.size === bridge.need) done.push(bridge);
      }
    }
    return done;
  }

  // First time each place was visited: Map key -> time (ms). The returned map
  // also carries `cover`, how much of each bridge is walked, so a live walk
  // can carry on from there (see crossed()).
  visits(tracks) {
    const seen = new Map();
    const cover = new Map();
    for (const t of [...tracks].sort((x, y) => x.startedAt - y.startedAt)) {
      const pts = t.points;
      if (pts.length === 1) for (const item of this.near(pts[0])) if (!seen.has(item.key)) seen.set(item.key, pts[0][2] || t.startedAt);
      const breaks = new Set(t.breaks || []);
      for (let i = 1; i < pts.length; i++) {
        if (breaks.has(i)) continue; // a gap (e.g. a no-tracking area): don't join across it
        const time = pts[i][2] || t.startedAt;
        for (const item of this.passed(pts[i - 1], pts[i])) if (!seen.has(item.key)) seen.set(item.key, time);
        for (const item of this.crossed(pts[i - 1], pts[i], cover)) if (!seen.has(item.key)) seen.set(item.key, time);
      }
    }
    seen.cover = cover;
    return seen;
  }

  // How much of a bridge is walked, 0..1 (1 = counts as crossed).
  bridgeShare(item, cover) {
    return Math.min(1, (cover?.get(item.key)?.size || 0) / item.need);
  }

  // Per subway line: { route, total, visited }, in MTA order.
  lineProgress(visits) {
    const lines = new Map();
    for (const s of this.stations) {
      for (const r of s.routes) {
        const l = lines.get(r) || { route: r, total: 0, visited: 0 };
        l.total++;
        if (visits.has(s.key)) l.visited++;
        lines.set(r, l);
      }
    }
    return ROUTE_ORDER.filter((r) => lines.has(r)).map((r) => lines.get(r));
  }
}
