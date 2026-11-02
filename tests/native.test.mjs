import { test } from 'node:test';
import assert from 'node:assert/strict';
import { native, nativeWalkToTrack } from '../js/native.js';

test('outside the iPhone app there is no native bridge', () => {
  assert.equal(native, null);
});

test('a walk recorded by the phone becomes a saved walk', () => {
  const t0 = Date.UTC(2026, 9, 29, 14, 0);
  const t = nativeWalkToTrack({
    id: 'ABC',
    startedAt: t0,
    endedAt: t0 + 600000,
    points: [[40.73, -73.99, t0], [40.731, -73.99, t0 + 300000], [40.732, -73.99, t0 + 600000]],
  });
  assert.equal(t.source, 'auto');
  assert.equal(t.nativeId, 'ABC');
  assert.equal(t.duration, 600000);
  assert.equal(t.points.length, 3);
  assert.ok(Math.abs(t.distance - 222.4) < 1, `distance ${t.distance}`);
  assert.match(t.name, /^Walk on /);
});

test('Wi-Fi/cell positions and train-speed fixes are left out of auto walks', () => {
  const t0 = Date.UTC(2026, 10, 2, 9, 0);
  const t = nativeWalkToTrack({
    id: 'SUB',
    startedAt: t0,
    endedAt: t0 + 60000,
    points: [
      [40.73, -73.99, t0, 6, 1.4], // GPS while walking
      [40.7302, -73.99, t0 + 15000, 8, 1.3],
      [40.731, -73.99, t0 + 30000, 30, -1], // station Wi-Fi: rough and no speed
      [40.74, -73.99, t0 + 40000, 10, 12], // on the train
      [40.7304, -73.99, t0 + 50000, 60, 1], // far too rough
      [40.7306, -73.99, t0 + 60000, 5, 1.5],
    ],
  });
  assert.deepEqual(t.points.map((p) => p[2] - t0), [0, 15000, 60000]);
  assert.equal(t.points[0].length, 3);
});
