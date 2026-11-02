// Helpers for build_city.mjs: neighborhood geometry and packing blocks into
// per-neighborhood files. Uses the app's own block splitting from js/geo.js so
// blocks are cut the same way everywhere.
import { buildBlocks, makeProjector, midpoint, pointSegDist, polylineLength, pointInMultiPolygon, sampleAlong } from '../js/geo.js';

export { pointInMultiPolygon };

export function bboxOf(multi) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const polygon of multi) for (const ring of polygon) for (const [lon, lat] of ring) {
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  return [s, w, n, e];
}

// Douglas-Peucker on a [lon, lat] ring, tolerance in degrees.
export function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, farDist = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > farDist) { far = i; farDist = d; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// Paths that mostly run right beside a street (sidewalks nobody tagged as
// sidewalks, paths along building fronts) add nothing: walking them already
// counts for the street. Returns a test for a path's coordinates.
const ALONGSIDE = 15; // meters from a street's centerline
const ALONGSIDE_SHARE = 0.6; // share of a path's length that close to streets
export function alongStreets(streetBlocks) {
  const project = makeProjector(40.7);
  const cell = 60;
  const grid = new Map();
  for (const b of streetBlocks) {
    const pts = b.coords.map(project);
    for (let i = 1; i < pts.length; i++) {
      const [a, c] = [pts[i - 1], pts[i]];
      const x0 = Math.floor((Math.min(a[0], c[0]) - ALONGSIDE) / cell), x1 = Math.floor((Math.max(a[0], c[0]) + ALONGSIDE) / cell);
      const y0 = Math.floor((Math.min(a[1], c[1]) - ALONGSIDE) / cell), y1 = Math.floor((Math.max(a[1], c[1]) + ALONGSIDE) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x * 100003 + y;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(a, c);
      }
    }
  }
  return (coords) => {
    const samples = sampleAlong(coords, 10).map(project);
    let near = 0;
    for (const p of samples) {
      const list = grid.get(Math.floor(p[0] / cell) * 100003 + Math.floor(p[1] / cell)) || [];
      for (let i = 0; i < list.length; i += 2) {
        if (pointSegDist(p, list[i], list[i + 1]) <= ALONGSIDE) { near++; break; }
      }
    }
    return near >= ALONGSIDE_SHARE * samples.length;
  };
}

// Footpaths, trails, greenways and named plazas, cut into pieces like blocks.
export function buildPaths(raw, streetBlocks) {
  if (!raw.paths?.length) return [];
  const elements = [];
  const used = new Set();
  for (const [, nodes, name, kind] of raw.paths) {
    if (kind === 'plaza' && !name) continue; // unnamed ones are mostly wide sidewalks
    for (const id of nodes) used.add(id);
  }
  for (const [id, lat, lon] of raw.nodes) if (used.has(id)) elements.push({ type: 'node', id, lat, lon });
  for (const [id, nodes, name, kind] of raw.paths) {
    if (kind === 'plaza' && !name) continue;
    elements.push({ type: 'way', id, nodes, tags: { name, highway: kind } });
  }
  const beside = alongStreets(streetBlocks);
  return buildBlocks({ elements }, { minLength: 20 }).filter((p) => p.highway === 'plaza' || !beside(p.coords));
}

// raw: { nodes: [[id, lat, lon]], ways: [[id, [ids], name, highway]] } from extract_streets.py
// hoodsGeo: the NTA GeoJSON from scripts/data
export function buildCity(raw, hoodsGeo, { outlineTolerance = 0.0001 } = {}) {
  const elements = [];
  for (const [id, lat, lon] of raw.nodes) elements.push({ type: 'node', id, lat, lon });
  for (const [id, nodes, name, highway] of raw.ways) elements.push({ type: 'way', id, nodes, tags: { name, highway } });
  const blocks = buildBlocks({ elements });
  const paths = buildPaths(raw, blocks);

  const hoods = hoodsGeo.features.map((f) => ({
    ...f.properties,
    multi: f.geometry.coordinates,
    bbox: bboxOf(f.geometry.coordinates),
    blocks: [],
    paths: [],
  }));
  const hoodAt = (coords) => {
    const mid = midpoint(coords);
    return hoods.find((h) => {
      const [s, w, n, e] = h.bbox;
      return mid[0] >= s && mid[0] <= n && mid[1] >= w && mid[1] <= e && pointInMultiPolygon(mid, h.multi);
    });
  };

  let outside = 0;
  for (const b of blocks) {
    const hood = hoodAt(b.coords);
    if (hood) hood.blocks.push(b);
    else outside++; // New Jersey, Westchester, water
  }
  for (const p of paths) hoodAt(p.coords)?.paths.push(p);

  // Paths only count where there are streets (not Rikers or Hart Island).
  const used = hoods.filter((h) => h.blocks.length);
  // Blocks are filed by their midpoint, so edge blocks can stick out past the
  // outline. Grow each box to cover its blocks completely.
  for (const h of used) {
    for (const b of [...h.blocks, ...h.paths]) for (const [la, lo] of b.coords) {
      h.bbox = [Math.min(h.bbox[0], la), Math.min(h.bbox[1], lo), Math.max(h.bbox[2], la), Math.max(h.bbox[3], lo)];
    }
  }
  const files = {};
  const streets = new Map();
  used.forEach((h, hi) => {
    const names = [];
    const nameIdx = new Map();
    const packed = h.blocks.map((b) => {
      let ni = -1;
      if (b.name) {
        if (!nameIdx.has(b.name)) { nameIdx.set(b.name, names.length); names.push(b.name); }
        ni = nameIdx.get(b.name);
        const key = `${b.name}|${h.borough}`;
        const st = streets.get(key) || { name: b.name, borough: h.borough, blocks: 0, length: 0, hoods: new Set() };
        st.blocks++;
        st.hoods.add(hi);
        st.length += b.length;
        streets.set(key, st);
      }
      return [b.id, ni, b.coords.flatMap(([la, lo]) => [round(la, 6), round(lo, 6)])];
    });
    // Paths: [id, name index, flat coords, 1 if a plaza]. Not in street counts.
    const pathsPacked = h.paths.map((p) => {
      let ni = -1;
      if (p.name) {
        if (!nameIdx.has(p.name)) { nameIdx.set(p.name, names.length); names.push(p.name); }
        ni = nameIdx.get(p.name);
      }
      return [p.id, ni, p.coords.flatMap(([la, lo]) => [round(la, 6), round(lo, 6)]), p.highway === 'plaza' ? 1 : 0];
    });
    files[h.id] = { id: h.id, names, blocks: packed, paths: pathsPacked };
  });

  const index = {
    version: 2,
    built: new Date().toISOString().slice(0, 10),
    // Changes with every build; the app adds it to data URLs so a new build
    // is never hidden behind a cached copy of the old one.
    rev: Date.now().toString(36),
    attribution: 'Streets © OpenStreetMap contributors (ODbL). Neighborhoods: NYC Department of City Planning, 2020 NTAs.',
    total: {
      blocks: used.reduce((n, h) => n + h.blocks.length, 0),
      length: Math.round(used.reduce((n, h) => n + h.blocks.reduce((m, b) => m + b.length, 0), 0)),
      paths: used.reduce((n, h) => n + h.paths.length, 0),
      pathLength: Math.round(used.reduce((n, h) => n + h.paths.reduce((m, b) => m + b.length, 0), 0)),
    },
    hoods: used.map((h) => ({
      id: h.id,
      name: h.name,
      borough: h.borough,
      type: h.type,
      bbox: h.bbox.map((x) => round(x, 5)),
      blocks: h.blocks.length,
      length: Math.round(h.blocks.reduce((m, b) => m + b.length, 0)),
      paths: h.paths.length,
      pathLength: Math.round(h.paths.reduce((m, b) => m + b.length, 0)),
    })),
  };

  // Simplified outlines for drawing on the map. Feature ids match index.hoods order.
  const outlines = {
    type: 'FeatureCollection',
    features: used.map((h, i) => ({
      type: 'Feature',
      id: i,
      properties: { id: h.id },
      geometry: {
        type: 'MultiPolygon',
        coordinates: h.multi.map((poly) => poly.map((ring) => simplifyRing(ring, outlineTolerance).map(([x, y]) => [round(x, 5), round(y, 5)]))),
      },
    })),
  };

  const streetList = [...streets.values()]
    // [name, borough, blocks, meters, [neighborhood indexes]]
    .map((s) => [s.name, s.borough, s.blocks, Math.round(s.length), [...s.hoods]])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  return { index, files, outlines, streets: streetList, outside, totalBlocks: blocks.length, totalPaths: paths.length, hoods: used };
}

export { polylineLength };

// ---- Landmarks and subway stations ------------------------------------------

// Lines in the order the MTA lists them.
export const ROUTE_ORDER = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'SIR'];

const centroid = (ring) => {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [y / ring.length, x / ring.length];
};

// landmarksData / stationsData: scripts/data/nyc-landmarks.json and nyc-subway-stations.json.
// hoods: the neighborhoods that made it into index.json, in order, each with .multi and .bbox.
// Output (compact arrays, read by js/places.js):
//   landmarks: [id, name, address, designated, hoodIndex, [[lon, lat, lon, lat, ...outline], ...]]
//   stations:  [complexId, name, [routes], borough, hoodIndex, [lat, lon, ...platforms]]
export function buildPlaces(landmarksData, stationsData, hoods) {
  const hoodAt = (pt) => hoods.findIndex((h) => {
    const [s, w, n, e] = h.bbox;
    return pt[0] >= s && pt[0] <= n && pt[1] >= w && pt[1] <= e && pointInMultiPolygon(pt, h.multi);
  });
  const landmarks = landmarksData.landmarks.map((l) => [
    l.id, l.name, l.address, l.designated, hoodAt(centroid(l.outlines.flat())), l.outlines.map((o) => o.flat()),
  ]);

  const complexes = new Map();
  for (const s of stationsData.stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const c = complexes.get(s.complex) || { id: s.complex, names: [], routes: new Set(), borough: s.borough, points: [] };
    c.names.push(s.name);
    s.routes.forEach((r) => c.routes.add(r));
    c.points.push([s.lat, s.lon]);
    complexes.set(s.complex, c);
  }
  const stations = [...complexes.values()].map((c) => {
    // A complex is named after its most common platform name (e.g. "Times Sq-42 St").
    const counts = new Map();
    c.names.forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
    const name = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const routes = [...c.routes].sort((a, b) => ROUTE_ORDER.indexOf(a) - ROUTE_ORDER.indexOf(b));
    const lat = c.points.reduce((s, p) => s + p[0], 0) / c.points.length;
    const lon = c.points.reduce((s, p) => s + p[1], 0) / c.points.length;
    return [c.id, name, routes, c.borough, hoodAt([lat, lon]), c.points.flat()];
  });
  return { version: 1, landmarks, stations };
}
