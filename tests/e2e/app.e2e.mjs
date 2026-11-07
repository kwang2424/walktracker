// Browser tests: the real app in Chromium, with the real NYC street data
// (data/nyc, built by scripts/build_city.mjs), a stand-in base map instead of
// Mapbox's (no token needed) and, where needed, a stand-in for the iPhone app.
//
//   npm run build:data   (or have data/nyc already)
//   npm run test:e2e
//
// Every test fails on any error in the page's console.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { serve } from './server.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const STYLE = readFileSync(new URL('./style.json', import.meta.url), 'utf8');
if (!existsSync(`${ROOT}data/nyc/index.json`)) throw new Error('No street data: build it first (npm run build:data).');

let browser, site;
before(async () => {
  browser = await chromium.launch();
  site = await serve(ROOT);
});
after(async () => {
  await browser?.close();
  site?.server.close();
});

// A walk along points [[lat, lon], ...] at walking pace, one fix every 3 s.
function walkAlong(route, startedAt) {
  const pts = [];
  const hav = (a, b) => { const r = Math.PI / 180; return 6371000 * Math.hypot((b[1] - a[1]) * r * Math.cos(a[0] * r), (b[0] - a[0]) * r); };
  for (let i = 1; i < route.length; i++) {
    const n = Math.ceil(hav(route[i - 1], route[i]) / 4);
    for (let k = 0; k < n; k++) {
      const f = k / n;
      pts.push([route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f, startedAt + pts.length * 3000]);
    }
  }
  return pts;
}
// Union Square up Broadway to 23rd St, then east to Park Ave South.
const BROADWAY = [[40.7347, -73.9906], [40.7377, -73.9898], [40.7404, -73.9897], [40.7412, -73.9893], [40.7398, -73.9861]];

// Opens the app. Options: tracks (saved walks), native (stand-in iPhone app
// script), steps (saved daily steps), geolocation.
async function openApp({ tracks = [], native = null, steps = null, geolocation = null } = {}) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 390, height: 844 },
    ...(geolocation && { geolocation, permissions: ['geolocation'] }),
  });
  await ctx.addInitScript(() => localStorage.setItem('walktracker.mapboxToken', 'pk.eyJ1IjoidGVzdCJ9.c2ln'));
  if (steps) await ctx.addInitScript((s) => localStorage.setItem('walktracker.steps', JSON.stringify(s)), steps);
  if (native) await ctx.addInitScript(native);
  await ctx.route(/api\.mapbox\.com\/styles\/v1\/mapbox\/standard/, (r) => r.fulfill({ contentType: 'application/json', body: STYLE }));
  await ctx.route(/map-sessions|events\.mapbox\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/vibrate|user hasn't tapped/i.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const ready = () => page.waitForFunction(() => window.walktracker?.city?.index && window.walktracker.view?.map?.getSource('blocks'), null, { timeout: 30000 });
  await page.goto(site.url);
  await ready();
  if (tracks.length) {
    await page.evaluate(async (list) => { for (const t of list) await walktracker.db.put('tracks', t); }, tracks);
    await page.reload();
    await ready();
    await page.waitForFunction((n) => walktracker.city.tracks.length >= n, tracks.filter((t) => !t.inProgress).length, { timeout: 30000 });
  }
  await page.waitForTimeout(500);
  return {
    page,
    errors,
    close: () => ctx.close(),
    walked: () => page.evaluate(() => walktracker.city.summary().walked),
    // The text a person reads (innerText keeps the gaps between labels).
    text: async (sel) => (await page.innerText(sel)).replace(/\s+/g, ' ').trim(),
    settingsTab: async () => {
      await page.evaluate(() => document.querySelector('#btn-menu')?.click());
      await page.evaluate(() => document.querySelector('[data-tab=settings]')?.click());
    },
  };
}

const dayAgo = () => Date.now() - 86400000;
const savedWalk = (extra = {}) => {
  const t0 = dayAgo();
  const points = walkAlong(BROADWAY, t0);
  return { name: 'Broadway', startedAt: t0, endedAt: points[points.length - 1][2], points, distance: 1000, source: 'recorded', ...extra };
};

test('the app opens cleanly with the street data', { timeout: 60000 }, async () => {
  const app = await openApp();
  assert.ok((await app.text('#hud-place-name')).length > 0);
  assert.equal(await app.page.$$eval('#legend img.badge-ic', (els) => els.length), 2);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('a saved walk counts blocks, landmarks and stations', { timeout: 60000 }, async () => {
  const app = await openApp({ tracks: [savedWalk()] });
  await app.page.waitForFunction(() => walktracker.city.summary().walked >= 15, null, { timeout: 30000 });
  await app.page.waitForFunction(() => walktracker.view.placesData.features.filter((f) => f.properties.v).length >= 3, null, { timeout: 15000 });
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('finishing an interrupted walk shows its summary card', { timeout: 60000 }, async () => {
  const t0 = Date.now() - 20 * 60000;
  const points = walkAlong(BROADWAY, t0);
  const app = await openApp({ tracks: [{ name: '', startedAt: t0, points, inProgress: true, distance: 0 }] });
  await app.page.waitForSelector('#resume:not([hidden])');
  await app.page.click('#btn-resume-finish');
  await app.page.waitForSelector('#summary:not([hidden])');
  const summary = await app.text('#summary');
  assert.match(summary, /Walk saved/);
  assert.match(summary, /new blocks/);
  assert.ok(Number(await app.text('#sum-blocks')) >= 15, summary);
  await app.page.click('#sum-next');
  assert.ok(await app.page.isHidden('#summary'));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('recording a walk with GPS: starts, takes points, saves', { timeout: 90000 }, async () => {
  const app = await openApp({ geolocation: { latitude: 40.7347, longitude: -73.9906, accuracy: 6 } });
  const ctx = app.page.context();
  await app.page.click('#btn-record');
  await app.page.waitForFunction(() => walktracker.rec);
  for (let i = 1; i <= 16; i++) { // ~1.4 m/s up Broadway, one fix a second
    await ctx.setGeolocation({ latitude: 40.7347 + i * 1.26e-5, longitude: -73.9906 + i * 0.3e-5, accuracy: 6 });
    await app.page.waitForTimeout(1000);
  }
  const points = await app.page.evaluate(() => walktracker.rec.points.length);
  assert.ok(points >= 4, `${points} points recorded`);
  await app.page.evaluate(() => document.querySelector('#btn-record').click());
  await app.page.waitForSelector('#summary:not([hidden])', { timeout: 15000 });
  assert.equal(await app.page.evaluate(() => walktracker.city.tracks.length), 1);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('no-tracking areas: a circle and a block stop counting, removing brings it back', { timeout: 90000 }, async () => {
  const app = await openApp({ tracks: [savedWalk()] });
  const before = await app.walked();
  // A circle over Broadway around 19th St.
  await app.page.evaluate(() => walktracker.view.setView([40.7380, -73.9898], 16));
  await app.settingsTab();
  await app.page.evaluate(() => document.querySelector('#btn-zone-add').click());
  await app.page.fill('#zone-name', 'Work');
  await app.page.click('#zone-save');
  await app.page.waitForFunction((b) => walktracker.city.summary().walked < b, before, { timeout: 15000 });
  const withCircle = await app.walked();
  // Points inside never count, and the walk line skips the area.
  assert.ok(withCircle < before);
  // Remove it.
  await app.settingsTab();
  await app.page.evaluate(() => document.querySelector('#zone-list .act').click());
  await app.page.waitForFunction((b) => walktracker.city.summary().walked === b, before, { timeout: 15000 });
  // A block: the one the walk passes east of Broadway near 20th St.
  await app.settingsTab();
  await app.page.evaluate(() => document.querySelector('#btn-zone-add').click());
  await app.page.click('[data-shape=block]');
  assert.ok(await app.page.$eval('#zone-save', (e) => e.disabled), 'save should wait for a block');
  await app.page.evaluate(() => walktracker.view.setView([40.7392, -73.9890], 16.8));
  await app.page.waitForTimeout(800);
  const pt = await app.page.evaluate(() => walktracker.view.map.project([-73.9890, 40.7392]));
  await app.page.mouse.click(pt.x, pt.y);
  await app.page.waitForFunction(() => !document.querySelector('#zone-save').disabled);
  await app.page.click('#zone-save');
  await app.page.waitForFunction((b) => walktracker.city.summary().walked < b, before, { timeout: 15000 });
  const zone = await app.page.evaluate(() => walktracker.settings.zones[0]);
  assert.ok(zone.ring.length >= 4 && zone.pad > 0);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('walk card: numbers, trim and undo, replay', { timeout: 90000 }, async () => {
  const app = await openApp({ tracks: [savedWalk({ steps: 1432 })] });
  await app.page.evaluate(() => document.querySelector('#btn-menu')?.click());
  await app.page.evaluate(() => document.querySelector('[data-tab=walks]').click());
  await app.page.evaluate(() => document.querySelector('#walk-list .main').click());
  await app.page.waitForSelector('#walk-detail:not([hidden])');
  assert.match(await app.text('#wd-sub'), /1,432 steps/);
  assert.match(await app.text('#wd-dist'), /km/);
  assert.notEqual(await app.text('#wd-pace'), '–');
  const before = await app.walked();
  // Trim off the first half.
  await app.page.evaluate(() => { document.querySelector('#wd-trim').open = true; });
  await app.page.evaluate(() => { const s = document.querySelector('#wd-start'); s.value = Math.round(s.max / 2); s.dispatchEvent(new Event('input')); });
  await app.page.click('#wd-trim-save');
  await app.page.waitForFunction((b) => walktracker.city.summary().walked < b, before, { timeout: 15000 });
  assert.match(await app.text('#wd-sub'), /trimmed/);
  await app.page.click('#wd-trim-undo');
  await app.page.waitForFunction((b) => walktracker.city.summary().walked === b, before, { timeout: 15000 });
  // Replay: runs, lights blocks, comes back to the card with the map as it was.
  await app.page.click('#wd-replay');
  await app.page.waitForSelector('#replay-bar:not([hidden])');
  await app.page.waitForSelector('#walk-detail:not([hidden])', { timeout: 30000 });
  assert.equal(await app.walked(), before);
  const grey = await app.page.evaluate(() => {
    const v = walktracker.view;
    return walktracker.city.loadedBlocks().filter((b) => walktracker.city.isWalked(b.id) && v.states[v.idxOf.get(b.id)] !== 2).length;
  });
  assert.equal(grey, 0, 'blocks left grey after the replay');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('heatmap, and hiding landmarks or stations', { timeout: 60000 }, async () => {
  const app = await openApp({ tracks: [savedWalk(), savedWalk({ startedAt: dayAgo() - 86400000 })] });
  await app.settingsTab();
  await app.page.evaluate(() => { const el = document.querySelector('[data-setting=showHeatmap]'); el.checked = false; el.click(); });
  await app.page.waitForFunction(() => walktracker.view.heatData.features.length > 100);
  assert.equal(await app.page.evaluate(() => walktracker.view.map.getLayoutProperty('heat', 'visibility')), 'visible');
  await app.page.evaluate(() => { const el = document.querySelector('[data-setting=showLandmarks]'); el.checked = true; el.click(); });
  await app.page.evaluate(() => walktracker.view.setView([40.7375, -73.9895], 16));
  await app.page.waitForTimeout(1200);
  const kinds = await app.page.evaluate(() => [...new Set(walktracker.view.map.queryRenderedFeatures({ layers: ['places'] }).map((f) => f.properties.kind))]);
  assert.ok(!kinds.includes('landmark'), `landmarks still shown: ${kinds}`);
  assert.ok(await app.page.isHidden('#legend [data-kind=landmark]'));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('park paths: shown and counted apart from blocks', { timeout: 60000 }, async () => {
  const app = await openApp();
  await app.page.evaluate(() => walktracker.view.setView([40.6602, -73.9690], 16)); // Prospect Park
  await app.page.waitForFunction(() => walktracker.city.loadedPaths().length > 50, null, { timeout: 30000 });
  await app.page.waitForTimeout(1000);
  assert.match(await app.text('#chip-paths'), /Paths · .* of .* km/);
  assert.ok(await app.page.evaluate(() => walktracker.view.map.queryRenderedFeatures({ layers: ['paths'] }).length) > 10);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('steps per day show in Stats', { timeout: 60000 }, async () => {
  const steps = {};
  const d = new Date();
  for (let i = 0; i < 10; i++) {
    const x = new Date(d.getTime() - i * 86400000);
    steps[`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`] = 4000 + i * 500;
  }
  const app = await openApp({ steps });
  await app.page.click('#hud-ring');
  await app.page.click('[data-view=stats]');
  await app.page.waitForSelector('#steps-section:not([hidden])');
  assert.match(await app.text('#step-tiles'), /Steps today 4,000/);
  assert.match(await app.text('#step-tiles'), /Best: 8,500/);
  assert.equal(await app.page.$$eval('#chart-steps .chart-bar', (els) => els.length), 10);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('iPhone app: an automatic walk in progress, finished from the card', { timeout: 90000 }, async () => {
  // A stand-in for the iPhone app with an automatic walk up Broadway.
  const native = `(() => {
    const route = ${JSON.stringify(BROADWAY.slice(0, 4))};
    const t0 = Date.now() - 12 * 60000, all = [];
    const hav = (a, b) => { const r = Math.PI / 180; return 6371000 * Math.hypot((b[1] - a[1]) * r * Math.cos(a[0] * r), (b[0] - a[0]) * r); };
    for (let i = 1; i < route.length; i++) { const n = Math.ceil(hav(route[i - 1], route[i]) / 4); for (let k = 0; k < n; k++) { const f = k / n; all.push([route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f, t0 + all.length * 3000, 6, 1.3, all.length * 5, 0]); } }
    let finished = false, taken = false;
    window.walktrackerNative = { platform: 'ios', call: async (cmd) => {
      if (cmd === 'currentWalk') return finished ? null : { startedAt: t0, distance: 0, points: all };
      if (cmd === 'finishAutoWalk') { finished = true; return true; }
      if (cmd === 'takeWalks') { if (!finished || taken) return []; taken = true; return [{ id: 'A1', startedAt: t0, endedAt: all[all.length - 1][2], points: all }]; }
      if (cmd === 'status') return { autoTrack: true, location: 'always', motion: 'authorized', recording: !finished, pending: 0 };
      if (cmd === 'dailySteps') return [];
      return null;
    } };
  })();`;
  const app = await openApp({ native });
  await app.page.waitForSelector('#auto-walk:not([hidden])', { timeout: 15000 });
  await app.page.waitForFunction(() => Number(document.querySelector('#aw-blocks').textContent) > 5, null, { timeout: 15000 });
  const live = Number(await app.text('#aw-blocks'));
  await app.page.click('#aw-finish');
  await app.page.waitForSelector('#summary:not([hidden])', { timeout: 15000 });
  assert.ok(await app.page.isHidden('#auto-walk'));
  assert.match(await app.text('#summary'), /Walk recorded.*automatic/);
  assert.equal(Number(await app.text('#sum-blocks')), live, 'the live count and the summary disagree');
  assert.match(await app.text('#sum-lines'), /steps/);
  assert.deepEqual(app.errors, []);
  await app.close();
});
