import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totals, bestStreak, weeklyTotals, dailyTotals, startOfWeek } from '../js/stats.js';
import { evaluate, factsFrom, ACHIEVEMENTS, FINISHED } from '../js/achievements.js';

const day = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();
const walk = (when, distance = 1000) => ({ startedAt: when, distance, points: [] });

test('totals add up distance, count walks and find the longest', () => {
  const t = totals([walk(day(2026, 9, 1), 1500), walk(day(2026, 9, 2), 4000), walk(day(2026, 9, 3), 500)]);
  assert.deepEqual(t, { walks: 3, meters: 6000, longest: 4000 });
});

test('bestStreak finds the longest run of days, even in the past', () => {
  const tracks = [
    walk(day(2026, 2, 1)), walk(day(2026, 2, 2)), walk(day(2026, 2, 3)), walk(day(2026, 2, 4)), // 4 days
    walk(day(2026, 2, 6)),
    walk(day(2026, 9, 20)), walk(day(2026, 9, 21)),
    walk(day(2026, 9, 22), 50), // too short to count
  ];
  assert.equal(bestStreak(tracks), 4);
  assert.equal(bestStreak([]), 0);
  // Across the November daylight-saving change.
  assert.equal(bestStreak([walk(day(2026, 10, 1)), walk(day(2026, 10, 2))]), 2);
});

test('weeklyTotals buckets walks and new blocks into Monday weeks', () => {
  const now = day(2026, 9, 29); // Thursday
  const tracks = [walk(day(2026, 9, 26), 2000), walk(day(2026, 9, 28), 1000), walk(day(2026, 9, 20), 3000), walk(day(2025, 0, 1), 9999)];
  const done = new Map([['a', day(2026, 9, 27)], ['b', day(2026, 9, 21)]]);
  const w = weeklyTotals(tracks, done, 4, now);
  assert.equal(w.length, 4);
  assert.equal(w[3].start, startOfWeek(now));
  assert.deepEqual([w[3].meters, w[3].walks, w[3].blocks], [3000, 2, 1]);
  assert.deepEqual([w[2].meters, w[2].walks, w[2].blocks], [3000, 1, 1]);
  assert.equal(w[0].meters + w[1].meters, 0, 'the 2025 walk is outside the window');
});

test('dailyTotals makes a Monday-aligned calendar ending this week', () => {
  const now = day(2026, 9, 29);
  const d = dailyTotals([walk(day(2026, 9, 28, 9), 1200), walk(day(2026, 9, 28, 18), 800)], 2, now);
  assert.equal(d.length, 14);
  assert.equal(new Date(d[0].date).getDay(), 1);
  const oct28 = d.find((x) => new Date(x.date).getDate() === 28);
  assert.equal(oct28.meters, 2000);
});

const summary = (over = {}) => ({
  walked: 120, length: 100000, walkedLength: 1500,
  hoods: [
    { id: 'A', length: 1000, walked: 30, walkedLength: 950 }, // finished (95%)
    { id: 'B', length: 1000, walked: 10, walkedLength: 600 }, // half
    { id: 'C', length: 1000, walked: 0, walkedLength: 0 },
  ],
  boroughs: [{ walked: 40 }, { walked: 0 }, { walked: 3 }],
  ...over,
});

test('factsFrom counts finished streets and neighborhoods at 90%', () => {
  const streets = [['Main St', 'Manhattan', 4, 400], ['Main St', 'Brooklyn', 4, 400], ['Oak Ave', 'Queens', 2, 200]];
  const walkedByStreet = new Map([
    ['Main St|Manhattan', { walkedLength: 400 }],
    ['Main St|Brooklyn', { walkedLength: 300 }], // 75%: not finished
    ['Oak Ave|Queens', { walkedLength: FINISHED * 200 }],
  ]);
  const f = factsFrom({ summary: summary(), tracksTotals: { meters: 12345 }, streets, walkedByStreet, bestStreak: 4 });
  assert.deepEqual(f, { blocks: 120, km: 12, streetsDone: 2, hoodsVisited: 2, hoodsHalf: 2, hoodsDone: 1, boroughsVisited: 2, cityPct: 1, bestStreak: 4 });
});

test('evaluate marks earned achievements and progress toward the rest', () => {
  const list = evaluate({ blocks: 120, km: 12, streetsDone: 2, hoodsVisited: 2, hoodsHalf: 2, hoodsDone: 1, boroughsVisited: 2, cityPct: 1, bestStreak: 4 });
  const get = (id) => list.find((a) => a.id === id);
  assert.equal(get('first-block').earned, true);
  assert.equal(get('blocks-100').earned, true);
  assert.equal(get('blocks-500').earned, false);
  assert.equal(get('blocks-500').progress, 120 / 500);
  assert.equal(get('km-10').earned, true);
  assert.equal(get('hood-1').earned, true);
  assert.equal(get('streak-3').earned, true);
  assert.equal(get('streak-7').earned, false);
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length, 'ids are unique');
});
