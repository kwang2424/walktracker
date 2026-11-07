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
    // 222 m north at walking pace, a fix every ~4 m (as the phone sends them).
    points: Array.from({ length: 56 }, (_, i) => [40.73 + (0.002 * i) / 55, -73.99, t0 + i * 3000]),
  });
  assert.equal(t.source, 'auto');
  assert.equal(t.nativeId, 'ABC');
  assert.equal(t.duration, 600000);
  assert.equal(t.points.length, 56);
  assert.ok(Math.abs(t.distance - 222.4) < 9, `distance ${t.distance}`);
  assert.equal(t.breaks, undefined);
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

test('steps during an automatic walk add up across pedometer restarts', async () => {
  const { stepsOf } = await import('../js/native.js');
  // index 5: running count; it restarts at 0 halfway (GPS turned off and on).
  const pts = [[0, 0, 0, 5, 1, 0], [0, 0, 1, 5, 1, 40], [0, 0, 2, 5, 1, 90], [0, 0, 3, 5, 1, 0], [0, 0, 4, 5, 1, 30], [0, 0, 5, 5, 1, -1]];
  assert.equal(stepsOf(pts), 120);
  assert.equal(stepsOf([[0, 0, 0, 5, 1, -1]]), null);
});
