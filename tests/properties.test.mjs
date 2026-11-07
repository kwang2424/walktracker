// Property tests: rules that must hold for any walk, not just hand-picked ones.
// Each test generates many random street grids and walks (with GPS noise,
// dropouts, spikes, stops, rides, no-tracking areas) from a fixed seed, so a
// failure is reproducible: the message names the seed and case number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCity } from '../scripts/citylib.mjs';
import { City } from '../js/city.js';
import { haversine, polylineLength } from '../js/geo.js';
import { StreetGraph, matchWalk } from '../js/match.js';
import { cleanTrack, dropRides } from '../js/track.js';
import { inZone, withoutZones, runsOf } from '../js/zones.js';
import { blockAround } from '../js/blockface.js';
import { walkDetails, trimWalk, untrimWalk } from '../js/walkstats.js';
import { stepsOf } from '../js/native.js';

const CASES = Number(process.env.PROPERTY_CASES || 40);
// How many things each test actually checked (so a test can't pass by checking nothing).
const checked = new Map();
const count = (name, n = 1) => checked.set(name, (checked.get(name) || 0) + n);

// ---- random generators ----------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    normal: () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next()),
  };
}

const LAT0 = 40.73, LON0 = -73.99;
const MY = 1 / 111320, MX = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));

// A rotated grid of streets, some segments missing, in one big neighborhood.
function randomCity(r) {
  const cols = r.int(3, 6), rows = r.int(3, 6);
  const dx = r.range(70, 260), dy = r.range(60, 180);
  const angle = r.range(-0.6, 0.6);
  const at = (x, y) => {
    const X = x * Math.cos(angle) - y * Math.sin(angle), Y = x * Math.sin(angle) + y * Math.cos(angle);
    return [LAT0 + Y * MY, LON0 + X * MX];
  };
  const nodes = [], ways = [];
  const id = (i, j) => 1000 + i * 50 + j;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) nodes.push([id(i, j), ...at(i * dx, j * dy)]);
  let w = 1;
  const present = new Set();
  for (let j = 0; j < rows; j++) for (let i = 0; i + 1 < cols; i++) {
    if (r.next() < 0.08) continue; // a missing block
    ways.push([w++, [id(i, j), id(i + 1, j)], `Row ${j}`, 'residential']);
    present.add(`${i},${j}-${i + 1},${j}`);
  }
  for (let i = 0; i < cols; i++) for (let j = 0; j + 1 < rows; j++) {
    if (r.next() < 0.08) continue;
    ways.push([w++, [id(i, j), id(i, j + 1)], `Col ${i}`, 'residential']);
    present.add(`${i},${j}-${i},${j + 1}`);
  }
  const span = Math.max(cols * dx, rows * dy) + 2000;
  const hoodsGeo = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'H1', name: 'Grid', borough: 'Testboro', type: 0 },
    geometry: { type: 'MultiPolygon', coordinates: [[[[LON0 - span * MX, LAT0 - span * MY], [LON0 + span * MX, LAT0 - span * MY],
      [LON0 + span * MX, LAT0 + span * MY], [LON0 - span * MX, LAT0 + span * MY], [LON0 - span * MX, LAT0 - span * MY]]]] } }] };
  return { raw: { nodes, ways }, hoodsGeo, at, cols, rows, dx, dy, present };
}

// A walk along the grid's streets: a random route of a few blocks, sampled
// every 1-6 s at walking speed, with optional noise, a dropout, a spike, a stop.
function randomWalk(r, g, { noise = 0, extras = true, t0 = 0 } = {}) {
  let i = r.int(0, g.cols - 1), j = r.int(0, g.rows - 1);
  const route = [[i, j]];
  const legs = r.int(2, 7);
  for (let k = 0; k < legs; k++) {
    const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([a, b]) => [i + a, j + b])
      .filter(([a, b]) => a >= 0 && b >= 0 && a < g.cols && b < g.rows)
      .filter(([a, b]) => g.present.has(`${Math.min(i, a)},${Math.min(j, b)}-${Math.max(i, a)},${Math.max(j, b)}`));
    if (!opts.length) break;
    [i, j] = r.pick(opts);
    route.push([i, j]);
  }
  const speed = r.range(1.0, 1.7);
  const pts = [];
  let t = t0;
  for (let k = 1; k < route.length; k++) {
    const [a, b] = [route[k - 1], route[k]];
    const len = Math.hypot((b[0] - a[0]) * g.dx, (b[1] - a[1]) * g.dy);
    for (let s = 0; s < len; s += speed * r.range(1, 6)) {
      const f = s / len;
      const x = (a[0] + (b[0] - a[0]) * f) * g.dx, y = (a[1] + (b[1] - a[1]) * f) * g.dy;
      const [lat, lon] = g.at(x + noise * r.normal(), y + noise * r.normal());
      t += (speed * r.range(1, 6) / speed) * 1000;
      pts.push([lat, lon, Math.round(t)]);
    }
  }
  const last = route[route.length - 1];
  pts.push([...g.at(last[0] * g.dx, last[1] * g.dy), Math.round(t + 2000)]);
  if (extras && pts.length > 20) {
    if (r.next() < 0.4) pts.splice(r.int(5, pts.length - 10), r.int(3, 8)); // GPS dropout
    if (r.next() < 0.4) { const k = r.int(2, pts.length - 3); pts[k] = [pts[k][0] + r.range(-1, 1) * 200 * MY, pts[k][1] + r.range(-1, 1) * 200 * MX, pts[k][2]]; } // spike
  }
  return { points: pts, route };
}

async function cityFor(g, tracks) {
  const built = buildCity(g.raw, g.hoodsGeo);
  const files = { 'index.json': built.index, ...Object.fromEntries(Object.entries(built.files).map(([k, v]) => [`hoods/${k}.json`, v])) };
  const fetchImpl = async (u) => {
    const p = u.replace(/^.*?data\/nyc\//, '').replace(/\?.*$/, '');
    return { ok: p in files, status: p in files ? 200 : 404, json: async () => structuredClone(files[p]) };
  };
  const city = await new City({ fetchImpl }).init();
  await city.ensure(['H1']);
  city.setTracks(tracks);
  city.refreshMatches();
  return city;
}
const walkedSet = (city) => new Set(city.loadedBlocks().filter((b) => city.isWalked(b.id)).map((b) => b.id));

function forCases(name, fn) {
  test(name, async () => {
    for (let c = 0; c < CASES; c++) {
      const seed = 7919 * (c + 1) + name.length;
      try {
        await fn(rng(seed), c);
      } catch (err) {
        err.message = `[case ${c}, seed ${seed}] ${err.message}`;
        throw err;
      }
    }
  });
}

// ---- coverage ---------------------------------------------------------------------

forCases('the same walks always give the same blocks, in any order', async (r) => {
  const g = randomCity(r);
  const walks = [0, 1, 2].map((k) => ({ id: k + 1, startedAt: k * 1e7, ...randomWalk(r, g, { noise: r.range(0, 10), t0: k * 1e7 }) }));
  const a = walkedSet(await cityFor(g, walks));
  const b = walkedSet(await cityFor(g, [...walks].reverse()));
  const c = walkedSet(await cityFor(g, [...walks, ...walks.map((w) => ({ ...w, id: w.id + 10 }))]));
  assert.deepEqual([...b].sort(), [...a].sort(), 'order changed the result');
  assert.deepEqual([...c].sort(), [...a].sort(), 'walking the same walk again changed the result');
});

forCases('adding a walk never un-walks a block', async (r) => {
  const g = randomCity(r);
  const w1 = { id: 1, startedAt: 0, ...randomWalk(r, g, { noise: r.range(0, 10) }) };
  const w2 = { id: 2, startedAt: 1e7, ...randomWalk(r, g, { noise: r.range(0, 10), t0: 1e7 }) };
  const one = walkedSet(await cityFor(g, [w1]));
  const both = walkedSet(await cityFor(g, [w1, w2]));
  for (const id of one) assert.ok(both.has(id), `block ${id} lost when a second walk was added`);
});

forCases('a clean walk along streets completes every block it walks end to end', async (r) => {
  const g = randomCity(r);
  const w = randomWalk(r, g, { noise: 3, extras: false });
  const city = await cityFor(g, [{ id: 1, startedAt: 0, points: w.points }]);
  const walked = walkedSet(city);
  for (let k = 1; k < w.route.length; k++) {
    const [a, b] = [w.route[k - 1], w.route[k]];
    const mid = g.at(((a[0] + b[0]) / 2) * g.dx, ((a[1] + b[1]) / 2) * g.dy);
    const block = city.loadedBlocks().find((bl) => haversine(bl.coords[0], bl.coords[bl.coords.length - 1]) > 1 && haversine(midOf(bl), mid) < 5);
    if (!block || block.length < 50) continue;
    count('end-to-end blocks');
    assert.ok(walked.has(block.id), `block ${block.name} (${Math.round(block.length)} m) walked end to end but not counted (${city.fraction(block.id).toFixed(2)})`);
  }
});

forCases('no block far from the walk ever counts', async (r) => {
  const g = randomCity(r);
  const w = randomWalk(r, g, { noise: r.range(0, 12) });
  const city = await cityFor(g, [{ id: 1, startedAt: 0, points: w.points }]);
  // The true route, densely sampled.
  const truth = [];
  for (let k = 1; k < w.route.length; k++) {
    const [a, b] = [w.route[k - 1], w.route[k]];
    for (let f = 0; f <= 1; f += 0.05) truth.push(g.at((a[0] + (b[0] - a[0]) * f) * g.dx, (a[1] + (b[1] - a[1]) * f) * g.dy));
  }
  for (const id of walkedSet(city)) {
    count('walked blocks checked for distance');
    const b = city.block(id);
    const nearest = Math.min(...truth.map((p) => haversine(p, midOf(b))));
    assert.ok(nearest < b.length / 2 + 60, `${b.name} counted but its middle is ${Math.round(nearest)} m from the walk`);
  }
});

const midOf = (b) => {
  const c = b.coords;
  return [(c[0][0] + c[c.length - 1][0]) / 2, (c[0][1] + c[c.length - 1][1]) / 2];
};

// ---- no-tracking areas --------------------------------------------------------------

forCases('nothing inside a no-tracking area counts, and breaks are well formed', async (r) => {
  const g = randomCity(r);
  const w = randomWalk(r, g, { noise: r.range(0, 8) });
  const center = r.pick(w.points);
  const zone = { id: 'z', name: 'Z', lat: center[0], lon: center[1], r: r.range(60, 250) };
  const t = withoutZones({ id: 1, startedAt: 0, points: w.points }, [zone]);
  count('points removed by areas', w.points.length - t.points.length);
  assert.ok(t.points.every((p) => !inZone(p, [zone])), 'a point inside the area survived');
  const breaks = t.breaks || [];
  assert.deepEqual(breaks, [...new Set(breaks)].sort((a, b) => a - b), 'breaks not sorted/unique');
  assert.ok(breaks.every((b) => b > 0 && b < t.points.length), 'break index out of range');
  assert.deepEqual(runsOf(t).flat(), t.points, 'runs don\'t add up to the walk');
  const city = await cityFor(g, [t]);
  for (const id of walkedSet(city)) {
    const b = city.block(id);
    // A block wholly inside the area (with room for the 25 m match corridor) can't count.
    const deep = b.coords.every((p) => haversine(p, [zone.lat, zone.lon]) < zone.r - 30);
    assert.ok(!deep, `${b.name} is inside the area but counted`);
  }
});

forCases('block-shaped areas: the block found contains the tap and is no bigger than a grid cell', async (r) => {
  const g = randomCity(r);
  const sg = new StreetGraph();
  const built = buildCity(g.raw, g.hoodsGeo);
  const f = built.files.H1;
  sg.add(f.blocks.map(([id, ni, flat]) => { const c = []; for (let i = 0; i < flat.length; i += 2) c.push([flat[i], flat[i + 1]]); return { id, name: f.names[ni], coords: c }; }));
  for (let k = 0; k < 5; k++) {
    const ci = r.int(0, g.cols - 2), cj = r.int(0, g.rows - 2);
    const tap = g.at((ci + r.range(0.2, 0.8)) * g.dx, (cj + r.range(0.2, 0.8)) * g.dy);
    const ring = blockAround(sg, tap);
    if (!ring) continue; // a missing street can open the cell to the outside
    count('blocks traced')
    const zone = { id: 'b', name: 'B', lat: tap[0], lon: tap[1], ring, pad: 8 };
    assert.ok(inZone(tap, [zone]), 'the tapped point is not in the block found');
    // Its real area: at least the cell tapped, and never the whole grid (missing
    // streets can merge a few cells, but it must never be the outside).
    const xy = ring.map(([la, lo]) => [(lo - LON0) / MX, (la - LAT0) / MY]);
    let area = 0;
    for (let a = 0, b = xy.length - 1; a < xy.length; b = a++) area += xy[b][0] * xy[a][1] - xy[a][0] * xy[b][1];
    area = Math.abs(area / 2);
    const cell = g.dx * g.dy, grid = (g.cols - 1) * (g.rows - 1) * cell;
    assert.ok(area >= cell * 0.95, `block found (${Math.round(area)} m²) is smaller than the cell (${Math.round(cell)} m²)`);
    assert.ok(area <= grid * 1.01, `block found (${Math.round(area)} m²) is bigger than the whole grid (${Math.round(grid)} m²)`);
  }
});

// ---- map matching -------------------------------------------------------------------

forCases('map matching returns well-formed steps', async (r) => {
  const g = randomCity(r);
  const built = buildCity(g.raw, g.hoodsGeo);
  const f = built.files.H1;
  const sg = new StreetGraph();
  sg.add(f.blocks.map(([id, ni, flat]) => { const c = []; for (let i = 0; i < flat.length; i += 2) c.push([flat[i], flat[i + 1]]); return { id, name: f.names[ni], coords: c }; }));
  const w = randomWalk(r, g, { noise: r.range(0, 15) });
  const breaks = r.next() < 0.5 ? [r.int(1, w.points.length - 1)] : [];
  const steps = matchWalk(sg, w.points, breaks);
  let lastA = -1;
  for (const s of steps) {
    assert.ok(s.a >= 0 && s.b < w.points.length && s.a <= s.b, `bad step range ${s.a}..${s.b}`);
    assert.ok(s.a >= lastA, 'steps out of order');
    lastA = s.a;
    for (const b of breaks) assert.ok(!(s.a < b && b <= s.b), `a step spans the break at ${b}`);
    count('match steps');
    for (const fill of s.fills) {
      const e = sg.edges.get(fill.id);
      assert.ok(e, `fill on unknown block ${fill.id}`);
      for (const m of [fill.m0, fill.m1]) assert.ok(m >= -6 && m <= e.len + 6, `fill outside its block: ${m} of ${e.len}`);
    }
  }
});

// ---- GPS clean-up ---------------------------------------------------------------------

forCases('GPS clean-up only removes or nudges points, never invents or reorders them', async (r) => {
  const g = randomCity(r);
  const w = randomWalk(r, g, { noise: r.range(0, 20) });
  let steps = 0;
  const pts = w.points.map((p) => [...p, r.range(5, 30), (steps += r.int(0, 4))]);
  const out = cleanTrack(pts);
  const times = new Set(pts.map((p) => p[2]));
  for (let i = 0; i < out.length; i++) {
    assert.ok(times.has(out[i][2]), 'a point with a new time appeared');
    if (i) assert.ok(out[i][2] > out[i - 1][2], 'points out of order');
    assert.ok(Number.isFinite(out[i][0]) && Number.isFinite(out[i][1]), 'NaN position');
  }
  // Nudged by at most a little more than the noise, except dropped spikes.
  const byTime = new Map(pts.map((p) => [p[2], p]));
  for (const p of out) assert.ok(haversine(p, byTime.get(p[2])) < 120, 'a point moved more than 120 m');
  // Walking (about one step per 0.75 m) is never taken for a ride.
  let walked = 0;
  const withSteps = w.points.map((p, i) => {
    if (i) walked += haversine(w.points[i - 1], p);
    return [...p, 8, Math.round(walked / 0.75)];
  });
  const spikeFree = withSteps.filter((p, i) => i === 0 || haversine(withSteps[i - 1], p) < 60);
  assert.equal(dropRides(spikeFree).length, spikeFree.length, 'walking was taken for a ride');
});

// ---- walk details, trimming, steps -------------------------------------------------------

forCases('walk numbers add up, and trimming can always be undone', async (r) => {
  const g = randomCity(r);
  const w = randomWalk(r, g, { noise: r.range(0, 8) });
  if (w.points.length < 3) return; // the app only offers trimming on real walks
  const d = walkDetails(w.points);
  assert.ok(Math.abs(d.distance - polylineLength(w.points)) < 0.01);
  assert.ok(d.movingMs <= d.totalMs + 1, 'moving time longer than the walk');
  const splitSum = d.splits.reduce((n, s) => n + s.ms, 0);
  assert.ok(splitSum <= d.totalMs + 1, 'splits add up to more than the walk');
  const track = { id: 1, startedAt: w.points[0][2], endedAt: w.points[w.points.length - 1][2], points: w.points };
  const i0 = r.int(0, w.points.length - 2), i1 = r.int(i0 + 1, w.points.length - 1);
  const cut = trimWalk(track, i0, i1);
  assert.equal(cut.points.length, i1 - i0 + 1);
  assert.ok(cut.startedAt <= cut.endedAt);
  const again = trimWalk(cut, 0, w.points.length - 1);
  assert.equal(again.points.length, w.points.length, 're-trimming should work on the original');
  assert.deepEqual(untrimWalk(cut).points, w.points);
});

forCases('steps are never negative and survive pedometer restarts', async (r) => {
  const pts = [];
  let s = 0, total = 0;
  for (let i = 0; i < 60; i++) {
    if (r.next() < 0.05) s = 0; // restart
    const inc = r.int(0, 5);
    if (i && s + inc >= s) total += pts.length && pts[pts.length - 1][5] <= s + inc && s !== 0 ? inc : 0;
    s += inc;
    pts.push([0, 0, i, 5, 1, r.next() < 0.05 ? -1 : s]);
  }
  const n = stepsOf(pts);
  assert.ok(n == null || n >= 0);
});

test('the property tests checked real cases', () => {
  for (const name of ['end-to-end blocks', 'walked blocks checked for distance', 'blocks traced', 'match steps', 'points removed by areas']) {
    assert.ok((checked.get(name) || 0) >= CASES, `only ${checked.get(name) || 0} ${name}`);
  }
  if (process.env.PROPERTY_REPORT) console.log(Object.fromEntries(checked));
});

// ---- odd inputs: nothing may crash or turn into NaN ----------------------------------

forCases('odd walks (no times, repeated times, U-turns, tiny, all inside an area) never crash or give NaN', async (r) => {
  const g = randomCity(r);
  const base = randomWalk(r, g, { noise: r.range(0, 10) }).points;
  const variants = {
    noTimes: base.map(([la, lo]) => [la, lo]),
    nullTimes: base.map(([la, lo]) => [la, lo, null]),
    repeatedTimes: base.map(([la, lo, t], i) => [la, lo, t - (i % 3) * 1000]),
    reversedTimes: base.map(([la, lo], i) => [la, lo, (base.length - i) * 1000]),
    uTurns: [...base, ...[...base].reverse().map(([la, lo], i) => [la, lo, base[base.length - 1][2] + (i + 1) * 2000])],
    onePoint: [base[0]],
    twoSame: [base[0], [base[0][0], base[0][1], base[0][2] + 1000]],
    empty: [],
  };
  const zone = { id: 'all', name: 'All', lat: LAT0, lon: LON0, r: 50000 };
  const finite = (x, what) => assert.ok(x == null || Number.isFinite(x), `${what} is ${x}`);
  for (const [name, points] of Object.entries(variants)) {
    const track = { id: 1, startedAt: 0, points };
    // Coverage and matching.
    const city = await cityFor(g, points.length ? [track] : []);
    for (const id of walkedSet(city)) finite(city.fraction(id), `${name}: coverage`);
    const s = city.summary();
    finite(s.walkedLength, `${name}: walked length`);
    // Clean-up, details, trim.
    for (const p of cleanTrack(points.map((p) => [...p]))) { finite(p[0], `${name}: lat`); finite(p[1], `${name}: lon`); }
    if (points.length) {
      const d = walkDetails(points);
      for (const k of ['distance', 'totalMs', 'movingMs', 'pace']) finite(d[k], `${name}: ${k}`);
    }
    if (points.length >= 2) {
      const cut = trimWalk({ ...track, startedAt: 0, endedAt: 0 }, 0, 1);
      finite(cut.distance, `${name}: trimmed distance`);
      finite(cut.duration, `${name}: trimmed duration`);
    }
    // Entirely inside a no-tracking area.
    const z = withoutZones(track, [zone]);
    assert.equal(z.points.length, 0, `${name}: points left inside the area`);
    const zc = await cityFor(g, [z]);
    assert.equal(walkedSet(zc).size, 0, `${name}: blocks counted from a walk entirely inside an area`);
  }
});

test('a very long walk (5 hours, one fix a second) is matched in reasonable time', async () => {
  const r = rng(424242);
  const g = randomCity(r);
  let points = [];
  let t = 0;
  while (points.length < 18000) {
    const w = randomWalk(r, g, { noise: 6, extras: false, t0: t });
    points = points.concat(w.points);
    t = points[points.length - 1][2] + 1000;
  }
  const started = performance.now();
  const city = await cityFor(g, [{ id: 1, startedAt: 0, points }]);
  const ms = performance.now() - started;
  assert.ok(walkedSet(city).size > 0);
  assert.ok(ms < 8000, `took ${Math.round(ms)} ms`);
});
