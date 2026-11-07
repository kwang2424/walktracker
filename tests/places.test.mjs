import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Places, ROUTE_ORDER } from '../js/places.js';

// A square landmark (~45 m a side) at 40.7400/-73.9900 and two station complexes.
const sq = [-73.9903, 40.7398, -73.9897, 40.7398, -73.9897, 40.7402, -73.9903, 40.7402, -73.9903, 40.7398];
const data = {
  landmarks: [['LP-1', 'Test Building', '1 Main St', '1/1/1966', 0, [sq]]],
  stations: [
    ['100', '14 St-Union Sq', ['4', '5', '6', 'L'], 'M', 0, [40.7349, -73.9906, 40.7347, -73.9897]],
    ['200', '1 Av', ['L'], 'M', 0, [40.7307, -73.9817]],
  ],
};
const places = new Places(data);
const walk = (from, to, n = 20, t0 = 0) => Array.from({ length: n + 1 }, (_, i) => [
  from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n, t0 + i * 10000]);

test('walking past a landmark counts; a block away does not', () => {
  // Along the sidewalk ~15 m east of its east side.
  const past = places.visits([{ startedAt: 1, points: walk([40.7390, -73.98952], [40.7410, -73.98952]) }]);
  assert.ok(past.has('L:LP-1'));
  // ~80 m east.
  const away = places.visits([{ startedAt: 1, points: walk([40.7390, -73.9890], [40.7410, -73.9890]) }]);
  assert.ok(!away.has('L:LP-1'));
});

test('stations count within 60 m of any platform', () => {
  const v = places.visits([{ startedAt: 1, points: walk([40.7340, -73.9893], [40.7360, -73.9893]) }]);
  assert.ok(v.has('S:100'));
  assert.ok(!v.has('S:200'));
});

test('GPS jumps are not filled in', () => {
  // Two points 600 m apart with the station in between: a gap, not a visit.
  const v = places.visits([{ startedAt: 1, points: [[40.7349, -73.9980, 0], [40.7349, -73.9830, 60000]] }]);
  assert.ok(!v.has('S:100'));
});

test('first visit time is kept from the earliest walk', () => {
  const later = { startedAt: 5000000, points: walk([40.7340, -73.9893], [40.7360, -73.9893], 20, 5000000) };
  const first = { startedAt: 1000000, points: walk([40.7340, -73.9893], [40.7360, -73.9893], 20, 1000000) };
  const v = places.visits([later, first]);
  assert.ok(v.get('S:100') < 5000000);
});

test('line progress counts each line a station serves', () => {
  const v = new Map([['S:100', 1]]);
  const lines = places.lineProgress(v);
  assert.deepEqual(lines.map((l) => l.route), ['4', '5', '6', 'L']);
  assert.deepEqual(lines.find((l) => l.route === 'L'), { route: 'L', total: 2, visited: 1 });
  assert.deepEqual(lines.find((l) => l.route === '4'), { route: '4', total: 1, visited: 1 });
  assert.ok(ROUTE_ORDER.includes('SIR'));
});

test('a break in a walk (a no-tracking area) is never joined to visit a landmark', () => {
  // Two points on either side of the landmark, ~110 m apart, with a break between them.
  const points = [[40.7395, -73.98952, 0], [40.7405, -73.98952, 60000]];
  assert.ok(places.visits([{ startedAt: 1, points }]).has('L:LP-1'), 'joined, the line passes the landmark');
  assert.ok(!places.visits([{ startedAt: 1, points, breaks: [1] }]).has('L:LP-1'), 'with a break it must not count');
});
