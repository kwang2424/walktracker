// All of NYC, split into its official neighborhoods (built by scripts/build_city.mjs).
// Only the neighborhoods you look at or have walked in are loaded, each with its
// own coverage engine, so the phone never has to hold all 100,000+ blocks.
// No DOM here; fetching is passed in so this runs in Node tests too.
import { CoverageEngine, polylineLength } from './geo.js';
import { replayTracks } from './stats.js';

export const CITY_BASE = 'data/nyc/';
const PAD = 0.0005; // ~50 m: a GPS point this close to a neighborhood can still cover its edge blocks

const intersects = ([s, w, n, e], [S, W, N, E], pad = 0) => s <= N + pad && n >= S - pad && w <= E + pad && e >= W - pad;

export function bboxOfPoints(points) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of points) {
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
  }
  return [s, w, n, e];
}

// Overrides are stored as { walked, hood }; very old ones were plain booleans.
export const overrideWalked = (v) => (typeof v === 'object' && v ? !!v.walked : !!v);

export class City {
  constructor({ base = CITY_BASE, fetchImpl = (u) => fetch(u), engineOpts = {}, onLoad } = {}) {
    this.base = base;
    this.fetch = fetchImpl;
    this.engineOpts = engineOpts;
    this.onLoad = onLoad; // called with a neighborhood id after it loads
    this.loaded = new Map(); // hood id -> { meta, blocks, engine }
    this.pending = new Map(); // hood id -> Promise
    this.blockHood = new Map(); // block id -> hood id (loaded hoods only)
    this.tracks = [];
    this.live = null; // points of the walk being recorded
    this.completedAt = new Map();
    this.newByTrack = new Map();
  }

  async init() {
    const res = await this.fetch(this.base + 'index.json');
    if (!res.ok) throw new Error(`city index: HTTP ${res.status}`);
    this.index = await res.json();
    this.hoods = new Map(this.index.hoods.map((h, i) => [h.id, { ...h, idx: i }]));
    return this;
  }

  hoodsIn(bbox, pad = 0) {
    return this.index.hoods.filter((h) => intersects(bbox, h.bbox, pad)).map((h) => h.id);
  }

  // Load the given neighborhoods (if not already), in parallel.
  ensure(ids) {
    return Promise.all(ids.map((id) => this._load(id)));
  }

  _load(id) {
    if (this.loaded.has(id)) return Promise.resolve(this.loaded.get(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const p = (async () => {
      const res = await this.fetch(`${this.base}hoods/${id}.json`);
      if (!res.ok) throw new Error(`neighborhood ${id}: HTTP ${res.status}`);
      const file = await res.json();
      const meta = this.hoods.get(id);
      const blocks = file.blocks.map(([bid, ni, flat]) => {
        const coords = [];
        for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
        return { id: bid, name: ni >= 0 ? file.names[ni] : '', borough: meta.borough, hood: id, coords, length: polylineLength(coords) };
      });
      const entry = { meta, blocks, engine: new CoverageEngine(this.engineOpts) };
      for (const b of blocks) this.blockHood.set(b.id, id);
      this._replay(entry);
      this.loaded.set(id, entry);
      this.pending.delete(id);
      this.onLoad?.(id);
      return entry;
    })();
    p.catch(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  // Rebuild one neighborhood's coverage from all walks that pass near it.
  _replay(entry) {
    entry.engine.setBlocks(entry.blocks);
    const near = this.tracks.filter((t) => intersects(t.bbox || (t.bbox = bboxOfPoints(t.points)), entry.meta.bbox, PAD));
    const { completedAt, newByTrack } = replayTracks(entry.engine, near);
    for (const [bid, time] of completedAt) this.completedAt.set(bid, time);
    for (const [tid, n] of newByTrack) this.newByTrack.set(tid, (this.newByTrack.get(tid) || 0) + n);
    if (this.live?.length) entry.engine.addTrack(this.live);
  }

  // Replace the list of saved walks: recomputes every loaded neighborhood and
  // returns the neighborhoods those walks touch, so the caller can load them.
  setTracks(tracks) {
    this.tracks = tracks;
    this.completedAt = new Map();
    this.newByTrack = new Map();
    for (const entry of this.loaded.values()) this._replay(entry);
    const ids = new Set();
    for (const t of tracks) for (const id of this.hoodsIn(t.bbox || (t.bbox = bboxOfPoints(t.points)), PAD)) ids.add(id);
    return [...ids];
  }

  // The walk being recorded. Points are added with addLiveSegment.
  startLive(points) {
    this.live = points;
  }

  stopLive() {
    this.live = null;
  }

  // Apply one new GPS segment. Returns the block ids whose coverage changed.
  // Neighborhoods the segment touches that aren't loaded yet start loading,
  // and pick the segment up from `live` when they finish.
  addLiveSegment(a, b) {
    const box = bboxOfPoints([a, b]);
    const changed = new Set();
    for (const id of this.hoodsIn(box, PAD)) {
      const entry = this.loaded.get(id);
      if (entry) entry.engine.addSegment(a, b, changed);
      else this._load(id).catch(() => {});
    }
    return changed;
  }

  block(id) {
    const hood = this.blockHood.get(id);
    return hood ? this.loaded.get(hood).engine.blocks.get(id)?.block : undefined;
  }

  fraction(id) {
    const hood = this.blockHood.get(id);
    return hood ? this.loaded.get(hood).engine.fraction(id) : 0;
  }

  isWalked(id, overrides = {}) {
    if (id in overrides) return overrideWalked(overrides[id]);
    const hood = this.blockHood.get(id);
    return hood ? this.loaded.get(hood).engine.isWalked(id) : false;
  }

  // Progress for one neighborhood. Unloaded ones have nothing walked yet.
  hoodProgress(id, overrides = {}) {
    const meta = this.hoods.get(id);
    const entry = this.loaded.get(id);
    if (!entry) return { blocks: meta.blocks, length: meta.length, walked: 0, walkedLength: 0 };
    let walked = 0, walkedLength = 0;
    for (const b of entry.blocks) {
      if (this.isWalked(b.id, overrides)) { walked++; walkedLength += b.length; }
    }
    return { blocks: meta.blocks, length: meta.length, walked, walkedLength };
  }

  // NYC-wide, per-borough and per-neighborhood progress.
  summary(overrides = {}) {
    const hoods = this.index.hoods.map((h) => ({ ...h, ...this.hoodProgress(h.id, overrides) }));
    const boroughs = new Map();
    for (const h of hoods) {
      const b = boroughs.get(h.borough) || { name: h.borough, blocks: 0, length: 0, walked: 0, walkedLength: 0 };
      b.blocks += h.blocks; b.length += h.length; b.walked += h.walked; b.walkedLength += h.walkedLength;
      boroughs.set(h.borough, b);
    }
    const sum = (k) => hoods.reduce((n, h) => n + h[k], 0);
    return {
      blocks: this.index.total.blocks,
      length: this.index.total.length,
      walked: sum('walked'),
      walkedLength: sum('walkedLength'),
      hoods,
      boroughs: [...boroughs.values()],
    };
  }

  // Walked blocks and length per street (name + borough), from loaded neighborhoods.
  streetProgress(overrides = {}) {
    const out = new Map();
    for (const entry of this.loaded.values()) {
      for (const b of entry.blocks) {
        if (!b.name || !this.isWalked(b.id, overrides)) continue;
        const key = `${b.name}|${b.borough}`;
        const s = out.get(key) || { walked: 0, walkedLength: 0 };
        s.walked++;
        s.walkedLength += b.length;
        out.set(key, s);
      }
    }
    return out;
  }

  // All blocks of loaded neighborhoods, for drawing.
  loadedBlocks() {
    return [...this.loaded.values()].flatMap((e) => e.blocks);
  }
}
