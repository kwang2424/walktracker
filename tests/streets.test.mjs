import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { covers, tileKeys, clipToBbox, fetchFromPack, nearestPlace } from '../js/streets.js';
import { WALKABLE_HIGHWAYS } from '../js/geo.js';

const index = {
  tileDeg: 0.02,
  regions: [{ name: 'NYC', bounds: [40.47, -74.37, 40.98, -73.65] }],
  tiles: ['-3700_2036', '-3699_2036', '-3700_2037'],
  places: [
    [40.7368, -73.9845, 'Gramercy', 'neighbourhood'],
    [40.7831, -73.9712, 'Manhattan', 'borough'],
    [40.7128, -74.006, 'New York', 'city'],
  ],
};

test('covers only boxes fully inside a region', () => {
  assert.equal(covers(index, [40.73, -73.99, 40.74, -73.98]), true);
  assert.equal(covers(index, [40.73, -74.5, 40.74, -73.98]), false);
  assert.equal(covers(null, [40.73, -73.99, 40.74, -73.98]), false);
});

test('tileKeys lists only tiles that exist', () => {
  // lon -73.99 -> x -3700, -73.97 -> x -3699; lat 40.73 -> y 2036
  assert.deepEqual(tileKeys(index, [40.73, -73.995, 40.735, -73.975]).sort(), ['-3699_2036', '-3700_2036']);
  assert.deepEqual(tileKeys(index, [41.5, -73.99, 41.51, -73.98]), []);
});

test('clipToBbox keeps streets touching the box and only their nodes', () => {
  const els = [
    { type: 'node', id: 1, lat: 40.73, lon: -73.99 }, { type: 'node', id: 2, lat: 40.731, lon: -73.99 },
    { type: 'node', id: 3, lat: 40.9, lon: -73.9 }, { type: 'node', id: 4, lat: 40.91, lon: -73.9 },
    { type: 'way', id: 10, nodes: [1, 2] }, { type: 'way', id: 11, nodes: [3, 4] },
  ];
  const out = clipToBbox(els, [40.72, -74.0, 40.74, -73.98]);
  assert.deepEqual(out.filter((e) => e.type === 'way').map((e) => e.id), [10]);
  assert.deepEqual(out.filter((e) => e.type === 'node').map((e) => e.id).sort(), [1, 2]);
});

test('fetchFromPack merges tiles without duplicates', async () => {
  const shared = { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential' } };
  const tiles = {
    '-3700_2036': { elements: [{ type: 'node', id: 1, lat: 40.73, lon: -73.99 }, { type: 'node', id: 2, lat: 40.731, lon: -73.979 }, shared] },
    '-3699_2036': { elements: [{ type: 'node', id: 2, lat: 40.731, lon: -73.979 }, shared] },
  };
  const fakeFetch = async (url) => {
    const key = url.split('/').pop().replace('.json', '');
    return { ok: key in tiles, status: 404, json: async () => tiles[key] };
  };
  const osm = await fetchFromPack(index, [40.73, -73.995, 40.735, -73.975], fakeFetch);
  assert.equal(osm.elements.filter((e) => e.type === 'way').length, 1);
  assert.equal(osm.elements.filter((e) => e.type === 'node').length, 2);
});

test('nearestPlace prefers a close neighborhood, else a broader place', () => {
  assert.equal(nearestPlace(index, [40.737, -73.985]), 'Gramercy');
  assert.equal(nearestPlace(index, [40.76, -73.97]), 'Manhattan'); // 2.6 km from Gramercy
  assert.equal(nearestPlace(index, [41.5, -73.0]), '');
  assert.equal(nearestPlace(index, [40.737, -73.985], { broad: true }), 'Manhattan'); // borough beats city
});

test('the street types in the build script match the app', () => {
  const py = readFileSync(new URL('../scripts/build_streets.py', import.meta.url), 'utf8');
  const block = py.match(/WALKABLE = \{([\s\S]*?)\}/)[1];
  const fromPy = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(fromPy, [...WALKABLE_HIGHWAYS].sort());
});
