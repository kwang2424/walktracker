import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreetGraph } from '../js/match.js';
import { blockAround } from '../js/blockface.js';

// A 3x3 grid of streets 100 m apart (2x2 city blocks), plus a dead-end spur
// into the north-east block and a footpath across the south-west one.
const LAT0 = 40.73, LON0 = -73.99;
const MY = 1 / 111320, MX = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const at = (x, y) => [LAT0 + y * MY, LON0 + x * MX];
const node = (x, y) => `${x / 100}${y / 100}`;
const blocks = [];
let n = 0;
const street = (x0, y0, x1, y1, path = false) => blocks.push({ path, id: `${++n}:${node(x0, y0)}-${node(x1, y1)}:0`, name: path ? 'Path' : `S${n}`, coords: [at(x0, y0), at(x1, y1)] });
for (const y of [0, 100, 200]) { street(0, y, 100, y); street(100, y, 200, y); }
for (const x of [0, 100, 200]) { street(x, 0, x, 100); street(x, 100, x, 200); }
blocks.push({ id: `${++n}:21-99:0`, name: 'Spur', coords: [at(200, 150), at(160, 150)] }); // dead end off x=200 (node 21 isn't on the grid: a separate stub)
const g = new StreetGraph();
g.add(blocks.filter((b) => !b.path));
g.add([{ id: `${++n}:00-11:0`, name: 'Path', coords: [at(0, 0), at(100, 100)] }], { path: true });

const insideMeters = (ring) => ring.map(([la, lo]) => [(lo - LON0) / MX, (la - LAT0) / MY]);

test('tapping inside a block gives that block\'s four sides', () => {
  const ring = blockAround(g, at(40, 60));
  assert.ok(ring, 'found a block');
  const xy = insideMeters(ring);
  const xs = xy.map((p) => Math.round(p[0])), ys = xy.map((p) => Math.round(p[1]));
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 100, 0, 100]);
});

test('each of the four blocks is found, and footpaths do not split a block', () => {
  for (const [x, y] of [[50, 50], [150, 50], [50, 150], [150, 150]]) {
    const xy = insideMeters(blockAround(g, at(x, y)));
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    assert.ok(Math.min(...xs) <= x && Math.max(...xs) >= x && Math.min(...ys) <= y && Math.max(...ys) >= y);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 110 && Math.max(...ys) - Math.min(...ys) < 110);
  }
});

test('outside the grid there is no block', () => {
  assert.equal(blockAround(g, at(-60, 50)), null);
});
