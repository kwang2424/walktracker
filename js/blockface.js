// The city block around a point: the smallest ring of streets that encloses it,
// traced on the street network (blocks are cut at every intersection, so the
// streets form a planar graph and each city block is one of its faces).
// Used to make a no-tracking area exactly one block.
import { pointInMultiPolygon } from './geo.js';

const MAX_EDGES = 60; // a block's outline has far fewer streets than this
const MAX_AREA = 400000; // m²: bigger "blocks" are parks or the outside of the grid

// graph: a StreetGraph (js/match.js). Returns the outline as [[lat, lon]], or null.
export function blockAround(graph, latlon) {
  const p = graph.project(latlon);
  // Departures from each node: [{ edge, forward, angle }], streets only.
  const out = new Map();
  const angleOf = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  for (const e of graph.edges.values()) {
    if (e.path || e.pts.length < 2 || e.from === e.to) continue;
    const n = e.pts.length;
    add(out, e.from, { edge: e, forward: true, angle: angleOf(e.pts[0], e.pts[1]) });
    add(out, e.to, { edge: e, forward: false, angle: angleOf(e.pts[n - 1], e.pts[n - 2]) });
  }
  // Start from the streets nearest the point (any distance), in both directions.
  const near = [];
  for (const e of graph.edges.values()) {
    if (e.path) continue;
    let d = Infinity;
    for (let i = 1; i < e.pts.length; i++) d = Math.min(d, segDist(p, e.pts[i - 1], e.pts[i]));
    near.push({ edge: e, d });
  }
  near.sort((a, b) => a.d - b.d);
  near.length = Math.min(near.length, 4);
  let best = null;
  for (const c of near) {
    for (const forward of [true, false]) {
      const ring = trace(out, { edge: c.edge, forward });
      if (!ring) continue;
      const xy = ring.map(graph.project);
      const area = Math.abs(signedArea(xy));
      if (area > MAX_AREA || area < 50) continue;
      if (!pointInMultiPolygon(latlon, [[ring.map(([la, lo]) => [lo, la])]])) continue;
      if (!best || area < best.area) best = { ring, area };
    }
  }
  return best ? best.ring : null;
  function add(map, node, dep) {
    if (!map.has(node)) map.set(node, []);
    map.get(node).push(dep);
  }
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// Walk around a face keeping it on the left: at each corner take the sharpest
// left turn. Returns the outline, or null if it doesn't close in time.
function trace(out, start) {
  const ring = [];
  let cur = start;
  for (let steps = 0; steps < MAX_EDGES; steps++) {
    const { edge, forward } = cur;
    const coords = forward ? edge.coords : [...edge.coords].reverse();
    ring.push(...(ring.length ? coords.slice(1) : coords));
    const node = forward ? edge.to : edge.from;
    const deps = out.get(node) || [];
    // Direction back along the street we came in on.
    const pts = forward ? edge.pts : [...edge.pts].reverse();
    const m = pts.length;
    const back = Math.atan2(pts[m - 2][1] - pts[m - 1][1], pts[m - 2][0] - pts[m - 1][0]);
    // Sharpest left = smallest clockwise turn from the way back.
    let next = null, bestTurn = Infinity;
    for (const d of deps) {
      if (d.edge === edge && d.forward !== forward && deps.length > 1) continue; // not a U-turn unless a dead end
      let turn = back - d.angle;
      while (turn <= 0) turn += 2 * Math.PI;
      while (turn > 2 * Math.PI) turn -= 2 * Math.PI;
      if (turn < bestTurn) { bestTurn = turn; next = d; }
    }
    if (!next) return null;
    if (next.edge === start.edge && next.forward === start.forward) return ring;
    cur = next;
  }
  return null;
}

function signedArea(xy) {
  let a = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) a += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
  return a / 2;
}
