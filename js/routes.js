// Walk suggestions: a loop (or a walk to somewhere) of about the time you have,
// over as many blocks you haven't walked as possible.
//
// This is the "orienteering problem" (collect the most prizes within a length
// budget), which has no fast exact answer. The approach, standard for it:
//   1. Prizes: each unwalked block is worth its length (park paths a bit less,
//      blocks finishing a nearly-done street a bit more); walked blocks are
//      worth nothing, and walking any block twice is wasted time.
//   2. Many randomized greedy walks from the start. Each step picks a next
//      block by its own prize, the prize waiting just beyond it, and a little
//      randomness; it never goes so far that the way back no longer fits the
//      budget, and heads home (shortest way) when the budget is nearly spent.
//   3. The best few are improved: detours around unwalked blocks are added
//      where the budget allows, and wasted out-and-back stretches are cut.
//   4. The best route wins: most new meters, least repetition, close to the
//      time asked for.
// Pure: no DOM. tests/sim/routes.bench.mjs measures how good the routes are.
import { haversine } from './geo.js';

const WALK_SPEED = 1.3; // m/s, an easy city pace (with crossings)
const PATH_WEIGHT = 0.35; // a meter of new park path, against a meter of new street
const FINISH_BONUS = 0.5; // extra per meter for blocks of a street with only a few left
const REPEAT_COST = 0.6; // a meter walked twice, against a meter of new street
const TRIES = 4000; // at most; the search also stops after `timeLimit` ms
const TIME_LIMIT_MS = 350; // a tap's worth of waiting, on a phone

// graph: a StreetGraph (js/match.js). opts:
//   start: [lat, lon]; to: [lat, lon] (optional, else a loop back to start)
//   minutes: walking time wanted
//   walked(id) -> true if that block or path counts as walked already
//   avoid(coords) -> true for blocks in a no-tracking area (no prize there)
//   nearlyDone(edge) -> true for blocks of a street with only a few left
//   seed: for repeatable results
// Returns { coords, edges, meters, newMeters, minutes } or null.
export function suggestRoute(graph, opts) {
  const { start, to = null, minutes, walked, avoid = () => false, nearlyDone = () => false, seed = 1,
    tries = TRIES, timeLimit = TIME_LIMIT_MS, polish = true, randomOnly = false } = opts; // tries, polish, randomOnly: for the benchmark's comparisons
  const budget = minutes * 60 * WALK_SPEED;
  const rand = rng(seed);
  const startNode = nearestNode(graph, start);
  const endNode = to ? nearestNode(graph, to) : startNode;
  if (!startNode || !endNode) return null;

  // How far every node is from the end, along streets (for "can I still get back?").
  const back = dijkstra(graph, endNode, budget * 1.1);
  if (!back.dist.has(startNode)) return null;
  if (back.dist.get(startNode) > budget * 1.05) return null; // the destination is too far

  // What each block is worth per meter.
  const value = new Map();
  for (const e of graph.edges.values()) {
    if (!back.dist.has(e.from) && !back.dist.has(e.to)) continue;
    let v = walked(e.id) || avoid(e.coords) ? 0 : e.path ? PATH_WEIGHT : 1;
    if (v && !e.path && nearlyDone(e)) v += FINISH_BONUS;
    value.set(e.id, v);
  }
  // Prize waiting near each node: new meters within ~2 blocks (a cheap look-ahead).
  const nearby = new Map();
  const nodeValue = (node, depth, seen) => {
    let sum = 0;
    for (const { edge, atStart } of graph.adj.get(node) || []) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      sum += (value.get(edge.id) || 0) * edge.len;
      if (depth > 1) sum += 0.5 * nodeValue(atStart ? edge.to : edge.from, depth - 1, seen);
    }
    return sum;
  };
  const lookahead = (node) => {
    if (!nearby.has(node)) nearby.set(node, nodeValue(node, 2, new Set()));
    return nearby.get(node);
  };

  // How far each corner is from the nearest block worth walking: when nothing
  // new is close by, routes head that way instead of wandering.
  const frontier = multiSource(graph, [...value].filter(([, v]) => v > 0).flatMap(([id]) => {
    const e = graph.edges.get(id);
    return [e.from, e.to];
  }), budget);

  let best = null;
  const candidates = [];
  const t0 = Date.now();
  for (let k = 0; k < tries && (k < 50 || Date.now() - t0 < timeLimit); k++) {
    const route = construct(graph, { startNode, endNode, budget, back, frontier: randomOnly ? new Map() : frontier, value: randomOnly ? new Map() : value, lookahead: randomOnly ? () => 0 : lookahead, rand,
      greed: randomOnly ? 10 : k === 0 ? 0 : 0.15 + 0.85 * rand() });
    if (!route) continue;
    candidates.push(route);
  }
  candidates.sort((a, b) => score(b, value, budget) - score(a, value, budget));
  for (const route of candidates.slice(0, randomOnly ? 1 : 6)) {
    const improved = polish && !randomOnly ? improve(graph, route, { budget, value, back, endNode }) : route;
    if (!best || score(improved, value, budget) > score(best, value, budget)) best = improved;
  }
  if (!best) return null;
  return describe(best, value);
}

// ---- building a route ----------------------------------------------------------------

// Steps: [{ edge, forward }]; meters is the total length.
function construct(graph, { startNode, endNode, budget, back, frontier, value, lookahead, rand, greed }) {
  const steps = [];
  const used = new Map(); // edge id -> times walked
  let node = startNode, meters = 0, lastEdge = null;
  for (let guard = 0; guard < 400; guard++) {
    const options = [];
    for (const { edge, atStart } of graph.adj.get(node) || []) {
      const next = atStart ? edge.to : edge.from;
      const home = back.dist.get(next);
      if (home == null || meters + edge.len + home > budget * 1.05) continue;
      if (edge === lastEdge && (graph.adj.get(node) || []).length > 1) continue; // no U-turns unless a dead end
      const times = used.get(edge.id) || 0;
      const fresh = times ? 0 : (value.get(edge.id) || 0) * edge.len;
      const ahead = lookahead(next) / 400;
      const waste = times * edge.len * 0.02;
      // Toward new blocks when there are none right here (+1 straight at them).
      const f0 = frontier.get(node), f1 = frontier.get(next);
      const toward = f0 != null && f1 != null ? (f0 - f1) / edge.len : 0;
      // greed 0: purely the best-looking step; higher: more exploration.
      options.push({ edge, next, forward: atStart, s: fresh / Math.max(edge.len, 20) + ahead + 0.8 * toward - waste + greed * rand() * 1.5 });
    }
    // Spent (or nowhere to go): head for the end, the shortest way.
    if (!options.length || meters + back.dist.get(node) >= budget * 0.92) break;
    options.sort((a, b) => b.s - a.s);
    const pick = options[0];
    steps.push({ edge: pick.edge, forward: pick.forward });
    used.set(pick.edge.id, (used.get(pick.edge.id) || 0) + 1);
    meters += pick.edge.len;
    lastEdge = pick.edge;
    node = pick.next;
  }
  // The way to the end.
  for (let n = node; n !== endNode;) {
    const p = back.prev.get(n);
    if (!p) return null;
    steps.push({ edge: p.edge, forward: p.edge.from === n });
    meters += p.edge.len;
    n = p.to;
  }
  return { steps, meters };
}

// Better routes from a good one:
//  - cut out-and-back stretches that collect nothing (walking down a block and
//    straight back, when that block was already walked or walked twice);
//  - add a detour around an unwalked block where the budget allows (go round
//    the block instead of past it).
function improve(graph, route, { budget, value }) {
  let steps = [...route.steps];
  // Cut wasted out-and-backs: A->B then B->A on the same edge with no new prize.
  for (let changed = true; changed;) {
    changed = false;
    const seen = new Map();
    steps.forEach((s) => seen.set(s.edge.id, (seen.get(s.edge.id) || 0) + 1));
    for (let i = 0; i + 1 < steps.length; i++) {
      if (steps[i].edge === steps[i + 1].edge && steps[i].forward !== steps[i + 1].forward) {
        const v = value.get(steps[i].edge.id) || 0;
        if (v === 0 || seen.get(steps[i].edge.id) > 2) {
          steps.splice(i, 2);
          changed = true;
          break;
        }
      }
    }
  }
  let meters = steps.reduce((n, s) => n + s.edge.len, 0);
  // Detours: at each corner, a small loop (up to 6 blocks) back to the same corner
  // over unwalked blocks, if it fits.
  const usedIds = new Set(steps.map((s) => s.edge.id));
  for (let i = 0; i <= steps.length && meters < budget * 0.98; i++) {
    const node = i === 0 ? nodeAt(steps[0], 'from') : nodeAt(steps[i - 1], 'to');
    const loop = smallLoop(graph, node, usedIds, value, budget * 1.05 - meters);
    if (!loop) continue;
    steps.splice(i, 0, ...loop.steps);
    loop.steps.forEach((s) => usedIds.add(s.edge.id));
    meters += loop.meters;
    i += loop.steps.length;
  }
  return { steps, meters };
}

const nodeAt = (step, end) => ((end === 'from') === step.forward ? step.edge.from : step.edge.to);

// The best short loop from `node` back to it over unwalked blocks (depth-first,
// up to 6 blocks), within `room` meters; null if none is worth it.
function smallLoop(graph, node, usedIds, value, room) {
  let best = null;
  const path = [];
  const onPath = new Set();
  const walk = (n, meters, gain) => {
    if (path.length && n === node) {
      if (gain > 0 && (!best || gain / meters > best.gain / best.meters)) best = { steps: [...path], meters, gain };
      return;
    }
    if (path.length >= 6) return;
    for (const { edge, atStart } of graph.adj.get(n) || []) {
      if (onPath.has(edge.id) || meters + edge.len > room) continue;
      const fresh = usedIds.has(edge.id) ? 0 : (value.get(edge.id) || 0) * edge.len;
      onPath.add(edge.id);
      path.push({ edge, forward: atStart });
      walk(atStart ? edge.to : edge.from, meters + edge.len, gain + fresh);
      path.pop();
      onPath.delete(edge.id);
    }
  };
  walk(node, 0, 0);
  // Worth it only if most of the detour is new.
  return best && best.gain >= 0.6 * best.meters ? best : null;
}

// ---- scoring --------------------------------------------------------------------------

function newMeters(route, value) {
  const seen = new Set();
  let gain = 0;
  for (const { edge } of route.steps) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    gain += (value.get(edge.id) || 0) * edge.len;
  }
  return gain;
}

function score(route, value, budget) {
  const counts = new Map();
  let repeated = 0;
  for (const { edge } of route.steps) {
    const n = (counts.get(edge.id) || 0) + 1;
    counts.set(edge.id, n);
    if (n > 1) repeated += edge.len;
  }
  // Too short wastes the time you had; too long overruns it.
  const off = route.meters < budget * 0.85 ? (budget * 0.85 - route.meters) : route.meters > budget * 1.1 ? 3 * (route.meters - budget * 1.1) : 0;
  return newMeters(route, value) - REPEAT_COST * repeated - off;
}

function describe(route, value) {
  const coords = [];
  const edges = [];
  const seen = new Set();
  let fresh = 0;
  for (const { edge, forward } of route.steps) {
    const c = forward ? edge.coords : [...edge.coords].reverse();
    coords.push(...(coords.length ? c.slice(1) : c));
    edges.push(edge.id);
    if (!seen.has(edge.id) && (value.get(edge.id) || 0) > 0) fresh += edge.len;
    seen.add(edge.id);
  }
  return { coords, edges, meters: route.meters, newMeters: fresh, minutes: route.meters / WALK_SPEED / 60 };
}

// ---- graph helpers -----------------------------------------------------------------------

function nearestNode(graph, p) {
  let best = null, bestD = Infinity;
  for (const e of graph.edges.values()) {
    if (e.path) continue;
    for (const [node, c] of [[e.from, e.coords[0]], [e.to, e.coords[e.coords.length - 1]]]) {
      const d = haversine(p, c);
      if (d < bestD) { bestD = d; best = node; }
    }
  }
  return bestD < 300 ? best : null;
}

// Shortest distances to `target` (walking is the same both ways), within `limit`.
// prev: node -> { edge, to } (the next step toward the target).
function dijkstra(graph, target, limit) {
  const dist = new Map([[target, 0]]), prev = new Map(), done = new Set();
  const heap = new Heap();
  heap.push(0, target);
  while (heap.size) {
    const [d, node] = heap.pop();
    if (done.has(node)) continue;
    done.add(node);
    for (const { edge, atStart } of graph.adj.get(node) || []) {
      const next = atStart ? edge.to : edge.from;
      const nd = d + edge.len;
      if (nd > limit || nd >= (dist.get(next) ?? Infinity)) continue;
      dist.set(next, nd);
      prev.set(next, { edge, to: node });
      heap.push(nd, next);
    }
  }
  return { dist, prev };
}

// Distance from every node to the nearest of `sources`, within `limit`.
function multiSource(graph, sources, limit) {
  const dist = new Map(), done = new Set(), heap = new Heap();
  for (const s of sources) { dist.set(s, 0); heap.push(0, s); }
  while (heap.size) {
    const [d, node] = heap.pop();
    if (done.has(node)) continue;
    done.add(node);
    for (const { edge, atStart } of graph.adj.get(node) || []) {
      const next = atStart ? edge.to : edge.from;
      const nd = d + edge.len;
      if (nd > limit || nd >= (dist.get(next) ?? Infinity)) continue;
      dist.set(next, nd);
      heap.push(nd, next);
    }
  }
  return dist;
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export { WALK_SPEED };
