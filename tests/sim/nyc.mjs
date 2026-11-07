// A day in NYC, simulated: people walking real routes on the real street map,
// with the GPS, motion sensor and step counter an iPhone would give, run through
// the app's whole pipeline (the phone's automatic-walk rules, the import, GPS
// clean-up, no-tracking areas, map matching), and scored against the blocks
// they really walked.
//
//   node tests/sim/nyc.mjs            report
//   node --test tests/sim/nyc.test.mjs   the same, with pass/fail thresholds
//
// Needs data/nyc (scripts/build_city.mjs).
import { readFileSync } from 'node:fs';
import { City } from '../../js/city.js';
import { haversine, makeProjector } from '../../js/geo.js';
import { nativeWalkToTrack, usableFix } from '../../js/native.js';
import { withoutZones, inZone } from '../../js/zones.js';
import { blockAround } from '../../js/blockface.js';

const DATA = new URL('../../data/nyc/', import.meta.url).pathname;

// ---- random numbers (seeded, so a day replays exactly) ---------------------------
function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return { next, range: (a, b) => a + (b - a) * next(), normal: () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next()) };
}

// ---- the city ---------------------------------------------------------------------
export async function loadCity(bbox) {
  const fetchImpl = async (u) => {
    const p = u.replace(/^.*?data\/nyc\//, '').replace(/\?.*$/, '');
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(DATA + p, 'utf8')) };
  };
  const city = await new City({ fetchImpl }).init();
  await city.ensure(city.hoodsIn(bbox, 0.01));
  return city;
}

// Shortest route along the network between two places: { coords, edges }.
// `streetsOnly` for vehicles (no park paths).
export function route(graph, from, to, { streetsOnly = false } = {}) {
  const nearest = (p) => {
    let best = null;
    // Start and end on a street (park paths don't always join the street grid).
    for (const e of graph.edges.values()) {
      if (e.path) continue;
      for (const node of [e.from, e.to]) {
        const c = node === e.from ? e.coords[0] : e.coords[e.coords.length - 1];
        const d = haversine(p, c);
        if (!best || d < best.d) best = { node, d };
      }
    }
    return best.node;
  };
  const start = nearest(from), goal = nearest(to);
  const dist = new Map([[start, 0]]), prev = new Map(), done = new Set();
  const heap = [[0, start]];
  while (heap.length) {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
    const [d, node] = heap.splice(bi, 1)[0];
    if (done.has(node)) continue;
    done.add(node);
    if (node === goal) break;
    for (const { edge, atStart } of graph.adj.get(node) || []) {
      if (streetsOnly && edge.path) continue;
      const next = atStart ? edge.to : edge.from;
      const nd = d + edge.len;
      if (nd < (dist.get(next) ?? Infinity)) { dist.set(next, nd); prev.set(next, { edge, from: node, forward: atStart }); heap.push([nd, next]); }
    }
  }
  if (!prev.has(goal)) throw new Error(`no route from ${from} to ${to}${streetsOnly ? ' (streets only)' : ''}`);
  const legs = [];
  for (let n = goal; n !== start; n = prev.get(n).from) legs.unshift(prev.get(n));
  const coords = [];
  for (const { edge, forward } of legs) {
    const c = forward ? edge.coords : [...edge.coords].reverse();
    coords.push(...(coords.length ? c.slice(1) : c));
  }
  return { coords, edges: legs.map((l) => l.edge.id) };
}

// ---- the person and their phone ----------------------------------------------------
// A plan is a list of legs: { mode, route, ... }. Modes: walk, run, bike, bus,
// taxi, subway (underground: station Wi-Fi only), stay (in a building).
// Produces 1 Hz "truth" plus what the phone would deliver: GPS fixes (iOS
// sends one per ~4 m moved), motion-sensor activity, and a step count.
export function simulate(plan, { seed = 1, start = Date.UTC(2026, 10, 9, 12, 0) } = {}) {
  const r = rng(seed);
  const project = makeProjector(40.72);
  const fixes = []; // { lat, lon, t, acc, speed, steps, motion }
  let t = start, steps = 0;
  let last = null;
  let multipath = null; // { until, dx, dy }: tall buildings bouncing the signal
  const canyon = (p) => p[0] > 40.745 && p[0] < 40.77 && p[1] > -73.995 && p[1] < -73.965; // Midtown
  const emit = (p, { motion, speed, indoor = false, wifiOnly = false, quality = 1 }) => {
    let [lat, lon] = p;
    let acc, gpsSpeed = speed;
    if (wifiOnly || indoor) {
      // Wi-Fi / cell positioning: tens of meters off, no speed.
      lat += (r.normal() * 25) / 111320; lon += (r.normal() * 25) / 84000;
      acc = r.range(25, 65); gpsSpeed = -1;
    } else {
      let sigma = canyon(p) ? 9 : 4;
      if (canyon(p) && !multipath && r.next() < 0.01) multipath = { until: t + r.range(10, 25) * 1000, dx: r.range(-60, 60), dy: r.range(-60, 60) };
      if (multipath && t > multipath.until) multipath = null;
      const bias = multipath ? [multipath.dx, multipath.dy] : [0, 0];
      lat += (r.normal() * sigma * quality + bias[1]) / 111320;
      lon += (r.normal() * sigma * quality + bias[0]) / 84000;
      acc = multipath ? r.range(10, 20) : sigma * r.range(1.2, 2.2); // iOS under-reports multipath
    }
    const fix = { lat, lon, t, acc, speed: gpsSpeed, steps, motion };
    // iOS: a new fix once moved ~4 m (indoors / stopped: occasional updates anyway).
    if (!last || haversine([last.lat, last.lon], [lat, lon]) >= 4 || t - last.t > 30000) { fixes.push(fix); last = fix; }
  };
  for (const leg of plan) {
    if (leg.mode === 'stay') {
      // Inside a building (office, shop): GPS drifts around it.
      const until = t + leg.minutes * 60000;
      while (t < until) {
        if (r.next() < 0.03) steps += Math.round(r.range(5, 40)); // getting up, walking to the kitchen
        emit(leg.at, { motion: r.next() < 0.05 ? 'walking' : 'stationary', speed: 0, indoor: true });
        t += 15000;
      }
      continue;
    }
    const pts = leg.route.coords;
    const speedFor = { walk: [1.15, 1.55], run: [2.6, 3.3], bike: [4, 6.5], bus: [2, 7], taxi: [1, 4.5], subway: [8, 14] }[leg.mode];
    const stepsPerSec = { walk: 1.8, run: 2.7 }[leg.mode] || 0;
    const motion = { walk: 'walking', run: 'running', bike: 'cycling', bus: 'automotive', taxi: 'automotive', subway: 'unknown' }[leg.mode];
    let speed = r.range(...speedFor);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = haversine(a, b);
      // Waits: a red light at intersections (walkers), stops (buses, taxis).
      if (leg.mode === 'walk' && r.next() < 0.12) {
        const wait = r.range(15, 90);
        for (let s = 0; s < wait; s += 1) { emit(a, { motion: s > 20 ? 'stationary' : 'walking', speed: 0 }); t += 1000; }
      }
      if ((leg.mode === 'bus' || leg.mode === 'taxi') && r.next() < 0.25) {
        for (let s = 0; s < r.range(10, 45); s += 1) { emit(a, { motion: 'automotive', speed: 0 }); t += 1000; }
      }
      for (let s = 0; s < d; s += speed) {
        const f = s / d;
        const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        steps += stepsPerSec ? Math.round(stepsPerSec * r.range(0.8, 1.2)) : (r.next() < 0.02 ? 1 : 0);
        if (leg.mode === 'subway') {
          if (leg.stations?.some((st) => haversine(st, p) < 80)) emit(p, { motion, speed, wifiOnly: true });
        } else emit(p, { motion, speed, quality: leg.quality ?? 1 });
        t += 1000;
        if (r.next() < 0.05) speed = r.range(...speedFor);
      }
    }
    void project;
  }
  return { fixes, end: t };
}

// The iPhone app's automatic-walk rules (LocationService.swift), applied to
// the simulated phone: walks start when the motion sensor says walking/running
// (after its usual lag), points need usable GPS and no vehicle, they end 2 min
// after stopping or 5 min without usable GPS, and walks under 100 m are dropped.
export function phoneAutoWalks(fixes, zones = []) {
  const walks = [];
  let cur = null, offSince = null, lastGood = null, inVehicle = false, zoneGap = false;
  let motionLagged = 'stationary', motionSince = 0, pendingMotion = null;
  const finish = () => {
    if (!cur) return;
    let dist = 0;
    for (let i = 1; i < cur.points.length; i++) dist += haversine(cur.points[i - 1], cur.points[i]);
    if (cur.points.length >= 2 && dist >= 100) walks.push(cur);
    cur = null; offSince = null;
  };
  for (const f of fixes) {
    // The motion sensor reports changes ~10-20 s late.
    if (f.motion !== (pendingMotion?.m ?? motionLagged)) pendingMotion = { m: f.motion, at: f.t };
    if (pendingMotion && f.t - pendingMotion.at > 15000) { motionLagged = pendingMotion.m; motionSince = f.t; pendingMotion = null; }
    const onFoot = motionLagged === 'walking' || motionLagged === 'running';
    if (motionLagged === 'automotive' || motionLagged === 'cycling') inVehicle = true;
    if (onFoot || motionLagged === 'stationary') inVehicle = false;
    if (onFoot) {
      offSince = null;
      if (!cur) { cur = { id: `W${walks.length + 1}`, startedAt: f.t, endedAt: f.t, points: [] }; lastGood = f.t; }
    } else if (cur) {
      if (offSince == null) offSince = motionSince;
      if (f.t - offSince >= 120000) finish();
    }
    if (cur && lastGood != null && f.t - lastGood >= 300000) finish();
    if (!cur) continue;
    const usable = f.acc <= 35 && !(f.speed > 7) && (f.acc <= 20 || f.speed >= 0);
    if (!usable) continue;
    lastGood = f.t;
    if (inZone([f.lat, f.lon], zones)) { zoneGap = true; continue; }
    if (inVehicle) continue;
    cur.points.push([f.lat, f.lon, f.t, f.acc, f.speed, f.steps, zoneGap ? 1 : 0]);
    zoneGap = false;
    cur.endedAt = f.t;
  }
  finish();
  return walks;
}

// The whole thing for one day: what the app ends up counting vs the truth.
export async function scoreDay({ name, plan, zones = [], seed = 1, city }) {
  const { fixes } = simulate(plan, { seed });
  const walks = phoneAutoWalks(fixes, zones);
  const tracks = walks.map((w, i) => ({ id: i + 1, ...nativeWalkToTrack(w) })).map((t) => withoutZones(t, zones));
  city.setTracks(tracks);
  await city.ensure(city.hoodsIn([40.5, -74.3, 40.95, -73.65], 0).filter((id) => tracks.some((t) => t.points.length && city.hoods.get(id))) .slice(0, 0));
  city.refreshMatches();
  const walked = new Set(city.loadedBlocks().filter((b) => city.isWalked(b.id)).map((b) => b.id));
  // Truth: blocks walked (or run) end to end, outside no-tracking areas.
  const truth = new Set(), rode = new Set();
  for (const leg of plan) {
    if (!leg.route) continue;
    for (const id of leg.route.edges) {
      const b = city.block(id);
      if (!b || city.isPath(id)) continue;
      if (leg.mode === 'walk' || leg.mode === 'run') {
        if (b.length >= 40 && !b.coords.some((p) => inZone(p, zones))) truth.add(id);
      } else rode.add(id);
    }
  }
  const hit = [...truth].filter((id) => walked.has(id));
  // Extras, sorted: harmless ones (a short piece on the route itself, or the
  // other side of a divided street that was walked) vs. real mistakes.
  const onRoute = new Set(plan.filter((l) => l.mode === 'walk' || l.mode === 'run').flatMap((l) => l.route?.edges || []));
  const walkedNames = new Set([...truth].map((id) => city.block(id).name).filter(Boolean));
  const near = (b, ids) => [...ids].some((id) => {
    const o = city.block(id);
    return b.coords.some((p) => o.coords.some((q) => haversine(p, q) < 45));
  });
  const extraAll = [...walked].filter((id) => !truth.has(id));
  const harmless = extraAll.filter((id) => {
    const b = city.block(id);
    return (onRoute.has(id) && !rode.has(id)) || (b.name && walkedNames.has(b.name) && near(b, truth));
  });
  const extra = extraAll.filter((id) => !harmless.includes(id));
  const fromRides = extra.filter((id) => rode.has(id));
  const insideZones = [...walked].filter((id) => city.block(id).coords.every((p) => inZone(p, zones)));
  return {
    name, walks: walks.length, truth: truth.size, found: hit.length, extra: extra.length, harmless: harmless.length, fromRides: fromRides.length,
    insideZones: insideZones.length, recall: truth.size ? hit.length / truth.size : 1,
    missed: [...truth].filter((id) => !walked.has(id)).map((id) => `${city.block(id).name || '(unnamed)'} ${Math.round(city.block(id).length)}m ${(city.fraction(id) * 100).toFixed(0)}%`),
    extras: extra.map((id) => `${city.block(id).name || '(unnamed)'} ${Math.round(city.block(id).length)}m${rode.has(id) ? ' (rode it)' : ''}`),
    extraIds: extra,
  };
}

// Underground: a straight line (the subway doesn't follow streets), no blocks.
const straight = (a, b) => ({ coords: [a, b], edges: [] });

// ---- the days ----------------------------------------------------------------------
const P = {
  boerumHome: [40.6852, -73.9843], // Dean St near Bond St
  boroughHall: [40.6928, -73.9903],
  unionSq: [40.7359, -73.9906],
  flatironOffice: [40.7404, -73.9902], // a block-sized office near Broadway & 21st
  madisonSq: [40.7420, -73.9876],
  washSq: [40.7308, -73.9973],
  parkSlope7th: [40.6716, -73.9777],
  prospectIn: [40.6650, -73.9700],
  grandArmy: [40.6741, -73.9701],
  bryantPark: [40.7536, -73.9832],
  sixth57: [40.7646, -73.9776],
  fifth42: [40.7527, -73.9806],
  firstAve14: [40.7316, -73.9822],
  firstAve34: [40.7442, -73.9737],
  easternPkwyA: [40.6726, -73.9618],
  dogLoopA: [40.6830, -73.9790], // Bergen St & 3rd Ave
  dogLoopB: [40.6875, -73.9800], // State St & Nevins
  easternPkwyB: [40.6688, -73.9310],
};

export async function days() {
  const city = await loadCity([40.66, -74.0, 40.77, -73.92]);
  const g = city.graph;
  const R = (a, b, o) => route(g, a, b, o);
  const officeZone = (() => {
    const ring = blockAround(g, P.flatironOffice);
    return { id: 'office', name: 'Office', lat: P.flatironOffice[0], lon: P.flatironOffice[1], ring, pad: 8 };
  })();
  return {
    city,
    list: [
      {
        name: 'Commute: walk, subway, office (no-tracking block), lunch walk, walk home part way, bus',
        zones: [officeZone],
        plan: [
          { mode: 'walk', route: R(P.boerumHome, P.boroughHall) },
          { mode: 'stay', at: P.boroughHall, minutes: 3 }, // on the platform
          { mode: 'subway', route: straight(P.boroughHall, P.unionSq), stations: [P.boroughHall, P.unionSq] },
          { mode: 'walk', route: R(P.unionSq, P.flatironOffice) },
          { mode: 'stay', at: P.flatironOffice, minutes: 180 },
          { mode: 'walk', route: R(P.flatironOffice, P.madisonSq) },
          { mode: 'walk', route: R(P.madisonSq, P.flatironOffice) },
          { mode: 'stay', at: P.flatironOffice, minutes: 150 },
          { mode: 'walk', route: R(P.flatironOffice, P.washSq) },
          { mode: 'walk', route: R(P.washSq, P.firstAve14) },
          { mode: 'bus', route: R(P.firstAve14, P.firstAve34, { streetsOnly: true }) },
          { mode: 'walk', route: R(P.firstAve34, P.bryantPark) },
        ],
      },
      {
        name: 'Errands in Park Slope: deli stop, red lights, a loop into Prospect Park',
        plan: [
          { mode: 'walk', route: R(P.grandArmy, P.parkSlope7th) },
          { mode: 'stay', at: P.parkSlope7th, minutes: 6 }, // in a deli
          { mode: 'walk', route: R(P.parkSlope7th, P.prospectIn) },
          { mode: 'walk', route: R(P.prospectIn, P.grandArmy) },
        ],
      },
      {
        name: 'Midtown towers: up 6th Ave, across 57th, down 5th (GPS bouncing off buildings)',
        plan: [
          { mode: 'walk', route: R(P.bryantPark, P.sixth57) },
          { mode: 'walk', route: R(P.sixth57, P.fifth42) },
        ],
      },
      {
        name: 'Citi Bike up 1st Ave, then a taxi crawling across Midtown',
        plan: [
          { mode: 'walk', route: R(P.washSq, P.firstAve14) },
          { mode: 'bike', route: R(P.firstAve14, P.firstAve34, { streetsOnly: true }) },
          { mode: 'stay', at: P.firstAve34, minutes: 4 },
          { mode: 'taxi', route: R(P.firstAve34, P.bryantPark, { streetsOnly: true }) },
          { mode: 'walk', route: R(P.bryantPark, P.fifth42) },
        ],
      },
      {
        name: 'Dog walks from home (a no-tracking circle): slow, lots of stopping, around the same blocks',
        zones: [{ id: 'home', name: 'Home', lat: P.boerumHome[0], lon: P.boerumHome[1], r: 100 }],
        plan: [
          { mode: 'stay', at: P.boerumHome, minutes: 20 },
          { mode: 'walk', route: R(P.boerumHome, P.dogLoopA) },
          { mode: 'stay', at: P.dogLoopA, minutes: 1.5 }, // sniffing (outdoors, but GPS still drifts)
          { mode: 'walk', route: R(P.dogLoopA, P.dogLoopB) },
          { mode: 'walk', route: R(P.dogLoopB, P.boerumHome) },
          { mode: 'stay', at: P.boerumHome, minutes: 240 },
          { mode: 'walk', route: R(P.boerumHome, P.dogLoopB) },
          { mode: 'walk', route: R(P.dogLoopB, P.boerumHome) },
        ],
      },
      {
        name: 'A run along Eastern Parkway and back',
        plan: [
          { mode: 'run', route: R(P.easternPkwyA, P.easternPkwyB) },
          { mode: 'walk', route: R(P.easternPkwyB, P.easternPkwyA) },
        ],
      },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { city, list } = await days();
  for (const [i, d] of list.entries()) {
    const s = await scoreDay({ ...d, seed: i + 1, city });
    console.log(`\n${s.name}\n  walks recorded: ${s.walks} | blocks walked: ${s.truth} | counted: ${s.found} (${(s.recall * 100).toFixed(0)}%) | wrongly counted: ${s.extra} (${s.fromRides} on streets ridden; ${s.harmless} harmless) | inside the office area: ${s.insideZones}`);
    if (s.missed.length) console.log(`  missed: ${s.missed.slice(0, 12).join('; ')}`);
    if (s.extras.length) console.log(`  extra: ${s.extras.slice(0, 12).join('; ')}`);
  }
}
