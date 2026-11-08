import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrack, dropRides, isRiding, LiveFilter } from '../js/track.js';
import { haversine } from '../js/geo.js';

// A walk east along a street at 1.4 m/s, one fix a second, with seeded noise.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const M_LON = 1 / (111320 * Math.cos((40.73 * Math.PI) / 180)); // degrees per meter east
const walk = (n, { noise = 0, t0 = 0, steps0 = 0, x0 = 0 } = {}) => Array.from({ length: n }, (_, i) => [
  40.73 + (rand() * noise) / 111320,
  -73.99 + (x0 + 1.4 * i + rand() * noise) * M_LON,
  t0 + i * 1000,
  8,
  steps0 + Math.round(i * 1.8),
]);
const offStreet = (p) => Math.abs(p[0] - 40.73) * 111320; // meters from the street's centerline

test('a ride (far, no steps) is dropped; walking before and after is kept', () => {
  const before = walk(60);
  const last = before[before.length - 1];
  // 3 minutes on a train: 10 m/s, steps don't move.
  const ride = Array.from({ length: 18 }, (_, i) => [40.73, last[1] + (i + 1) * 100 * M_LON, last[2] + (i + 1) * 10000, 15, last[4]]);
  const end = ride[ride.length - 1];
  const after = walk(60, { t0: end[2] + 1000, steps0: end[4], x0: (end[1] + 73.99) / M_LON });
  const kept = dropRides([...before, ...ride, ...after]);
  // At most the first train fix slips through (it's at train speed, which the
  // coverage check ignores anyway).
  assert.ok(kept.filter((p) => ride.includes(p)).length <= 1);
  assert.ok(kept.filter((p) => before.includes(p)).length === 60);
  assert.ok(kept.filter((p) => after.includes(p)).length >= 55); // a few right after the ride may go
});

test('no step counts (browser, old walks): nothing is treated as a ride', () => {
  const pts = walk(30).map((p) => p.slice(0, 3));
  pts.push([40.73, -73.98, 31000]);
  assert.equal(dropRides(pts).length, pts.length);
  assert.equal(isRiding(pts[0], pts[30]), false);
});

test('smoothing pulls a noisy walk closer to the street', () => {
  const noisy = walk(120, { noise: 24 });
  const smooth = cleanTrack(noisy);
  const avg = (ps) => ps.reduce((s, p) => s + offStreet(p), 0) / ps.length;
  assert.ok(smooth.length >= 110);
  assert.ok(avg(smooth) < avg(noisy) * 0.7, `raw ${avg(noisy).toFixed(1)} m, smoothed ${avg(smooth).toFixed(1)} m`);
});

test('a single far-off fix is dropped as a spike, the walk carries on', () => {
  const pts = walk(40);
  pts[20] = [40.7312, pts[20][1], pts[20][2], 8, pts[20][4]]; // ~130 m off for one second
  const smooth = cleanTrack(pts);
  assert.ok(smooth.length >= 38, `${smooth.length} points`); // the spike, maybe one neighbor
  assert.ok(Math.max(...smooth.map(offStreet)) < 5);
});

test('a real jump (several fixes agreeing) is accepted, not rejected forever', () => {
  const a = walk(20);
  const b = walk(20, { t0: 20000, x0: 400 }); // 370 m further on after a second
  const f = new LiveFilter();
  const out = [...a, ...b].map((p) => f.push(p)).filter(Boolean);
  const lastOut = out[out.length - 1];
  assert.ok(haversine(lastOut, b[b.length - 1]) < 10);
});

test('points keep their time; smoothing does not invent points', () => {
  const pts = walk(10, { noise: 5 });
  const out = cleanTrack(pts);
  assert.deepEqual(out.map((p) => p[2]), pts.map((p) => p[2]));
});

test('a bike ride right after walking is noticed within seconds', () => {
  // 40 s of walking (steps), then a bike at 5 m/s with no steps.
  const walking = walk(40);
  const last = walking[walking.length - 1];
  const bike = Array.from({ length: 30 }, (_, i) => [40.73, last[1] + (i + 1) * 5 * M_LON, last[2] + (i + 1) * 1000, 8, last[4]]);
  const kept = dropRides([...walking, ...bike]);
  assert.equal(kept.filter((p) => walking.includes(p)).length, walking.length);
  assert.ok(kept.filter((p) => bike.includes(p)).length <= 12, `${kept.filter((p) => bike.includes(p)).length} bike points kept`);
});
