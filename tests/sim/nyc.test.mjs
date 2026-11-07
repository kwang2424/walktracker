// Simulated NYC days (see nyc.mjs) with pass marks: the app must find the
// blocks people really walk, never count rides or no-tracking areas, and keep
// wrong blocks (mostly tiny pieces at big intersections) few.
// Needs data/nyc. Run: npm run test:sim
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { days, scoreDay } from './nyc.mjs';

const SEEDS = [1, 2, 3];
const { city, list } = await days();

for (const [i, day] of list.entries()) {
  test(day.name, async () => {
    for (const seed of SEEDS) {
      const s = await scoreDay({ ...day, seed: seed * 10 + i, city });
      const where = `(seed ${seed})`;
      assert.ok(s.recall >= 0.95, `${where} found only ${(s.recall * 100).toFixed(0)}% of walked blocks; missed: ${s.missed.join('; ')}`);
      assert.equal(s.insideZones, 0, `${where} counted blocks inside a no-tracking area`);
      assert.ok(s.fromRides <= 1, `${where} counted ${s.fromRides} blocks only ridden: ${s.extras.join('; ')}`);
      assert.ok(s.extra <= Math.max(6, 0.2 * s.truth), `${where} ${s.extra} wrong blocks for ${s.truth} walked: ${s.extras.join('; ')}`);
      assert.ok(s.walks >= 1, `${where} no walk recorded`);
    }
  });
}
