// When WalkTracker runs inside its iPhone app (see ios/), the app supplies GPS
// that keeps working in the background, and can record walks by itself while
// the app is closed. In a normal browser `native` is null and none of this applies.
import { cleanTrack } from './track.js';
import { isGap, walkDistance } from './walkstats.js';

export const native = (typeof window !== 'undefined' && window.walktrackerNative) || null;

// A walk the phone recorded on its own -> a saved walk in the app's format.
// Points may carry accuracy and speed (newer app versions): drop Wi-Fi/cell
// positions (underground, indoors) and train-speed fixes, as the app does.
export const usableFix = (acc, speed) =>
  acc == null || (acc >= 0 && acc <= 35 && !(speed > 7) && (acc <= 10 || speed >= 0));

// Steps during a walk: the phone's running count is in each point (index 5,
// -1 if unknown); it restarts when GPS does, so add up only the increases.
export function stepsOf(points) {
  let total = 0, last = null, any = false;
  for (const p of points) {
    const s = p[5];
    if (s == null || s < 0) continue;
    if (last != null && s >= last) total += s - last;
    last = s;
    any = true;
  }
  return any ? total : null;
}

export function nativeWalkToTrack(w, source = 'auto') {
  // Points: [lat, lon, t, accuracy?, speed?, steps?, gap?]. Health routes are
  // already cleaned by Apple; walks the phone recorded get our own clean-up.
  // gap = 1: the phone skipped points just before this one (a no-tracking
  // area), so the walk has a break there.
  const usable = w.points.filter(([, , , acc, speed]) => usableFix(acc, speed));
  let points = [];
  const breaks = [];
  if (source === 'health') points = usable.map(([lat, lon, t]) => [lat, lon, t]);
  else {
    const runs = [];
    for (const p of usable) {
      if (!runs.length || p[6] === 1) runs.push([]);
      runs[runs.length - 1].push(p);
    }
    for (const run of runs) {
      const clean = cleanTrack(run.map(([lat, lon, t, acc, , steps]) => [lat, lon, t, acc, steps >= 0 ? steps : undefined]));
      if (!clean.length) continue;
      if (points.length) breaks.push(points.length);
      points.push(...clean.map(([lat, lon, t]) => [lat, lon, t]));
    }
    // A gap in the middle (over a minute, or a jump faster than walking: a
    // short ride the phone skipped) splits the walk, so nothing joins across it.
    for (let i = 1; i < points.length; i++) if (isGap(points[i - 1], points[i]) && !breaks.includes(i)) breaks.push(i);
    breaks.sort((a, b) => a - b);
  }
  return {
    name: `Walk on ${new Date(w.startedAt).toLocaleDateString([], { weekday: 'long' })}`,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
    duration: w.endedAt - w.startedAt,
    distance: walkDistance(points, breaks),
    points,
    source, // 'auto' (recorded by the phone) or 'health' (Apple Health)
    nativeId: w.id,
    ...(breaks.length && { breaks }),
    ...(stepsOf(w.points) != null && { steps: stepsOf(w.points) }),
  };
}
