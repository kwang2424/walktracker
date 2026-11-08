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

// Finishing a walk (Finish walk on an automatic walk's card, or Finish on one
// you started) while still walking must not start a new automatic walk right
// away; stopping for a couple of minutes and walking again must.
const { loadCity, route, simulate, phoneAutoWalks, FINISH_BEFORE } = await import('./nyc.mjs');
const home = [40.6852, -73.9843], hall = [40.6928, -73.9903], there = [40.6880, -73.9790], corner = [40.6905, -73.9870];
const R = (a, b) => route(city.graph, a, b);
const afterFinish = (plan, model) => {
  const out = [];
  for (let seed = 1; seed <= 15; seed++) {
    const sim = simulate(plan, { seed });
    const done = sim.actions.find((a) => a.do === 'finishAuto' || a.do === 'finishWalk').t;
    out.push(phoneAutoWalks(sim, [], { seed, model }).filter((w) => w.startedAt > done).length);
  }
  return out;
};
const keepWalking = {
  card: [{ mode: 'walk', route: R(home, hall) }, { mode: 'action', do: 'finishAuto' }, { mode: 'walk', route: R(hall, there) }, { mode: 'stay', at: there, minutes: 10 }],
  app: [{ mode: 'stay', at: home, minutes: 1 }, { mode: 'action', do: 'startWalk' }, { mode: 'walk', route: R(home, hall) }, { mode: 'action', do: 'finishWalk' },
    { mode: 'walk', route: R(hall, there) }, { mode: 'stay', at: there, minutes: 10 }],
};

test('finishing a walk while still walking does not start a new one', () => {
  for (const [how, plan] of Object.entries(keepWalking)) {
    assert.deepEqual(afterFinish(plan, PHONE).filter(Boolean), [], `finished ${how === 'card' ? 'on the card' : 'in the app'}: a new walk started`);
  }
});

test('after finishing, a real stop and walking again starts a new walk', () => {
  const plan = [{ mode: 'walk', route: R(home, hall) }, { mode: 'action', do: 'finishAuto' }, { mode: 'walk', route: R(hall, corner) },
    { mode: 'stay', at: corner, minutes: 3 }, { mode: 'walk', route: R(corner, there) }, { mode: 'stay', at: there, minutes: 5 }];
  assert.deepEqual(afterFinish(plan, PHONE).filter((n) => n !== 1), []);
});

test('the simulation catches the old finish rules (new walks right after finishing)', () => {
  const old = { ...PHONE, ...FINISH_BEFORE };
  assert.ok(afterFinish(keepWalking.app, old).some(Boolean) && afterFinish(keepWalking.card, old).some(Boolean));
});
