// Numbers for one walk: moving time, pace and per-kilometer splits, plus
// trimming its start or end. Pure functions; points are [lat, lon, timeMs].
import { haversine, polylineLength } from './geo.js';

const MOVING_MIN = 0.4; // m/s: slower than this counts as stopped (waiting at a light)
const MAX_STEP_GAP = 60000; // ms: longer gaps in the GPS aren't counted as moving

// A walk's length: GPS wobble under STEADY_M doesn't count as walking, and
// gaps (a ride, or a stretch the phone didn't record) aren't counted either.
const STEADY_M = 8;
export const isGap = (a, b) => {
  const dt = (b[2] - a[2]) / 1000;
  if (!Number.isFinite(dt)) return false;
  const d = haversine(a, b);
  return dt > 60 || (d > 100 && d / Math.max(dt, 0.001) > 7);
};

// A step faster than anyone moves on foot: GPS bouncing (off tall buildings,
// say), not walking. Skipped when adding up distance.
const FOOT_MAX = 6; // m/s
const jumpy = (a, b, d) => {
  const dt = (b[2] - a[2]) / 1000;
  return Number.isFinite(dt) && d > 25 && d / Math.max(dt, 0.001) > FOOT_MAX;
};

export function walkDistance(points, breaks = []) {
  const brk = new Set(breaks);
  let d = 0, anchor = null;
  points.forEach((p, i) => {
    if (!anchor || brk.has(i) || isGap(anchor, p)) { anchor = p; return; }
    const s = haversine(anchor, p);
    if (s < STEADY_M) return;
    if (!jumpy(anchor, p, s)) d += s;
    anchor = p;
  });
  return d;
}

export function walkDetails(points, breaks = []) {
  // Some imported walks (GPX files from some apps) have no times: then only
  // the distance is known.
  const timed = points.length > 1 && points.every((p) => Number.isFinite(p[2]));
  if (!timed) return { distance: polylineLength(points), totalMs: 0, movingMs: 0, pace: 0, splits: [], timed: false };
  // Distance as walkDistance counts it (wobble and gaps left out); time moving
  // from point to point.
  const brk = new Set(breaks);
  let distance = 0, movingMs = 0;
  const splits = []; // { km, ms } for each full kilometer, then the rest
  let splitStart = points[0][2], splitDist = 0, anchor = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dt = b[2] - a[2];
    if (dt > 0 && dt <= MAX_STEP_GAP && haversine(a, b) / (dt / 1000) >= MOVING_MIN) movingMs += dt;
    if (brk.has(i) || isGap(anchor, b)) { anchor = b; continue; }
    const d = haversine(anchor, b);
    if (d < STEADY_M) continue;
    const span = b[2] - anchor[2];
    const bounce = jumpy(anchor, b, d);
    anchor = b;
    if (bounce) continue;
    distance += d;
    splitDist += d;
    while (splitDist >= 1000) {
      // Where in this step the kilometer ended, by time.
      const over = splitDist - 1000;
      const tAt = b[2] - (d ? (over / d) * span : 0);
      splits.push({ km: splits.length + 1, ms: tAt - splitStart, full: true });
      splitStart = tAt;
      splitDist = over;
    }
  }
  const end = points[points.length - 1][2];
  if (splitDist >= 100) splits.push({ km: splits.length + splitDist / 1000, ms: end - splitStart, full: false, meters: splitDist });
  const totalMs = end - points[0][2];
  return { distance, totalMs, movingMs, pace: distance > 0 ? movingMs / (distance / 1000) : 0, splits, timed: true };
}

// Is this walk the same walk as one already saved (e.g. an Apple Watch workout
// imported from Apple Health that the phone also recorded by itself)? You can't
// be on two walks at once: more than half of the shorter one at the same time.
export function overlapsSaved(walk, saved) {
  const span = (t) => [t.startedAt, t.endedAt ?? t.points?.[t.points.length - 1]?.[2] ?? t.startedAt];
  const [a0, a1] = span(walk);
  return saved.some((t) => {
    if (t === walk || t.inProgress) return false;
    const [b0, b1] = span(t);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    const shorter = Math.min(a1 - a0, b1 - b0);
    return shorter > 0 && overlap > shorter / 2;
  });
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
