// How good are walk suggestions? On the real street map, with a simulated
// walking history, compare the app's suggestions with simpler ways of picking
// a walk, and with what's possible at all.
//
//   node tests/sim/routes.bench.mjs
import { loadCity, route as shortest } from './nyc.mjs';
import { suggestRoute } from '../../js/routes.js';
import { haversine } from '../../js/geo.js';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export async function setup() {
  const home = [40.6852, -73.9843]; // Boerum Hill
  const city = await loadCity([40.665, -74.005, 40.705, -73.955]);
  const g = city.graph;
  // History: 40 walks between random spots within ~1.5 km of home (people walk
  // the same streets near home a lot), all walked end to end.
  const r = rng(99);
  const walked = new Set();
  const spot = () => [home[0] + (r() - 0.5) * 0.026, home[1] + (r() - 0.5) * 0.034];
  for (let i = 0; i < 40; i++) {
    try { for (const id of shortest(g, r() < 0.5 ? home : spot(), spot()).edges) walked.add(id); } catch { /* no route: skip */ }
  }
  return { city, g, home, walked };
}

// Measures one route: { minutes, newShare, repeatShare, closes, newMeters }.
export function measure(g, res, walked, start) {
  let rep = 0;
  const seen = new Set();
  for (const id of res.edges) { if (seen.has(id)) rep += g.edges.get(id).len; seen.add(id); }
  let fresh = 0;
  for (const id of seen) { const e = g.edges.get(id); if (!walked.has(id) && !e.path) fresh += e.len; }
  const end = res.coords[res.coords.length - 1];
  return { minutes: res.minutes, newMeters: fresh, newShare: fresh / res.meters, repeatShare: rep / res.meters, closes: haversine(end, res.coords[0]) < 60 && haversine(res.coords[0], start) < 300 };
}

const METHODS = {
  'app (many tries + polish)': {},
  'greedy (one try)': { tries: 1, polish: false },
  'many tries, no polish': { polish: false },
  'random loop': { randomOnly: true, tries: 1 },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { g, home, walked } = await setup();
  const starts = [home, [40.6890, -73.9800], [40.6800, -73.9900], [40.6930, -73.9870], [40.6760, -73.9800]];
  console.log(`history: ${walked.size} blocks walked near home`);
  for (const minutes of [20, 30, 45, 60]) {
    console.log(`\n${minutes} min loops (5 starts):`);
    for (const [name, opts] of Object.entries(METHODS)) {
      const rows = [];
      const t0 = performance.now();
      for (const [i, start] of starts.entries()) {
        const res = suggestRoute(g, { start, minutes, walked: (id) => walked.has(id), seed: i + 1, ...opts });
        if (res) rows.push(measure(g, res, walked, start));
      }
      const avg = (k) => rows.reduce((n, x) => n + x[k], 0) / rows.length;
      console.log(`  ${name.padEnd(28)} new ${(avg('newShare') * 100).toFixed(0).padStart(3)}% of the walk | repeated ${(avg('repeatShare') * 100).toFixed(0).padStart(2)}% | ${avg('minutes').toFixed(0)} min | loops ${rows.filter((x) => x.closes).length}/${rows.length} | ${Math.round((performance.now() - t0) / rows.length)} ms each`);
    }
  }
}

// Best possible share of new meters for a loop of `meters` from start: you
// must at least walk to the nearest unwalked block and back.
export function ceiling(g, start, meters, walked) {
  let near = Infinity;
  for (const e of g.edges.values()) {
    if (e.path || walked.has(e.id)) continue;
    for (const c of [e.coords[0], e.coords[e.coords.length - 1]]) near = Math.min(near, haversine(start, c));
  }
  return Math.max(0, 1 - (2 * near * 1.3) / meters); // 1.3: streets aren't straight lines
}

// A month: every day, a 30-minute walk from home, following the suggestion
// (or a random loop); count new blocks as they pile up.
export function month(g, home, walked0, opts, days = 30) {
  const walked = new Set(walked0);
  const curve = [];
  for (let d = 0; d < days; d++) {
    const res = suggestRoute(g, { start: home, minutes: 30, walked: (id) => walked.has(id), seed: 1000 + d, ...opts });
    if (res) for (const id of res.edges) if (!g.edges.get(id).path) walked.add(id);
    curve.push(walked.size - walked0.size);
  }
  return curve;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { g, home, walked } = await setup();
  console.log('\nHow close to the best possible (30 min, from each start):');
  for (const start of [home, [40.6890, -73.9800], [40.6800, -73.9900]]) {
    const res = suggestRoute(g, { start, minutes: 30, walked: (id) => walked.has(id) });
    const m = measure(g, res, walked, start);
    console.log(`  new ${(m.newShare * 100).toFixed(0)}% of the walk vs at most ~${(ceiling(g, start, res.meters, walked) * 100).toFixed(0)}% possible`);
  }
  console.log('\nA month of 30-minute walks from home (new blocks so far, every 5 days):');
  for (const [name, opts] of [['following suggestions', {}], ['random loops', { randomOnly: true, tries: 1 }]]) {
    const c = month(g, home, walked, opts);
    console.log(`  ${name.padEnd(22)} ${[4, 9, 14, 19, 24, 29].map((i) => String(c[i]).padStart(4)).join(' ')}`);
  }
}
