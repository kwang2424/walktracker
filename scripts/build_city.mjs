#!/usr/bin/env node
// Builds the app's NYC street data: every block in the five boroughs, filed
// under its official neighborhood.
//
//   node scripts/build_city.mjs RAW.json data/nyc
//
// RAW.json comes from extract_streets.py. Writes into the output folder:
//   index.json            neighborhoods with block counts and lengths, NYC totals
//   neighborhoods.geojson simplified outlines for the map
//   streets.json          every street (per borough) with its block count and length
//   hoods/<id>.json       the blocks of one neighborhood
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildCity } from './citylib.mjs';

const [rawPath, outDir] = process.argv.slice(2);
if (!rawPath || !outDir) {
  console.error('usage: node scripts/build_city.mjs RAW.json OUT_DIR');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const hoodsGeo = JSON.parse(readFileSync(new URL('./data/nyc-neighborhoods-2020.geojson', import.meta.url), 'utf8'));
const city = buildCity(raw, hoodsGeo);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'hoods'), { recursive: true });
const write = (name, data) => writeFileSync(join(outDir, name), JSON.stringify(data));
write('index.json', city.index);
write('neighborhoods.geojson', city.outlines);
write('streets.json', city.streets);
for (const [id, file] of Object.entries(city.files)) write(join('hoods', `${id}.json`), file);

const { total, hoods } = city.index;
console.log(`${total.blocks} blocks (${(total.length / 1000).toFixed(0)} km) in ${hoods.length} neighborhoods; ` +
  `${city.outside} blocks outside NYC skipped; ${city.streets.length} streets`);
