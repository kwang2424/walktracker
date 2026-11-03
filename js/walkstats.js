// Numbers for one walk: moving time, pace and per-kilometer splits, plus
// trimming its start or end. Pure functions; points are [lat, lon, timeMs].
import { haversine, polylineLength } from './geo.js';

const MOVING_MIN = 0.4; // m/s: slower than this counts as stopped (waiting at a light)
const MAX_STEP_GAP = 60000; // ms: longer gaps in the GPS aren't counted as moving

export function walkDetails(points) {
  let distance = 0, movingMs = 0;
  const splits = []; // { km, ms } for each full kilometer, then the rest
  let splitStart = points[0]?.[2], splitDist = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = haversine(a, b);
    const dt = b[2] - a[2];
    distance += d;
    if (dt > 0 && dt <= MAX_STEP_GAP && d / (dt / 1000) >= MOVING_MIN) movingMs += dt;
    splitDist += d;
    while (splitDist >= 1000) {
      // Where in this step the kilometer ended, by time.
      const over = splitDist - 1000;
      const tAt = b[2] - (d ? (over / d) * dt : 0);
      splits.push({ km: splits.length + 1, ms: tAt - splitStart, full: true });
      splitStart = tAt;
      splitDist = over;
    }
  }
  const end = points[points.length - 1]?.[2];
  if (splitDist >= 100 && end != null) splits.push({ km: splits.length + splitDist / 1000, ms: end - splitStart, full: false, meters: splitDist });
  const totalMs = points.length > 1 ? end - points[0][2] : 0;
  return { distance, totalMs, movingMs, pace: distance > 0 ? movingMs / (distance / 1000) : 0, splits };
}

// "12:34" per km.
export function formatPace(msPerKm) {
  if (!msPerKm || !Number.isFinite(msPerKm)) return '–';
  const s = Math.round(msPerKm / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A walk cut down to points i0..i1. The full original is kept (track.original)
// so the trim can be undone.
export function trimWalk(track, i0, i1) {
  const original = track.original || track.points;
  const points = original.slice(i0, i1 + 1);
  const startedAt = points[0]?.[2] ?? track.startedAt;
  const endedAt = points[points.length - 1]?.[2] ?? track.endedAt;
  return { ...track, original, trim: [i0, i1], points, startedAt, endedAt, duration: endedAt - startedAt, distance: polylineLength(points) };
}

export function untrimWalk(track) {
  if (!track.original) return track;
  const { original, trim, ...rest } = track;
  const points = original;
  const startedAt = points[0]?.[2] ?? track.startedAt;
  const endedAt = points[points.length - 1]?.[2] ?? track.endedAt;
  return { ...rest, points, startedAt, endedAt, duration: endedAt - startedAt, distance: polylineLength(points) };
}
