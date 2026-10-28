import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine, sampleAlong, polylineLength, buildBlocks, CoverageEngine, summarize, overpassQuery, midpoint,
} from '../js/geo.js';
import { parseGpx, toGpx } from '../js/gpx.js';

// A tiny 2x2 street grid (~ Manhattan-sized blocks) around 40.73, -73.99.
//   1 --- 2 --- 3     "A St" (way 10): 1-2-3
//   |     |     |     "B St" (way 11): 4-5-6
//   4 --- 5 --- 6     "1st Ave" (20): 1-4, "2nd Ave" (21): 2-5, "3rd Ave" (22): 3-6
const LAT = 40.73, LON = -73.99, DLAT = 0.0007, DLON = 0.0025; // ~78 m by ~210 m
const node = (id, r, c) => ({ type: 'node', id, lat: LAT - r * DLAT, lon: LON + c * DLON });
const way = (id, name, nodes) => ({ type: 'way', id, nodes, tags: { name, highway: 'residential' } });
const osm = {
  elements: [
    node(1, 0, 0), node(2, 0, 1), node(3, 0, 2), node(4, 1, 0), node(5, 1, 1), node(6, 1, 2),
    way(10, 'A St', [1, 2, 3]), way(11, 'B St', [4, 5, 6]),
    way(20, '1st Ave', [1, 4]), way(21, '2nd Ave', [2, 5]), way(22, '3rd Ave', [3, 6]),
  ],
};
const at = (r, c, t) => [LAT - r * DLAT, LON + c * DLON, t];

test('haversine matches a known distance', () => {
  // One degree of latitude is ~111.2 km.
  assert.ok(Math.abs(haversine([40, -74], [41, -74]) - 111195) < 100);
});

test('sampleAlong spaces points evenly and avoids the ends', () => {
  const line = [at(0, 0), at(0, 1)];
  const len = polylineLength(line);
  const s = sampleAlong(line, 10);
  assert.equal(s.length, Math.round(len / 10));
  assert.ok(haversine(s[0], line[0]) > 3);
  assert.ok(haversine(s[s.length - 1], line[1]) > 3);
});

test('midpoint is halfway along the line, even with only two points', () => {
  const m = midpoint([[40, -74], [40, -73.99]]);
  assert.ok(Math.abs(m[1] - -73.995) < 1e-9 && Math.abs(m[0] - 40) < 1e-9);
  const leg = haversine([40, -74], [40, -73.99]);
  const bent = [[40, -74], [40, -73.99], [40 + leg / 111195, -73.99]]; // two equal legs
  const b = midpoint(bent);
  assert.ok(haversine(b, [40, -73.99]) < 25, 'should sit near the corner');
});

test('buildBlocks splits streets at intersections', () => {
  const blocks = buildBlocks(osm);
  assert.equal(blocks.length, 7); // A St x2, B St x2, three avenues
  assert.equal(blocks.filter((b) => b.name === 'A St').length, 2);
  assert.ok(blocks.every((b) => b.coords.length === 2));
  assert.equal(new Set(blocks.map((b) => b.id)).size, 7);
});

test('walking one block marks only that block', () => {
  const e = new CoverageEngine();
  e.setBlocks(buildBlocks(osm));
  // Walk A St from node 1 to node 2, offset ~8 m to the side like a sidewalk.
  const off = 0.00007;
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push([LAT + off, LON + (DLON * i) / 20, 1000 * i * 10]);
  e.addTrack(pts);
  const walked = [...e.blocks.keys()].filter((id) => e.isWalked(id));
  assert.equal(walked.length, 1);
  assert.equal(e.blocks.get(walked[0]).block.name, 'A St');
  // The avenues touched at the ends must not count.
  const aves = [...e.blocks.values()].filter((s) => s.block.name.includes('Ave'));
  assert.ok(aves.every((s) => s.count === 0));
});

test('half a block is partial, not walked', () => {
  const e = new CoverageEngine();
  e.setBlocks(buildBlocks(osm));
  e.addTrack([at(1, 0, 0), at(1, 0.45, 60000)]);
  const b = [...e.blocks.values()].find((s) => s.block.name === 'B St' && s.count > 0);
  const f = e.fraction(b.block.id);
  assert.ok(f > 0.3 && f < 0.6, `fraction ${f}`);
  assert.equal(e.isWalked(b.block.id), false);
});

test('GPS too far from the street does not count', () => {
  const e = new CoverageEngine();
  e.setBlocks(buildBlocks(osm));
  // Parallel line ~40 m north of A St.
  e.addTrack([[LAT + 0.00036, LON, 0], [LAT + 0.00036, LON + DLON, 120000]]);
  assert.ok([...e.blocks.values()].every((s) => s.count === 0));
});

test('fast segments (car, subway) are ignored', () => {
  const e = new CoverageEngine();
  e.setBlocks(buildBlocks(osm));
  e.addTrack([at(0, 0, 0), at(0, 0.3, 4000), at(0, 0.6, 8000), at(0, 1, 12000)]); // ~17 m/s
  assert.ok([...e.blocks.values()].every((s) => s.count === 0));
});

test('GPS gaps are not bridged', () => {
  const e = new CoverageEngine();
  e.setBlocks(buildBlocks(osm));
  e.addTrack([at(0, 0), at(0, 1)]); // 210 m jump, no timestamps
  assert.ok([...e.blocks.values()].every((s) => s.count === 0));
});

test('summarize totals blocks, lengths and per-street progress, honoring overrides', () => {
  const e = new CoverageEngine();
  const blocks = buildBlocks(osm);
  e.setBlocks(blocks);
  const ave = blocks.find((b) => b.name === '1st Ave');
  const s = summarize(e, { [ave.id]: true });
  assert.equal(s.total, 7);
  assert.equal(s.walked, 1);
  assert.ok(Math.abs(s.walkedLen - ave.length) < 1e-6);
  const st = s.streets.find((x) => x.name === '1st Ave');
  assert.equal(st.walked, 1);
});

test('overpass query includes the bbox', () => {
  const q = overpassQuery([1, 2, 3, 4]);
  assert.match(q, /\(1,2,3,4\)/);
  assert.match(q, /residential/);
});

test('GPX round trip keeps points and times', () => {
  const tracks = [{ name: 'Morning & walk', points: [[40.1, -73.2, Date.UTC(2026, 0, 1)], [40.2, -73.3, Date.UTC(2026, 0, 1, 0, 5)]] }];
  const back = parseGpx(toGpx(tracks));
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Morning & walk');
  assert.deepEqual(back[0].points, tracks[0].points);
});

test('parseGpx handles attribute order, self-closing points and multiple tracks', () => {
  const gpx = `<?xml version="1.0"?><gpx>
    <trk><name>One</name><trkseg>
      <trkpt lon="-73.99" lat="40.73"><ele>10</ele><time>2026-05-01T12:00:00Z</time></trkpt>
      <trkpt lat='40.731' lon='-73.991'/>
    </trkseg></trk>
    <trk><trkseg><trkpt lat="1" lon="2"></trkpt></trkseg></trk>
  </gpx>`;
  const t = parseGpx(gpx);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0].points[0], [40.73, -73.99, Date.parse('2026-05-01T12:00:00Z')]);
  assert.deepEqual(t[0].points[1], [40.731, -73.991]);
});
