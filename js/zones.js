// No-tracking areas (like Strava's privacy zones): circles around places such
// as your office or home. GPS points inside them don't count toward blocks,
// landmarks or walk lines. Saved walks aren't changed: remove an area and those
// parts count again. Zones: [{ id, name, lat, lon, r }] (a circle, r in meters)
// or [{ id, name, lat, lon, ring: [[lat, lon]], pad }] (one city block, traced
// along its streets; pad = meters of slack around it).
import { haversine, makeProjector, pointInMultiPolygon, pointSegDist } from './geo.js';

export const BLOCK_PAD = 8;

export const ZONE_SIZES = [
  { r: 100, label: 'Small' },
  { r: 175, label: 'Medium' },
  { r: 300, label: 'Large' },
];

export const inZone = (p, zones) => zones.some((z) => (z.ring ? inRing(p, z) : haversine(p, [z.lat, z.lon]) <= z.r));

function inRing(p, z) {
  // A quick bounding-box check first: most points are nowhere near.
  const box = z.box || (z.box = ringBox(z.ring, z.pad ?? BLOCK_PAD));
  if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3]) return false;
  if (pointInMultiPolygon(p, [[z.ring.map(([la, lo]) => [lo, la])]])) return true;
  const project = makeProjector(z.lat);
  const q = project(p);
  const pts = z.ring.map(project);
  for (let i = 1; i < pts.length; i++) if (pointSegDist(q, pts[i - 1], pts[i]) <= (z.pad ?? BLOCK_PAD)) return true;
  return false;
}

function ringBox(ring, pad) {
  const lats = ring.map((p) => p[0]), lons = ring.map((p) => p[1]);
  const dLat = pad / 111320, dLon = pad / (111320 * Math.cos((lats[0] * Math.PI) / 180));
  return [Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon];
}

// A walk with its points inside any zone left out (a new object when anything
// was removed, so the walk's id and times stay the same). Where points were
// removed the walk gets a break (track.breaks: indexes i where point i-1 and
// point i must not be joined), so nothing fills the gap back in.
export function withoutZones(track, zones) {
  if (!zones.length) return track;
  const old = new Set(track.breaks || []);
  const points = [], breaks = [];
  let gap = false;
  track.points.forEach((p, i) => {
    if (inZone(p, zones)) { gap = true; return; }
    if (points.length && (gap || old.has(i))) breaks.push(points.length);
    gap = false;
    points.push(p);
  });
  if (points.length === track.points.length) return track;
  return { ...track, points, breaks, bbox: undefined };
}

// A walk's points split at its breaks: [[...points], ...].
export function runsOf(track) {
  if (!track.breaks?.length) return [track.points];
  const runs = [];
  let start = 0;
  for (const b of [...track.breaks].sort((a, b) => a - b)) {
    if (b > start) runs.push(track.points.slice(start, b));
    start = b;
  }
  runs.push(track.points.slice(start));
  return runs.filter((r) => r.length);
}

// An area's outline as a GeoJSON polygon ring ([lon, lat]), for drawing.
export function zoneRing(z) {
  if (!z.ring) return circleRing(z);
  const ring = z.ring.map(([la, lo]) => [lo, la]);
  const [a, b] = [ring[0], ring[ring.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push(a);
  return ring;
}

export function circleRing(z, steps = 48) {
  const ring = [];
  const dLat = z.r / 111320;
  const dLon = z.r / (111320 * Math.cos((z.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([z.lon + dLon * Math.cos(a), z.lat + dLat * Math.sin(a)]);
  }
  return ring;
}
