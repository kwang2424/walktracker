import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StillnessDetector, MotionWake } from '../js/power.js';
import { streak, weekStats, startOfWeek, replayTracks } from '../js/stats.js';
import { CoverageEngine, buildBlocks } from '../js/geo.js';

const LAT = 40.73, LON = -73.99;
const north = (m) => LAT + m / 111195;

test('stillness: walking stays moving', () => {
  const d = new StillnessDetector();
  for (let i = 0; i < 300; i++) assert.equal(d.update([north(i * 1.3), LON, i * 1000], 5), 'moving');
});

test('stillness: standing for 90 s pauses, walking away wakes', () => {
  const d = new StillnessDetector();
  let state;
  for (let i = 0; i <= 89; i++) state = d.update([north(Math.sin(i) * 5), LON, i * 1000], 8);
  assert.equal(state, 'moving');
  assert.equal(d.update([north(2), LON, 91000], 8), 'still');
  // GPS noise while still doesn't wake it.
  assert.equal(d.update([north(25), LON, 95000], 10), 'still');
  // Clearly moved beyond the error.
  assert.equal(d.update([north(60), LON, 120000], 10), 'moving');
});

test('stillness: coarse low-power fixes need a bigger move to wake', () => {
  const d = new StillnessDetector({ stillMs: 1000 });
  d.update([LAT, LON, 0], 5);
  assert.equal(d.update([LAT, LON, 2000], 5), 'still');
  assert.equal(d.update([north(80), LON, 3000], 65), 'still'); // within ±65 m error
  assert.equal(d.update([north(120), LON, 4000], 65), 'moving');
});

test('motion: phone held still does not wake, steps do', () => {
  const still = new MotionWake();
  let woke = false;
  for (let t = 0; t < 3000; t += 16) woke ||= still.update(9.81 + Math.sin(t) * 0.15, t);
  assert.equal(woke, false);
  const walking = new MotionWake();
  for (let t = 0; t < 3000; t += 16) woke ||= walking.update(9.81 + 3 * Math.sin((t / 1000) * 2 * Math.PI * 1.8), t);
  assert.equal(woke, true);
});

const day = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();
const walk = (when, distance = 1000) => ({ startedAt: when, distance, points: [] });

test('streak counts consecutive days, allowing today to be pending', () => {
  const tracks = [walk(day(2026, 9, 24)), walk(day(2026, 9, 25)), walk(day(2026, 9, 26))];
  assert.equal(streak(tracks, day(2026, 9, 26, 20)), 3);
  assert.equal(streak(tracks, day(2026, 9, 27, 9)), 3); // haven't walked yet today
  assert.equal(streak(tracks, day(2026, 9, 28, 9)), 0); // missed a day
  assert.equal(streak([walk(day(2026, 9, 26), 50)], day(2026, 9, 26, 20)), 0); // too short
});

test('week stats start on Monday', () => {
  const now = day(2026, 9, 29); // Thursday Oct 29 2026
  assert.equal(new Date(startOfWeek(now)).getDay(), 1);
  const tracks = [walk(day(2026, 9, 25), 5000), walk(day(2026, 9, 27), 2000), walk(day(2026, 9, 28), 1500)];
  const done = new Map([['a', day(2026, 9, 25)], ['b', day(2026, 9, 27)]]);
  const w = weekStats(tracks, done, now);
  assert.equal(w.walks, 2);
  assert.equal(w.meters, 3500);
  assert.equal(w.blocks, 1);
});

test('replayTracks credits each block to the first walk that finished it', () => {
  const osm = { elements: [
    { type: 'node', id: 1, lat: LAT, lon: LON }, { type: 'node', id: 2, lat: LAT, lon: LON + 0.0025 },
    { type: 'way', id: 9, nodes: [1, 2], tags: { name: 'A St', highway: 'residential' } },
  ] };
  const e = new CoverageEngine();
  e.setBlocks(buildBlocks(osm));
  const pts = (t0) => Array.from({ length: 21 }, (_, i) => [LAT, LON + (0.0025 * i) / 20, t0 + i * 10000]);
  const tracks = [{ id: 2, startedAt: 5e6, points: pts(5e6) }, { id: 1, startedAt: 1e6, points: pts(1e6) }];
  const { completedAt, newByTrack } = replayTracks(e, tracks);
  assert.equal([...completedAt.values()][0], 1e6);
  assert.equal(newByTrack.get(1), 1);
  assert.equal(newByTrack.get(2), 0);
});
