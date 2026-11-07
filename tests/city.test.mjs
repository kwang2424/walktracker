import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCity, pointInMultiPolygon, simplifyRing } from '../scripts/citylib.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { City, overrideWalked } from '../js/city.js';
import { WALKABLE_HIGHWAYS } from '../js/geo.js';

// Two side-by-side square "neighborhoods" (West and East) split at lon -73.99,
// with a street grid running through both:
//   rows (E-W streets) at lat 40.730 / 40.731,  columns at lon -73.996 / -73.993 / -73.990 / -73.987 / -73.984
const LAT = [40.730, 40.731];
const LON = [-73.996, -73.993, -73.990, -73.987, -73.984];
const nid = (r, c) => 100 + r * 10 + c;
const raw = { nodes: [], ways: [] };
LAT.forEach((la, r) => LON.forEach((lo, c) => raw.nodes.push([nid(r, c), la, lo])));
LAT.forEach((_, r) => raw.ways.push([1000 + r, LON.map((_, c) => nid(r, c)), `Street ${r}`, 'residential']));
LON.forEach((_, c) => raw.ways.push([2000 + c, LAT.map((_, r) => nid(r, c)), `Avenue ${c}`, 'residential']));
// A street outside both neighborhoods (should be dropped).
raw.nodes.push([900, 40.8, -73.9], [901, 40.801, -73.9]);
raw.ways.push([3000, [900, 901], 'Far Rd', 'residential']);

const square = (id, name, w, e) => ({
  type: 'Feature',
  properties: { id, name, borough: 'Testboro', type: 0 },
  geometry: { type: 'MultiPolygon', coordinates: [[[[w, 40.725], [e, 40.725], [e, 40.736], [w, 40.736], [w, 40.725]]]] },
});
const hoodsGeo = { type: 'FeatureCollection', features: [square('W1', 'West', -74.0, -73.99), square('E1', 'East', -73.99, -73.98)] };

function serve(city) {
  const files = {
    'index.json': city.index,
    ...Object.fromEntries(Object.entries(city.files).map(([id, f]) => [`hoods/${id}.json`, f])),
  };
  const requests = [];
  const fetchImpl = async (url) => {
    const path = url.replace(/^.*?data\/nyc\//, '').replace(/\?.*$/, '');
    requests.push(path);
    return { ok: path in files, status: path in files ? 200 : 404, json: async () => structuredClone(files[path]) };
  };
  return { fetchImpl, requests };
}

const walkAlongRow = (r, c0, c1, t0 = 0) => {
  const pts = [];
  for (let i = 0; i <= 30; i++) pts.push([LAT[r], LON[c0] + ((LON[c1] - LON[c0]) * i) / 30, t0 + i * 8000]);
  return pts;
};

test('pointInMultiPolygon handles holes', () => {
  const donut = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]];
  assert.equal(pointInMultiPolygon([2, 2], donut), true);
  assert.equal(pointInMultiPolygon([5, 5], donut), false);
  assert.equal(pointInMultiPolygon([20, 5], donut), false);
});

test('simplifyRing drops points on straight edges but keeps corners', () => {
  const ring = [[0, 0], [5, 0.00001], [10, 0], [10, 10], [0, 10], [0, 0]];
  assert.deepEqual(simplifyRing(ring, 0.001), [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
});

test('buildCity files every block under the neighborhood holding its midpoint', () => {
  const city = buildCity(raw, hoodsGeo);
  assert.deepEqual(city.index.hoods.map((h) => h.id), ['W1', 'E1']);
  // 2 rows x 4 segments + 5 columns x 1 segment = 13 blocks; the far road is outside.
  assert.equal(city.index.total.blocks, 13);
  assert.equal(city.outside, 1);
  const w = city.index.hoods.find((h) => h.id === 'W1');
  assert.ok(w.bbox[3] >= -73.99, 'box grows to cover blocks that cross the boundary');
  const st = city.streets.find(([name, boro]) => name === 'Street 0' && boro === 'Testboro');
  assert.equal(st[2], 4);
  assert.deepEqual(st[4].sort(), [0, 1], 'Street 0 runs through both neighborhoods');
  assert.equal(city.outlines.features.length, 2);
});

test('City loads only the neighborhoods your walks touch and tracks progress', async () => {
  const built = buildCity(raw, hoodsGeo);
  const { fetchImpl, requests } = serve(built);
  const city = await new City({ fetchImpl }).init();
  // A walk along Street 0 through the West neighborhood only.
  const tracks = [{ id: 1, startedAt: 1000, points: walkAlongRow(0, 0, 2) }];
  const ids = city.setTracks(tracks);
  assert.ok(ids.includes('W1'), 'the walk is in West');
  assert.equal(requests.filter((r) => r.startsWith('hoods/')).length, 0, 'nothing loaded until asked');
  await city.ensure(ids);
  const s = city.summary();
  assert.equal(s.blocks, 13);
  assert.equal(s.walked, 2, 'two blocks of Street 0 walked');
  const west = s.hoods.find((h) => h.id === 'W1');
  assert.equal(west.walked, 2);
  assert.equal(s.boroughs[0].walked, 2);
  assert.equal(city.newByTrack.get(1), 2);
  assert.equal(city.completedAt.size, 2);
  const streets = city.streetProgress();
  assert.equal(streets.get('Street 0|Testboro').walked, 2);
});

test('live segments update loaded neighborhoods and load new ones', async () => {
  const built = buildCity(raw, hoodsGeo);
  const { fetchImpl } = serve(built);
  const loadedIds = [];
  const city = await new City({ fetchImpl, onLoad: (id) => loadedIds.push(id) }).init();
  city.setTracks([]);
  await city.ensure(['W1']);
  const live = walkAlongRow(1, 2, 4, 50000);
  city.startLive(live);
  // Walk east along Street 1 into the East neighborhood (not loaded yet).
  let changed = new Set();
  for (let i = 1; i < live.length; i++) for (const id of city.addLiveSegment(live[i - 1], live[i])) changed.add(id);
  await city.ensure(['E1']); // the live walk replays into it on load
  assert.deepEqual(loadedIds, ['W1', 'E1']);
  const east = city.hoodProgress('E1');
  assert.equal(east.walked, 2, 'East picked up the live walk when it loaded');
});

test('overrides count and old boolean overrides still work', async () => {
  const built = buildCity(raw, hoodsGeo);
  const { fetchImpl } = serve(built);
  const city = await new City({ fetchImpl }).init();
  city.setTracks([]);
  await city.ensure(['W1']);
  const someBlock = city.loaded.get('W1').blocks[0].id;
  assert.equal(city.summary({ [someBlock]: { walked: true, hood: 'W1' } }).walked, 1);
  assert.equal(city.summary({ [someBlock]: true }).walked, 1);
  assert.equal(overrideWalked({ walked: false }), false);
});

test('the street types in the extract script match the app', () => {
  const py = readFileSync(new URL('../scripts/extract_streets.py', import.meta.url), 'utf8');
  const block = py.match(/WALKABLE = \{([\s\S]*?)\}/)[1];
  const fromPy = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(fromPy, [...WALKABLE_HIGHWAYS].sort());
});

test('the extract script keeps streets people walk along, and paths apart', (t) => {
  const cases = [
    // [tags, kept?]
    [{ highway: 'residential' }, true],
    [{ highway: 'residential', access: 'private' }, null],
    [{ highway: 'tertiary', access: 'no', bus: 'yes', foot: 'yes' }, true], // Fulton Mall
    [{ highway: 'primary', foot: 'no' }, null], // a roadway you can't walk along
    [{ highway: 'primary', foot: 'no', 'sidewalk:both': 'separate' }, true], // Grand Concourse
    [{ highway: 'trunk' }, true], // Linden Boulevard
    [{ highway: 'trunk', foot: 'use_sidepath' }, true], // West Street
    [{ highway: 'trunk', sidewalk: 'no' }, null],
    [{ highway: 'trunk', motorroad: 'yes' }, null],
    [{ highway: 'trunk', foot: 'no' }, null], // Queensboro Bridge roadway
    [{ highway: 'motorway' }, null],
    [{ highway: 'pedestrian', area: 'yes' }, 'plaza'], // kept as a path (outline), not a street
    [{ highway: 'service', service: 'alley', name: 'Cortlandt Alley' }, true],
    [{ highway: 'service', service: 'alley' }, null],
    [{ highway: 'service', name: 'Ring Road' }, null],
    [{ highway: 'service', service: 'driveway' }, null],
    [{ highway: 'footway', name: 'High Line' }, 'path'], // paths: tracked apart from streets
    [{ highway: 'path' }, 'path'],
    [{ highway: 'cycleway', foot: 'designated', name: 'Hudson River Greenway' }, 'path'],
    [{ highway: 'cycleway' }, null],
    [{ highway: 'footway', footway: 'sidewalk' }, null], // belongs to its street
    [{ highway: 'footway', footway: 'crossing' }, null],
    [{ highway: 'footway', access: 'private' }, null],
    [{ highway: 'steps' }, null],
  ];
  const script = `
import json, sys, types
sys.modules['osmium'] = types.SimpleNamespace(SimpleHandler=object)
sys.path.insert(0, sys.argv[2])
from extract_streets import walkable, path_kind
print(json.dumps([walkable(t) or path_kind(t) for t, _ in json.loads(sys.argv[1])]))`;
  let out;
  try {
    out = execFileSync('python3', ['-c', script, JSON.stringify(cases), fileURLToPath(new URL('../scripts', import.meta.url))], { encoding: 'utf8' });
  } catch {
    t.skip('python3 not available');
    return;
  }
  const got = JSON.parse(out);
  cases.forEach(([tags, want], i) => assert.equal(got[i], want, JSON.stringify(tags)));
});

test('paths are kept apart from streets: their own progress, never block counts', async () => {
  const withPaths = structuredClone(raw);
  // A park path between the two rows (~55 m from either street), across West.
  withPaths.nodes.push([500, 40.7305, -73.9995], [501, 40.7305, -73.9915]);
  // A path hugging Street 0 (an untagged sidewalk): dropped.
  withPaths.nodes.push([510, 40.73003, -73.9955], [511, 40.73003, -73.9915]);
  // A named plaza outline and an unnamed one (unnamed plazas are dropped).
  withPaths.nodes.push([520, 40.7302, -73.9890], [521, 40.7302, -73.9885], [522, 40.7304, -73.9885]);
  withPaths.paths = [
    [5000, [500, 501], 'Park Walk', 'path'],
    [5001, [510, 511], '', 'path'],
    [5002, [520, 521, 522, 520], 'Test Square', 'plaza'],
    [5003, [520, 522], '', 'plaza'],
  ];
  const built = buildCity(withPaths, hoodsGeo);
  const west = built.files.W1;
  assert.deepEqual(west.paths.map((p) => west.names[p[1]]), ['Park Walk']);
  assert.deepEqual(built.files.E1.paths.map((p) => [built.files.E1.names[p[1]], p[3]]), [['Test Square', 1]]);
  assert.equal(built.index.total.blocks, buildCity(raw, hoodsGeo).index.total.blocks);
  assert.ok(built.index.total.pathLength > 600);

  const { fetchImpl } = serve(built);
  const city = await new City({ fetchImpl }).init();
  const walk = [];
  for (let i = 0; i <= 30; i++) walk.push([40.7305, -73.9995 + (0.008 * i) / 30, i * 8000]);
  await city.ensure(city.setTracks([{ id: 1, startedAt: 0, points: walk }]));
  const pathId = city.loaded.get('W1').paths[0].id;
  assert.ok(city.isPath(pathId));
  assert.equal(city.isWalked(pathId), true);
  const s = city.summary();
  // Street numbers are exactly what the same walk gives without any paths.
  const plain = await new City({ fetchImpl: serve(buildCity(raw, hoodsGeo)).fetchImpl }).init();
  await plain.ensure(plain.setTracks([{ id: 1, startedAt: 0, points: walk }]));
  assert.equal(s.walked, plain.summary().walked);
  assert.equal(city.newByTrack.get(1), plain.newByTrack.get(1));
  assert.ok(s.pathWalkedLength > 600);
  assert.equal(s.hoods.find((h) => h.id === 'W1').pathWalkedLength, s.pathWalkedLength);
});

test('walks re-matched once their neighborhoods load are counted once', async () => {
  const built = buildCity(raw, hoodsGeo);
  const { fetchImpl } = serve(built);
  const city = await new City({ fetchImpl }).init();
  // A walk along Street 0 across both neighborhoods; only West loaded at first,
  // so it counts the simple way until East arrives and it's map-matched.
  const walk = { id: 9, startedAt: 0, points: walkAlongRow(0, 0, 4) };
  city.setTracks([walk]);
  await city.ensure(['W1']);
  assert.ok(city.loaded.get('W1').fallback, 'West counted the simple way first');
  await city.ensure(['E1']);
  city.refreshMatches();
  const walked = city.loadedBlocks().filter((b) => city.isWalked(b.id));
  assert.ok(walked.length > 0);
  // Every "first finished" entry is a walked block, and the walk's new-block
  // tally is exactly the blocks it finished: nothing left over from before.
  for (const id of city.completedAt.keys()) assert.ok(city.isWalked(id), `${id} recorded as finished but isn't walked`);
  assert.equal(city.newByTrack.get(9), walked.length);
  assert.equal(city.completedAt.size, walked.length);
  // Doing it again changes nothing.
  for (const e of city.loaded.values()) e.fallback = true;
  city.refreshMatches();
  assert.equal(city.newByTrack.get(9), walked.length);
});
