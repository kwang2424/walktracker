// No-tracking areas (like Strava's privacy zones): circles around places such
// as your office or home. GPS points inside them don't count toward blocks,
// landmarks or walk lines. Saved walks aren't changed: remove an area and those
// parts count again. Zones: [{ id, name, lat, lon, r }], r in meters.
import { haversine } from './geo.js';

export const ZONE_SIZES = [
  { r: 100, label: 'Small' },
  { r: 175, label: 'Medium' },
  { r: 300, label: 'Large' },
];

export const inZone = (p, zones) => zones.some((z) => haversine(p, [z.lat, z.lon]) <= z.r);

// A walk with its points inside any zone left out (a new object when anything
// was removed, so the walk's id and times stay the same).
export function withoutZones(track, zones) {
  if (!zones.length) return track;
  const points = track.points.filter((p) => !inZone(p, zones));
  return points.length === track.points.length ? track : { ...track, points, bbox: undefined };
}

// A circle as a GeoJSON polygon ring ([lon, lat]), for drawing.
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
