// Simulated NYC days (see nyc.mjs) with pass marks: the app must find the
// blocks people really walk, never count rides or no-tracking areas, and keep
// wrong blocks (mostly tiny pieces at big intersections) few.
// Needs data/nyc. Run: npm run test:sim
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { days, scoreDay, PHONE, SWIFT_BEFORE } from './nyc.mjs';

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
      // Rides (bus, taxi, bike, subway) never end up inside a walk, and no
      // walk's distance is wildly off what was really walked during it.
      assert.equal(s.swallowed, 0, `${where} ${s.swallowed} walk(s) went on through a ride`);
      // Midtown's simulated GPS bounces 30-85 m about every 100 s (harsher than
      // most phones see); there a walk may measure up to 3x, elsewhere 2x.
      for (const d of s.distanceOff) {
        const most = d.canyonShare > 0.3 ? 3 : 2;
        if (d.walked > 300) assert.ok(d.recorded < d.walked * most && d.recorded > d.walked * 0.6, `${where} a walk measured ${(d.recorded / 1000).toFixed(1)} km for ${(d.walked / 1000).toFixed(1)} km walked`);
      }
    }
  });
}

test('the simulation catches walks that run on through rides (the old timer rule)', async () => {
  let swallowed = 0;
  for (const [i, day] of list.entries()) {
    for (const seed of SEEDS) swallowed += (await scoreDay({ ...day, seed: seed * 10 + i, city, model: { ...PHONE, handleActivity: SWIFT_BEFORE } })).swallowed;
  }
  assert.ok(swallowed > 0, 'with the old rule some walk should have run on through a ride');
});
