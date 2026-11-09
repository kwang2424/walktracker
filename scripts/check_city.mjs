#!/usr/bin/env node
// Sanity checks on the built street data, run in CI after build_city.mjs so a
// bad OpenStreetMap edit or a pipeline bug can't quietly ship.
//
//   node scripts/check_city.mjs data/nyc
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'data/nyc';
const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

// NYC with a little margin.
const inNyc = (lat, lon) => lat > 40.47 && lat < 40.93 && lon > -74.28 && lon < -73.68;

const index = read('index.json');
const { total, hoods } = index;
check(total.blocks > 90000 && total.blocks < 130000, `total blocks ${total.blocks} is outside 90,000-130,000`);
check(total.length > 8.5e6 && total.length < 12e6, `total street length ${Math.round(total.length / 1000)} km is outside 8,500-12,000 km`);
check(total.paths > 15000 && total.pathLength > 1e6, `paths look wrong: ${total.paths} pieces, ${Math.round(total.pathLength / 1000)} km`);
check(hoods.length >= 240 && hoods.length <= 262, `${hoods.length} neighborhoods (expected about 257)`);
check(typeof index.rev === 'string' && index.rev.length > 3, 'index has no build id (rev)');
const boroughs = new Set(hoods.map((h) => h.borough));
check(['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'].every((b) => boroughs.has(b)), `boroughs: ${[...boroughs]}`);

const seen = new Set();
let blocks = 0, paths = 0;
for (const h of hoods) {
  check(h.bbox.every(Number.isFinite) && h.bbox[0] < h.bbox[2] && h.bbox[1] < h.bbox[3], `${h.id}: bad bbox`);
  check(h.blocks > 0, `${h.id} (${h.name}) has no blocks`);
  const f = read(join('hoods', `${h.id}.json`));
  check(f.blocks.length === h.blocks, `${h.id}: index says ${h.blocks} blocks, file has ${f.blocks.length}`);
  for (const [kind, list] of [['block', f.blocks], ['path', f.paths || []]]) {
    for (const item of list) {
      const [id, ni, flat] = item;
      if (seen.has(id)) problems.push(`${h.id}: duplicate ${kind} id ${id}`);
      seen.add(id);
      if (!(ni === -1 || (ni >= 0 && ni < f.names.length))) problems.push(`${h.id}: ${kind} ${id} has a bad name index`);
      if (flat.length < 4 || flat.length % 2) problems.push(`${h.id}: ${kind} ${id} has ${flat.length / 2} points`);
      for (let i = 0; i < flat.length; i += 2) {
        if (!Number.isFinite(flat[i]) || !Number.isFinite(flat[i + 1]) || !inNyc(flat[i], flat[i + 1])) {
          problems.push(`${h.id}: ${kind} ${id} has a point outside NYC (${flat[i]}, ${flat[i + 1]})`);
          break;
        }
      }
    }
  }
  blocks += f.blocks.length;
  paths += (f.paths || []).length;
  if (problems.length > 50) break;
}
check(blocks === total.blocks, `files have ${blocks} blocks, index says ${total.blocks}`);
check(paths === total.paths, `files have ${paths} paths, index says ${total.paths}`);
check(readdirSync(join(dir, 'hoods')).length === hoods.length, 'hood files and index disagree');

// Streets people have asked about, as canaries for the street filter.
const hoodNamed = (name) => hoods.find((h) => h.name === name);
const countIn = (hoodName, street, kind = 'blocks') => {
  const h = hoodNamed(hoodName);
  if (!h) return -1;
  const f = read(join('hoods', `${h.id}.json`));
  return (kind === 'blocks' ? f.blocks : f.paths || []).filter(([, ni]) => f.names[ni] === street).length;
};
check(countIn('Downtown Brooklyn-DUMBO-Boerum Hill', 'Fulton Mall') >= 8, `Fulton Mall has ${countIn('Downtown Brooklyn-DUMBO-Boerum Hill', 'Fulton Mall')} blocks (expected 9)`);
check(countIn('Downtown Brooklyn-DUMBO-Boerum Hill', 'Albee Square', 'paths') >= 1, 'Albee Square plaza is missing');
check(countIn('Brooklyn Heights', 'Brooklyn Heights Promenade', 'paths') >= 1, 'Brooklyn Heights Promenade is missing');
check(countIn('Crown Heights (North)', 'Eastern Parkway') >= 20, 'Eastern Parkway looks short');

const outlines = read('neighborhoods.geojson');
check(outlines.features.length === hoods.length, `${outlines.features.length} outlines for ${hoods.length} neighborhoods`);

const places = read('places.json');
check(places.landmarks.length > 1300, `${places.landmarks.length} landmarks (expected about 1,450)`);
check(places.stations.length >= 420, `${places.stations.length} stations (expected about 445)`);
check(places.stations.every((s) => s[2].length > 0 && s[5].length >= 2), 'a station without lines or platforms');
check((places.art || []).length > 700, `${(places.art || []).length} public artworks (expected about 770)`);
check((places.pops || []).length > 350, `${(places.pops || []).length} public spaces (expected about 390)`);
const bridgeNames = new Set((places.bridges || []).map((b) => b[1]));
for (const name of ['Brooklyn Bridge', 'Manhattan Bridge', 'Williamsburg Bridge', 'Queensboro Bridge', 'High Bridge']) check(bridgeNames.has(name), `${name} missing`);

const streets = read('streets.json');
check(streets.some(([name, borough, n]) => name === 'Broadway' && borough === 'Manhattan' && n > 150), 'Broadway in Manhattan looks wrong');

if (problems.length) {
  console.error(`Street data check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
  for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Street data OK: ${total.blocks} blocks, ${total.paths} paths, ${hoods.length} neighborhoods, ${places.landmarks.length} landmarks, ${places.stations.length} stations.`);
