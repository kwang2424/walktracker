// Walk suggestions on the real street map, with pass marks. Needs data/nyc.
// (node tests/sim/routes.bench.mjs prints the full comparison.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, measure, month } from './routes.bench.mjs';
import { suggestRoute } from '../../js/routes.js';
import { haversine } from '../../js/geo.js';

const { g, home, walked } = await setup();
const starts = [home, [40.6890, -73.9800], [40.6800, -73.9900], [40.6930, -73.9870], [40.6760, -73.9800]];

test('suggested loops: mostly new blocks, little doubling back, about the time asked, back where they began', () => {
  for (const minutes of [20, 30, 45, 60]) {
    const rows = starts.map((start, i) => [start, suggestRoute(g, { start, minutes, walked: (id) => walked.has(id), seed: i + 1, tries: 600, timeLimit: 1e9 })]);
    const m = rows.map(([start, res]) => { assert.ok(res, `no route for ${minutes} min`); return measure(g, res, walked, start); });
    const avg = (k) => m.reduce((n, x) => n + x[k], 0) / m.length;
    assert.ok(avg('newShare') >= 0.8, `${minutes} min: only ${(avg('newShare') * 100).toFixed(0)}% new`);
    assert.ok(avg('repeatShare') <= 0.1, `${minutes} min: ${(avg('repeatShare') * 100).toFixed(0)}% walked twice`);
    for (const x of m) {
      assert.ok(x.minutes > minutes * 0.8 && x.minutes < minutes * 1.2, `${minutes} min asked, ${x.minutes.toFixed(0)} min suggested`);
      assert.ok(x.closes, 'a loop that doesn\'t come back');
    }
  }
});

test('a walk to somewhere ends there', () => {
  const to = [40.6905, -73.9870];
  const res = suggestRoute(g, { start: home, to, minutes: 30, walked: (id) => walked.has(id), tries: 300, timeLimit: 1e9 });
  assert.ok(res);
  assert.ok(haversine(res.coords[res.coords.length - 1], to) < 150);
  assert.ok(res.minutes > 24 && res.minutes < 36);
});

test('no-tracking areas and walked blocks are worth nothing', () => {
  const zone = (coords) => coords.some((p) => haversine(p, home) < 400);
  const res = suggestRoute(g, { start: home, minutes: 30, walked: (id) => walked.has(id), avoid: zone, tries: 300, timeLimit: 1e9 });
  assert.ok(res);
  // The walk heads out of the area to find new blocks: most new meters are outside it.
  let inside = 0, outside = 0;
  for (const id of new Set(res.edges)) {
    const e = g.edges.get(id);
    if (walked.has(id) || e.path) continue;
    (zone(e.coords) ? (inside += e.len) : (outside += e.len));
  }
  assert.ok(outside > inside * 2, `new meters inside the area ${Math.round(inside)} vs outside ${Math.round(outside)}`);
});

test('a month of following suggestions finds far more new blocks than random walks', () => {
  const follow = month(g, home, walked, { tries: 300, timeLimit: 1e9 });
  const random = month(g, home, walked, { randomOnly: true, tries: 1 });
  assert.ok(follow[29] >= random[29] * 1.5, `following ${follow[29]} vs random ${random[29]} new blocks`);
});

test('works in Midtown\'s grid too', async () => {
  const { loadCity } = await import('./nyc.mjs');
  const mid = await loadCity([40.745, -73.995, 40.765, -73.97]);
  const res = suggestRoute(mid.graph, { start: [40.7536, -73.9832], minutes: 30, walked: () => false, tries: 300, timeLimit: 1e9 });
  assert.ok(res && res.minutes > 24 && res.minutes < 36);
  const m = measure(mid.graph, res, new Set(), [40.7536, -73.9832]);
  assert.ok(m.newShare > 0.85 && m.closes);
});
