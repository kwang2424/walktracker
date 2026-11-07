import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkDetails, formatPace, trimWalk, untrimWalk } from '../js/walkstats.js';

// 2.5 km due north at 1.25 m/s (13:20 per km), one fix every 8 s (10 m), with
// a 2-minute stop at a light after 1.2 km.
const M = 1 / 111320;
const pts = [];
let t = 0, y = 0;
while (y < 2500) {
  pts.push([40.7 + y * M, -73.99, t]);
  if (Math.abs(y - 1200) < 1) { t += 120000; pts.push([40.7 + y * M, -73.99, t]); }
  y += 10; t += 8000;
}

test('distance, moving time (stops left out), pace and splits', () => {
  const d = walkDetails(pts);
  assert.ok(Math.abs(d.distance - 2490) < 5, `${d.distance}`);
  assert.ok(Math.abs(d.movingMs - (2490 / 1.25) * 1000) < 10000, `${d.movingMs}`);
  assert.ok(Math.abs(d.totalMs - d.movingMs - 120000) < 10000);
  assert.match(formatPace(d.pace), /^13:2[01]$/);
  assert.deepEqual(d.splits.map((s) => s.full), [true, true, false]);
  assert.ok(Math.abs(d.splits[0].ms - 800000) < 9000); // 13:20
  assert.ok(Math.abs(d.splits[1].ms - 920000) < 9000); // 13:20 + the 2-minute stop
});

test('trimming keeps the chosen part and can be undone', () => {
  const track = { id: 3, startedAt: 0, endedAt: pts[pts.length - 1][2], points: pts, distance: 2490 };
  const cut = trimWalk(track, 20, 100);
  assert.equal(cut.points.length, 81);
  assert.equal(cut.startedAt, pts[20][2]);
  assert.ok(Math.abs(cut.distance - 800) < 15);
  assert.equal(cut.original, pts);
  const again = trimWalk(cut, 0, 10); // re-trimming works from the original
  assert.equal(again.points[0], pts[0]);
  const back = untrimWalk(cut);
  assert.equal(back.points, pts);
  assert.equal(back.original, undefined);
  assert.equal(back.id, 3);
});

test('a walk recorded twice (phone and Apple Watch) is recognized; back-to-back walks are not', async () => {
  const { overlapsSaved } = await import('../js/walkstats.js');
  const phone = { startedAt: 1000, endedAt: 1000 + 30 * 60000, points: [] };
  const watch = { startedAt: 1000 + 2 * 60000, endedAt: 1000 + 31 * 60000, points: [] };
  const later = { startedAt: 1000 + 29 * 60000, endedAt: 1000 + 60 * 60000, points: [] };
  assert.equal(overlapsSaved(watch, [phone]), true);
  assert.equal(overlapsSaved(later, [phone]), false); // a minute of overlap: a new walk
  assert.equal(overlapsSaved(phone, [phone]), false);
});
