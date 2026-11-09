#!/usr/bin/env node
// Refreshes the landmark and subway station lists in scripts/data from NYC's
// open data. They change rarely (a few new landmarks a year), so the results are
// committed and the deploy doesn't depend on these sites being up.
//
//   node scripts/update_places.mjs
//
// Sources:
// - Individual Landmark Sites, NYC Landmarks Preservation Commission (NYC Open Data, buis-pvji)
// - MTA Subway Stations (data.ny.gov, 39hk-dx4f)
// - Privately Owned Public Spaces, NYC Department of City Planning (NYC Open Data, rvih-nhyn)
// - Outdoor Public Art Inventory, NYC Public Design Commission (NYC Open Data, 2pg3-gcaa)
import { writeFileSync } from 'node:fs';
import { simplifyRing } from './citylib.mjs';

const LANDMARKS = 'https://data.cityofnewyork.us/resource/buis-pvji.geojson?$limit=10000';
const STATIONS = 'https://data.ny.gov/resource/39hk-dx4f.json?$limit=10000';
const POPS = 'https://data.cityofnewyork.us/resource/rvih-nhyn.json?$limit=10000';
const ART = 'https://data.cityofnewyork.us/resource/2pg3-gcaa.json?$limit=10000';
const round = (x) => Math.round(x * 1e5) / 1e5;

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

// The landmark outlines come in New York State Plane, Long Island zone (EPSG:2263,
// US survey feet). Convert to latitude/longitude: Lambert Conformal Conic inverse
// on the GRS80 ellipsoid (Snyder, "Map Projections: A Working Manual", 15-9 to 15-11).
export function statePlaneToLatLon(xFt, yFt) {
  const rad = Math.PI / 180;
  const a = 6378137, f = 1 / 298.257222101, e = Math.sqrt(2 * f - f * f);
  const lat1 = (40 + 40 / 60) * rad, lat2 = (41 + 2 / 60) * rad, lat0 = (40 + 10 / 60) * rad, lon0 = -74 * rad;
  const ft = 1200 / 3937, x0 = 300000;
  const m = (p) => Math.cos(p) / Math.sqrt(1 - (e * Math.sin(p)) ** 2);
  const t = (p) => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2);
  const n = (Math.log(m(lat1)) - Math.log(m(lat2))) / (Math.log(t(lat1)) - Math.log(t(lat2)));
  const F = m(lat1) / (n * t(lat1) ** n);
  const rho0 = a * F * t(lat0) ** n;
  const x = xFt * ft - x0, y = yFt * ft;
  const rho = Math.sqrt(x * x + (rho0 - y) ** 2);
  const theta = Math.atan2(x, rho0 - y);
  const tt = (rho / (a * F)) ** (1 / n);
  let lat = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 10; i++) {
    lat = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(lat)) / (1 + e * Math.sin(lat))) ** (e / 2));
  }
  return [lat / rad, (theta / n + lon0) / rad];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await main();

async function main() {
const lpc = await get(LANDMARKS);
// One designation can cover several lots (the Villard Houses are three); those
// become one landmark with several outlines. The 60-odd individually designated
// street lampposts are left out: they'd swamp the list and you can't tell them apart.
const byId = new Map();
lpc.features
  .filter((f) => f.geometry && f.properties.lpc_name && !/^Historic Street Lamppost/i.test(f.properties.lpc_name))
  .map((f) => {
    const p = f.properties;
    // The outline (outer ring of the largest polygon), simplified to ~1 m.
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let ring = polys.map((poly) => poly[0]).sort((a, b) => b.length - a.length)[0];
    // State Plane feet -> [lon, lat] (anything beyond ±180 can't be degrees).
    if (Math.abs(ring[0][0]) > 180) ring = ring.map(([x, y]) => { const [la, lo] = statePlaneToLatLon(x, y); return [lo, la]; });
    return {
      id: p.lpc_lpnumb || `obj-${p.objectid}`,
      name: p.lpc_name.trim(),
      address: (p.address || '').trim(),
      designated: (p.desdate || '').slice(0, 10),
      outline: simplifyRing(ring, 0.00001).map(([x, y]) => [round(x), round(y)]),
    };
  })
  .forEach((l) => {
    const seen = byId.get(l.id);
    if (seen) seen.outlines.push(l.outline);
    else byId.set(l.id, { id: l.id, name: l.name.replace(/\s*\(\d+\)$/, ''), address: l.address, designated: l.designated, outlines: [l.outline] });
  });
// Some single landmarks were designated in parts under separate numbers (the
// Villard Houses are LP-00268 to 00270): merge same-name landmarks within 300 m.
const center = (l) => {
  const pts = l.outlines.flat();
  return [pts.reduce((s, p) => s + p[1], 0) / pts.length, pts.reduce((s, p) => s + p[0], 0) / pts.length];
};
const merged = [];
for (const l of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const [lat, lon] = center(l);
  const twin = merged.find((m) => m.name === l.name && Math.hypot((m.lat - lat) * 111000, (m.lon - lon) * 84000) < 300);
  if (twin) twin.outlines.push(...l.outlines);
  else merged.push({ ...l, lat, lon });
}
const landmarks = merged.map(({ lat, lon, ...l }) => l);

const mta = await get(STATIONS);
const stations = mta
  .map((s) => ({
    station: s.station_id,
    complex: s.complex_id,
    name: s.stop_name,
    routes: (s.daytime_routes || '').split(/\s+/).filter(Boolean),
    borough: s.borough,
    lat: round(Number(s.gtfs_latitude)),
    lon: round(Number(s.gtfs_longitude)),
  }))
  .sort((a, b) => Number(a.station) - Number(b.station));

// Privately owned public spaces: plazas, arcades and atriums anyone may use.
const inNyc = (lat, lon) => lat > 40.47 && lat < 40.93 && lon > -74.28 && lon < -73.68;
const clean = (v) => (v && v !== 'NULL' ? String(v).trim() : '');
const title = (v) => clean(v).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Of|And|The|At|On)\b/g, (w) => w.toLowerCase()).replace(/^./, (c) => c.toUpperCase());
const pops = (await get(POPS))
  .map((p) => ({
    id: clean(p.pops_number),
    name: clean(p.building_name) || title(`${clean(p.address_number)} ${clean(p.street_name)}`),
    address: title(`${clean(p.address_number)} ${clean(p.street_name)}`),
    type: clean(p.public_space_type),
    hours: clean(p.hour_of_access_required),
    year: clean(p.year_completed),
    lat: round(Number(p.latitude)),
    lon: round(Number(p.longitude)),
  }))
  .filter((p) => p.id && inNyc(p.lat, p.lon))
  .sort((a, b) => a.id.localeCompare(b.id));

// Outdoor public art: statues, sculptures, murals and memorials the city looks after.
const art = (await get(ART))
  .map((a, i) => ({
    title: clean(a.title),
    artist: [clean(a.primary_artist_first), clean(a.primary_artist_last)].filter(Boolean).join(' '),
    year: clean(a.date_dedicated) || clean(a.date_created),
    type: clean(a.artwork_type1),
    place: clean(a.location_name),
    lat: round(Number(a.latitude)),
    lon: round(Number(a.longitude)),
    n: i,
  }))
  .filter((a) => a.title && inNyc(a.lat, a.lon))
  .sort((a, b) => a.title.localeCompare(b.title) || a.lat - b.lat)
  .map(({ n, ...a }, i) => ({ id: `PA-${String(i + 1).padStart(4, '0')}`, ...a }));

const note = 'Generated by scripts/update_places.mjs from NYC Open Data and data.ny.gov.';
writeFileSync(new URL('./data/nyc-pops.json', import.meta.url), JSON.stringify({ source: 'NYC Department of City Planning, Privately Owned Public Spaces', note, pops }));
writeFileSync(new URL('./data/nyc-public-art.json', import.meta.url), JSON.stringify({ source: 'NYC Public Design Commission, Outdoor Public Art Inventory', note, art }));
console.log(`${pops.length} privately owned public spaces, ${art.length} pieces of public art`);
writeFileSync(new URL('./data/nyc-landmarks.json', import.meta.url), JSON.stringify({ source: 'NYC Landmarks Preservation Commission, Individual Landmark Sites', note, landmarks }));
writeFileSync(new URL('./data/nyc-subway-stations.json', import.meta.url), JSON.stringify({ source: 'MTA Subway Stations', note, stations }));
console.log(`${landmarks.length} landmarks, ${stations.length} stations in ${new Set(stations.map((s) => s.complex)).size} complexes`);
}
