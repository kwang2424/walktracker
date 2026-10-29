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
