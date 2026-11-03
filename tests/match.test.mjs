import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCity } from '../scripts/citylib.mjs';
import { City } from '../js/city.js';
import { CoverageEngine } from '../js/geo.js';
import { StreetGraph, matchWalk } from '../js/match.js';

// A small grid in meters around (40.73, -73.99):
//   Main St along y=0 and Side St along y=20 (a parallel street only 20 m away),
//   both from x=0 to x=400; avenues at x=0, 200, 400 from y=-150 to y=20, plus
//   Lower St along y=-150.
const LAT0 = 40.73, LON0 = -73.99;
const MY = 1 / 111320, MX = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const at = (x, y) => [LAT0 + y * MY, LON0 + x * MX];
const nodes = [];
const ways = [];
let nid = 1;
const node = (x, y) => { nodes.push([nid, ...at(x, y)]); return nid++; };
const grid = {};
for (const x of [0, 200, 400]) for (const y of [-150, 0, 20]) grid[`${x},${y}`] = node(x, y);
ways.push([1, [grid['0,0'], grid['200,0'], grid['400,0']], 'Main St', 'residential']);
ways.push([2, [grid['0,20'], grid['200,20'], grid['400,20']], 'Side St', 'residential']);
ways.push([3, [grid['0,-150'], grid['200,-150'], grid['400,-150']], 'Lower St', 'residential']);
for (const [i, x] of [0, 200, 400].entries()) ways.push([10 + i, [grid[`${x},-150`], grid[`${x},0`], grid[`${x},20`]], `Avenue ${i}`, 'residential']);
const raw = { nodes, ways };
const hoodsGeo = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { id: 'T1', name: 'Test', borough: 'Testboro', type: 0 },
    geometry: { type: 'MultiPolygon', coordinates: [[[[LON0 - 0.01, LAT0 - 0.01], [LON0 + 0.02, LAT0 - 0.01], [LON0 + 0.02, LAT0 + 0.01], [LON0 - 0.01, LAT0 + 0.01], [LON0 - 0.01, LAT0 - 0.01]]]] } }],
};

async function cityWith(walks) {
  const built = buildCity(raw, hoodsGeo);
  const files = { 'index.json': built.index, 'hoods/T1.json': built.files.T1 };
  const fetchImpl = async (url) => {
    const path = url.replace(/^.*?data\/nyc\//, '').replace(/\?.*$/, '');
    return { ok: true, status: 200, json: async () => structuredClone(files[path]) };
  };
  const city = await new City({ fetchImpl }).init();
  const tracks = walks.map((points, i) => ({ id: i + 1, startedAt: i * 1e6, points }));
  await city.ensure(city.setTracks(tracks));
  city.refreshMatches();
  return city;
}
const walked = (city, name) => city.loaded.get('T1').blocks.filter((b) => b.name === name && city.isWalked(b.id)).length;
const blocksOf = (city, name) => city.loaded.get('T1').blocks.filter((b) => b.name === name).length;

// A walk from (x0, y) to (x1, y), one fix every 2 s at 1.4 m/s, wobbling ±wob m.
const along = (x0, x1, y, { wob = 0, t0 = 0 } = {}) => {
  const n = Math.round(Math.abs(x1 - x0) / 2.8);
  return Array.from({ length: n + 1 }, (_, i) => [...at(x0 + ((x1 - x0) * i) / n, y + (i % 2 ? wob : -wob)), t0 + i * 2000]);
};

test('walking Main St does not also complete Side St 20 m away', async () => {
  // GPS drifts toward Side St: 8 m off Main St on average.
  const city = await cityWith([along(0, 400, 8, { wob: 3 })]);
  assert.equal(walked(city, 'Main St'), blocksOf(city, 'Main St'));
  assert.equal(walked(city, 'Side St'), 0);
});

test('without map matching the simple rule would have credited Side St', () => {
  const built = buildCity(raw, hoodsGeo);
  const e = new CoverageEngine();
  const blocks = built.files.T1.blocks.map(([id, ni, flat]) => {
    const coords = []; for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
    return { id, name: built.files.T1.names[ni], coords };
  });
  e.setBlocks(blocks);
  e.addTrack(along(0, 400, 8, { wob: 3 }));
  assert.ok(blocks.filter((b) => b.name === 'Side St' && e.isWalked(b.id)).length > 0);
});

test('a GPS dropout in the middle of a block is filled in along the street', async () => {
  // Walk Lower St, but no fixes between x=60 and x=150.
  const pts = along(0, 200, -150).filter(([lat, lon]) => { const x = (lon - LON0) / MX; return x < 60 || x > 150; });
  const city = await cityWith([pts]);
  const first = city.loaded.get('T1').blocks.find((b) => b.name === 'Lower St' && b.coords[0][1] < LON0 + 1 * MX);
  assert.ok(city.isWalked(first.id), `fraction ${city.fraction(first.id)}`);
});

test('cutting the corner still counts both streets at the corner', async () => {
  // Down Avenue 0 from y=0 to y=-110, cut diagonally to (40, -150), then along Lower St.
  const t = (i) => i * 2000;
  const pts = [];
  for (let y = 0; y >= -110; y -= 3) pts.push([...at(0, y), t(pts.length)]);
  for (let k = 1; k <= 10; k++) pts.push([...at(4 * k, -110 - 4 * k), t(pts.length)]);
  for (let x = 43; x <= 200; x += 3) pts.push([...at(x, -150), t(pts.length)]);
  const city = await cityWith([pts]);
  const ave = city.loaded.get('T1').blocks.find((b) => b.name === 'Avenue 0' && Math.min(...b.coords.map((c) => c[0])) < LAT0 - 100 * MY);
  assert.ok(city.isWalked(ave.id), `Avenue 0 fraction ${city.fraction(ave.id)}`);
  assert.ok(walked(city, 'Lower St') >= 1);
});

test('a ride along a street (too fast) is not counted', async () => {
  const fast = along(0, 400, -150).map((p, i) => [p[0], p[1], i * 200]); // 14 m/s
  const city = await cityWith([fast]);
  assert.equal(walked(city, 'Lower St'), 0);
});

test('points far from any street match nothing', () => {
  const g = new StreetGraph();
  g.add([{ id: '1:1-2:0', name: 'A', coords: [at(0, 0), at(100, 0)] }]);
  assert.deepEqual(matchWalk(g, [[...at(50, 300), 0], [...at(60, 300), 10000]]), []);
});

test('a break in a walk (a no-tracking area) is never filled in', async () => {
  // Walk Lower St with a break where an area removed x=60..150.
  const pts = along(0, 200, -150).filter(([lat, lon]) => { const x = (lon - LON0) / MX; return x < 60 || x > 150; });
  const breakAt = pts.findIndex(([, lon]) => (lon - LON0) / MX > 150);
  const built = buildCity(raw, hoodsGeo);
  const files = { 'index.json': built.index, 'hoods/T1.json': built.files.T1 };
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => structuredClone(files[url.replace(/^.*?data\/nyc\//, '').replace(/\?.*$/, '')]) });
  const city = await new City({ fetchImpl }).init();
  await city.ensure(city.setTracks([{ id: 1, startedAt: 0, points: pts, breaks: [breakAt] }]));
  city.refreshMatches();
  const first = city.loaded.get('T1').blocks.find((b) => b.name === 'Lower St' && b.coords[0][1] < LON0 + 1 * MX);
  assert.equal(city.isWalked(first.id), false, `fraction ${city.fraction(first.id)}`);
});
