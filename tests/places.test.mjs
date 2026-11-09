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

// Public art, a public plaza and a ~200 m bridge running north from 40.7500/-73.9700.
const more = new Places({
  ...data,
  art: [['PA-1', 'Red Cube', 'Isamu Noguchi', '1968', 'Sculpture', 'Marine Midland Plaza', 0, 40.7090, -74.0100]],
  pops: [['M1', 'Test Atrium', '1 Plaza Way', 'Atrium', '1985', 0, 40.7200, -74.0000]],
  bridges: [['BR-1', 'Test Bridge', 200, 0, [[40.7500, -73.9700, 40.7518, -73.9700]]]],
});
const bridge = more.bridges[0];

test('public art and public spaces count within their radius', () => {
  const v = more.visits([{ startedAt: 1, points: walk([40.7085, -74.00975], [40.7095, -74.00975]) }]); // ~21 m east
  assert.ok(v.has('A:PA-1'));
  assert.ok(!more.visits([{ startedAt: 1, points: walk([40.7085, -74.0094], [40.7095, -74.0094]) }]).has('A:PA-1'), '~50 m away');
  assert.ok(more.visits([{ startedAt: 1, points: walk([40.7195, -73.99965], [40.7205, -73.99965]) }]).has('P:M1'));
  assert.equal(more.art.length, 1);
  assert.equal(more.pops.length, 1);
});

test('a bridge counts once most of it is walked, across several walks', () => {
  const lon = -73.9700;
  const part = (a, b, t0) => ({ startedAt: t0, points: walk([a, lon], [b, lon], 20, t0) });
  assert.ok(!more.visits([part(40.7500, 40.7506, 0)]).has('B:BR-1'), 'a third of it is not enough');
  const v = more.visits([part(40.7500, 40.7506, 0), part(40.7506, 40.7513, 1e6)]);
  assert.ok(v.has('B:BR-1'), 'two walks that together cover most of it count');
  assert.ok(v.get('B:BR-1') >= 1e6, 'counted when the second walk finished it');
  assert.ok(more.visits([part(40.7495, 40.7522, 0)]).has('B:BR-1'), 'one walk end to end');
  assert.ok(!more.visits([{ startedAt: 0, points: walk([40.7500, -73.9690], [40.7518, -73.9690]) }]).has('B:BR-1'), '85 m to the side');
});

test('a bridge is not crossed over a GPS gap or a break', () => {
  const pts = [[40.7499, -73.9700, 0], [40.7519, -73.9700, 60000]]; // one 220 m jump
  assert.ok(!more.visits([{ startedAt: 0, points: pts }]).has('B:BR-1'));
  const full = walk([40.7495, -73.9700], [40.7522, -73.9700], 20);
  const breaks = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  assert.ok(!more.visits([{ startedAt: 0, points: full, breaks }]).has('B:BR-1'));
});

test('live crossing reaches the same answer as a whole walk', () => {
  const pts = walk([40.7495, -73.9700], [40.7522, -73.9700], 30);
  const cover = new Map();
  let at = null;
  for (let i = 1; i < pts.length; i++) if (more.crossed(pts[i - 1], pts[i], cover).length) at ??= pts[i][2];
  assert.equal(at, more.visits([{ startedAt: 0, points: pts }]).get('B:BR-1'));
  assert.equal(more.bridgeShare(bridge, cover), 1);
  assert.ok(more.crossed(pts[0], pts[1], cover).length === 0, 'reported once');
});
