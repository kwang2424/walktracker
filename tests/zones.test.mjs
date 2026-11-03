import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inZone, withoutZones, circleRing } from '../js/zones.js';

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
