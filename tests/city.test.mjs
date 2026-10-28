import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCity, pointInMultiPolygon, simplifyRing } from '../scripts/citylib.mjs';
import { readFileSync } from 'node:fs';
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
    const path = url.replace(/^.*?data\/nyc\//, '');
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
