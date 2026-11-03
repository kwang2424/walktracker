// Map matching: which streets and paths a walk actually followed.
//
// Plain "within 25 m of the GPS line" also credits a parallel street 20 m away,
// or a side street the line brushes past. The standard fix (Newson & Krumm,
// "Hidden Markov Map Matching Through Noise and Sparseness", 2009; used by OSRM
// and Valhalla) treats it as a puzzle over the whole walk: each GPS point could
// be on any nearby street (likelier the closer it is), and moving from one point
// to the next is likelier when the walking distance along the street network
// matches the straight-line distance. The Viterbi algorithm picks the most
// likely sequence of streets.
//
// The result says, for each stretch of the walk, which blocks it may cover, and
// which blocks to fill in where the GPS skipped (e.g. it cut a corner).
import { haversine, makeProjector } from './geo.js';

const RADIUS = 35; // m: streets further than this from a point aren't candidates
const MAX_CANDIDATES = 5;
const SIGMA = 10; // m: typical GPS error after smoothing
const BETA = 12; // m: how much detour between two points is still normal
const STEP_M = 12; // use a point about every this many meters
const BREAK_GAP_M = 250; // start a new chain after a gap this long...
const BREAK_GAP_MS = 90000; // ...or this many seconds
const JUMP_PENALTY = 1.6; // off-network moves (data gaps, plazas) cost this much more
const CELL = 50; // m, spatial grid
const MAX_SPEED = 7; // m/s: faster stretches (a ride) count for nothing

const nodesOf = (id) => id.split(':')[1].split('-');

export class StreetGraph {
  constructor() {
    this.project = makeProjector(40.7);
    this.edges = new Map(); // id -> { id, name, len, pts: [[x, y]], cum: [m], from, to }
    this.adj = new Map(); // node id -> [{ edge, atStart }]
    this.grid = new Map();
  }

  // blocks/paths as loaded by City: { id, name, coords: [[lat, lon]] }.
  add(blocks, { path = false } = {}) {
    for (const b of blocks) {
      if (this.edges.has(b.id)) continue;
      const pts = b.coords.map(this.project);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const [from, to] = nodesOf(b.id);
      const e = { id: b.id, name: b.name || '', len: cum[cum.length - 1], pts, cum, from, to, coords: b.coords, path };
      this.edges.set(b.id, e);
      for (const [node, atStart] of [[from, true], [to, false]]) {
        if (!this.adj.has(node)) this.adj.set(node, []);
        this.adj.get(node).push({ edge: e, atStart });
      }
      for (let i = 1; i < pts.length; i++) {
        const [a, c] = [pts[i - 1], pts[i]];
        for (let x = Math.floor((Math.min(a[0], c[0]) - RADIUS) / CELL); x <= Math.floor((Math.max(a[0], c[0]) + RADIUS) / CELL); x++) {
          for (let y = Math.floor((Math.min(a[1], c[1]) - RADIUS) / CELL); y <= Math.floor((Math.max(a[1], c[1]) + RADIUS) / CELL); y++) {
            const key = x * 100003 + y;
            let list = this.grid.get(key);
            if (!list) this.grid.set(key, (list = []));
            list.push(e, i);
          }
        }
      }
    }
  }

  // Nearby streets for a point: [{ edge, along, dist }], closest first.
  candidates(latlon) {
    const p = this.project(latlon);
    const best = new Map();
    for (let k = 0, list = this.grid.get(Math.floor(p[0] / CELL) * 100003 + Math.floor(p[1] / CELL)) || []; k < list.length; k += 2) {
      const e = list[k], i = list[k + 1];
      const a = e.pts[i - 1], b = e.pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      const dist = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
      if (dist > RADIUS) continue;
      const prev = best.get(e.id);
      if (!prev || dist < prev.dist) best.set(e.id, { edge: e, along: e.cum[i - 1] + t * Math.sqrt(l2), dist });
    }
    return [...best.values()].sort((x, y) => x.dist - y.dist).slice(0, MAX_CANDIDATES);
  }

  // Shortest walk along the network from candidate c1 to each of `targets`,
  // up to `limit` meters. Returns [{ dist, edges: [ids in between], exitAtEnd }]
  // per target (null if not reachable), where exitAtEnd says which end of c1's
  // edge the walk leaves by.
  routes(c1, targets, limit) {
    const out = targets.map((c2) => (c2.edge === c1.edge ? { dist: Math.abs(c2.along - c1.along), edges: [], same: true } : null));
    if (targets.every((c2) => c2.edge === c1.edge)) return out;
    // Dijkstra over nodes, starting from both ends of c1's edge.
    const dist = new Map(), prev = new Map();
    const heap = [];
    const push = (node, d, from) => {
      if (d > limit || (dist.has(node) && dist.get(node) <= d)) return;
      dist.set(node, d); prev.set(node, from);
      heap.push([d, node]);
    };
    push(c1.edge.from, c1.along, { edge: null, exitAtEnd: false });
    push(c1.edge.to, c1.edge.len - c1.along, { edge: null, exitAtEnd: true });
    const done = new Set();
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [d, node] = heap.splice(bi, 1)[0];
      if (done.has(node) || d > dist.get(node)) continue;
      done.add(node);
      for (const { edge, atStart } of this.adj.get(node) || []) {
        if (edge === c1.edge) continue;
        push(atStart ? edge.to : edge.from, d + edge.len, { edge, node });
      }
    }
    const pathTo = (node) => {
      const edges = [];
      let p = prev.get(node);
      while (p && p.edge) { edges.unshift(p.edge.id); p = prev.get(p.node); }
      return { edges, exitAtEnd: p?.exitAtEnd };
    };
    targets.forEach((c2, j) => {
      if (out[j]) return;
      let bestD = Infinity, bestNode = null, enterAtStart = true;
      for (const [node, extra, atStart] of [[c2.edge.from, c2.along, true], [c2.edge.to, c2.edge.len - c2.along, false]]) {
        if (dist.has(node) && dist.get(node) + extra < bestD) { bestD = dist.get(node) + extra; bestNode = node; enterAtStart = atStart; }
      }
      if (bestNode != null && bestD <= limit) out[j] = { dist: bestD, ...pathTo(bestNode), enterAtStart };
    });
    return out;
  }
}

// points: [[lat, lon, t]]. Returns steps: [{ a, b, allow: { ids, names }, fills: [{ id, m0, m1 }] }]
// covering point indexes a..b, or [] where nothing matched (off the network).
export function matchWalk(graph, points, breaks = []) {
  const brk = [...breaks].sort((a, b) => a - b);
  const breakBetween = (i, j) => brk.some((b) => b > i && b <= j);
  // Thin the walk to a point every ~STEP_M meters (keeping indexes).
  const keep = [];
  for (let i = 0; i < points.length; i++) {
    if (!keep.length || i === points.length - 1 || haversine(points[keep[keep.length - 1]], points[i]) >= STEP_M) keep.push(i);
  }
  const steps = [];
  let chain = [];
  const flush = () => {
    if (chain.length) steps.push(...decode(graph, points, chain));
    chain = [];
  };
  for (const i of keep) {
    const cands = graph.candidates(points[i]);
    const last = chain[chain.length - 1];
    const gap = last && (haversine(points[last.i], points[i]) > BREAK_GAP_M || points[i][2] - points[last.i][2] > BREAK_GAP_MS
      || breakBetween(last.i, i));
    if (!cands.length || gap) flush();
    if (cands.length) chain.push({ i, cands });
  }
  flush();
  return steps;
}

// Viterbi over one unbroken chain of points.
function decode(graph, points, chain) {
  const emit = (c) => -0.5 * (c.dist / SIGMA) ** 2;
  let score = chain[0].cands.map(emit);
  const back = [];
  const routeOf = []; // routeOf[k][j][i]: route from chain[k-1] cand i to chain[k] cand j
  for (let k = 1; k < chain.length; k++) {
    const prevC = chain[k - 1].cands, cur = chain[k].cands;
    const straight = haversine(points[chain[k - 1].i], points[chain[k].i]);
    const limit = straight * 2 + 60;
    const routes = prevC.map((c1) => graph.routes(c1, cur, limit));
    const next = [], bp = [], rk = [];
    cur.forEach((c2, j) => {
      let best = -Infinity, bi = 0;
      prevC.forEach((c1, i) => {
        const r = routes[i][j];
        const d = r ? r.dist : straight * JUMP_PENALTY + 25;
        const s = score[i] - Math.abs(d - straight) / BETA + emit(c2);
        if (s > best) { best = s; bi = i; }
      });
      next.push(best); bp.push(bi); rk.push(routes.map((r) => r[j]));
    });
    score = next; back.push(bp); routeOf.push(rk);
  }
  // Backtrack.
  let j = score.indexOf(Math.max(...score));
  const picks = [j];
  for (let k = back.length - 1; k >= 0; k--) { j = back[k][j]; picks.unshift(j); }

  const steps = [];
  if (chain.length === 1) {
    const c = chain[0].cands[picks[0]];
    return [{ a: chain[0].i, b: chain[0].i, allow: allowOf([c.edge]), fills: [{ id: c.edge.id, m0: c.along - 5, m1: c.along + 5 }] }];
  }
  for (let k = 1; k < chain.length; k++) {
    const pa = points[chain[k - 1].i], pb = points[chain[k].i];
    const secs = pa[2] != null && pb[2] != null ? (pb[2] - pa[2]) / 1000 : 0;
    if (secs > 0 && haversine(pa, pb) / secs > MAX_SPEED) continue;
    const c1 = chain[k - 1].cands[picks[k - 1]], c2 = chain[k].cands[picks[k]];
    const r = routeOf[k - 1][picks[k]][picks[k - 1]];
    const between = (r?.edges || []).map((id) => graph.edges.get(id));
    const fills = [];
    if (r?.same) fills.push({ id: c1.edge.id, m0: c1.along, m1: c2.along });
    else if (r) {
      // Off the end of c1's block, through any blocks in between, onto c2's.
      fills.push({ id: c1.edge.id, m0: c1.along, m1: r.exitAtEnd ? c1.edge.len : 0 });
      for (const e of between) fills.push({ id: e.id, m0: 0, m1: e.len });
      fills.push({ id: c2.edge.id, m0: r.enterAtStart ? 0 : c2.edge.len, m1: c2.along });
    }
    // An off-network move (no route) fills nothing: the GPS line alone counts.
    steps.push({ a: chain[k - 1].i, b: chain[k].i, allow: allowOf([c1.edge, ...between, c2.edge]), fills });
  }
  return steps;
}

// Blocks a stretch may cover: the matched ones, plus same-named blocks (the far
// side of a divided avenue is a separate line in the map data).
function allowOf(edges) {
  return { ids: new Set(edges.map((e) => e.id)), names: new Set(edges.map((e) => e.name).filter(Boolean)) };
}
