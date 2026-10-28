// Helpers for build_city.mjs: neighborhood geometry and packing blocks into
// per-neighborhood files. Uses the app's own block splitting from js/geo.js so
// blocks are cut the same way everywhere.
import { buildBlocks, midpoint, polylineLength, pointInMultiPolygon } from '../js/geo.js';

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

// raw: { nodes: [[id, lat, lon]], ways: [[id, [ids], name, highway]] } from extract_streets.py
// hoodsGeo: the NTA GeoJSON from scripts/data
export function buildCity(raw, hoodsGeo, { outlineTolerance = 0.0001 } = {}) {
  const elements = [];
  for (const [id, lat, lon] of raw.nodes) elements.push({ type: 'node', id, lat, lon });
  for (const [id, nodes, name, highway] of raw.ways) elements.push({ type: 'way', id, nodes, tags: { name, highway } });
  const blocks = buildBlocks({ elements });

  const hoods = hoodsGeo.features.map((f) => ({
    ...f.properties,
    multi: f.geometry.coordinates,
    bbox: bboxOf(f.geometry.coordinates),
    blocks: [],
  }));

  let outside = 0;
  for (const b of blocks) {
    const mid = midpoint(b.coords);
    const hood = hoods.find((h) => {
      const [s, w, n, e] = h.bbox;
      return mid[0] >= s && mid[0] <= n && mid[1] >= w && mid[1] <= e && pointInMultiPolygon(mid, h.multi);
    });
    if (hood) hood.blocks.push(b);
    else outside++; // New Jersey, Westchester, water
  }

  const used = hoods.filter((h) => h.blocks.length);
  // Blocks are filed by their midpoint, so edge blocks can stick out past the
  // outline. Grow each box to cover its blocks completely.
  for (const h of used) {
    for (const b of h.blocks) for (const [la, lo] of b.coords) {
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
    files[h.id] = { id: h.id, names, blocks: packed };
  });

  const index = {
    version: 2,
    built: new Date().toISOString().slice(0, 10),
    attribution: 'Streets © OpenStreetMap contributors (ODbL). Neighborhoods: NYC Department of City Planning, 2020 NTAs.',
    total: {
      blocks: used.reduce((n, h) => n + h.blocks.length, 0),
      length: Math.round(used.reduce((n, h) => n + h.blocks.reduce((m, b) => m + b.length, 0), 0)),
    },
    hoods: used.map((h) => ({
      id: h.id,
      name: h.name,
      borough: h.borough,
      type: h.type,
      bbox: h.bbox.map((x) => round(x, 5)),
      blocks: h.blocks.length,
      length: Math.round(h.blocks.reduce((m, b) => m + b.length, 0)),
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

  return { index, files, outlines, streets: streetList, outside, totalBlocks: blocks.length };
}

export { polylineLength };
