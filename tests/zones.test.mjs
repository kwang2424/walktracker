import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inZone, withoutZones, circleRing, runsOf } from '../js/zones.js';

const office = { id: 'z1', name: 'Office', lat: 40.7500, lon: -73.9900, r: 150 };

test('points inside a no-tracking area are left out of a walk, others kept', () => {
  const t = { id: 7, startedAt: 1, points: [[40.7400, -73.99, 0], [40.7495, -73.99, 1], [40.7505, -73.9905, 2], [40.7600, -73.99, 3]] };
  const out = withoutZones(t, [office]);
  assert.deepEqual(out.points.map((p) => p[2]), [0, 3]);
  assert.equal(out.id, 7);
  assert.equal(t.points.length, 4); // the saved walk isn't changed
});

test('no areas, or nothing inside them: the same walk object', () => {
  const t = { id: 1, points: [[40.70, -73.99, 0]] };
  assert.equal(withoutZones(t, []), t);
  assert.equal(withoutZones(t, [office]), t);
});

test('the circle drawn matches the area', () => {
  const ring = circleRing(office);
  assert.ok(ring.every(([lon, lat]) => Math.abs(Math.hypot((lat - 40.75) * 111320, (lon + 73.99) * 111320 * Math.cos(40.75 * Math.PI / 180)) - 150) < 1));
  assert.equal(inZone([40.7513, -73.99], [office]), true);
  assert.equal(inZone([40.7515, -73.99], [office]), false);
});

test('a block-shaped area: inside, a few meters outside, and well outside', () => {
  const M = 1 / 111320, MX = 1 / (111320 * Math.cos((40.73 * Math.PI) / 180));
  const at = (x, y) => [40.73 + y * M, -73.99 + x * MX];
  const block = { id: 'b', name: 'Work', lat: 40.73, lon: -73.99, ring: [at(0, 0), at(200, 0), at(200, 80), at(0, 80), at(0, 0)], pad: 8 };
  assert.equal(inZone(at(100, 40), [block]), true); // inside
  assert.equal(inZone(at(100, -5), [block]), true); // on the street edge
  assert.equal(inZone(at(100, -20), [block]), false); // across the street
  assert.equal(inZone(at(260, 40), [block]), false);
});

test('where an area removes points, the walk gets a break there', () => {
  const t = { id: 1, points: [[40.740, -73.99, 0], [40.7495, -73.99, 1], [40.7505, -73.99, 2], [40.760, -73.99, 3], [40.761, -73.99, 4]], breaks: [4] };
  const out = withoutZones(t, [office]);
  assert.deepEqual(out.points.map((p) => p[2]), [0, 3, 4]);
  assert.deepEqual(out.breaks, [1, 2]); // the area's gap, and the walk's own break (old index 4)
  assert.deepEqual(runsOf(out).map((r) => r.map((p) => p[2])), [[0], [3], [4]]);
  assert.deepEqual(runsOf({ points: [[0, 0, 1], [0, 0, 2]] }).length, 1);
});
