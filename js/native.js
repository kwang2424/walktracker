// When WalkTracker runs inside its iPhone app (see ios/), the app supplies GPS
// that keeps working in the background, and can record walks by itself while
// the app is closed. In a normal browser `native` is null and none of this applies.
import { polylineLength } from './geo.js';
import { cleanTrack } from './track.js';

export const native = (typeof window !== 'undefined' && window.walktrackerNative) || null;

// A walk the phone recorded on its own -> a saved walk in the app's format.
// Points may carry accuracy and speed (newer app versions): drop Wi-Fi/cell
// positions (underground, indoors) and train-speed fixes, as the app does.
export const usableFix = (acc, speed) =>
  acc == null || (acc >= 0 && acc <= 35 && !(speed > 7) && (acc <= 20 || speed >= 0));

export function nativeWalkToTrack(w, source = 'auto') {
  // Points: [lat, lon, t, accuracy?, speed?, steps?]. Health routes are already
  // cleaned by Apple; walks the phone recorded get our own clean-up.
  const usable = w.points.filter(([, , , acc, speed]) => usableFix(acc, speed));
  const points = (source === 'health' ? usable : cleanTrack(usable.map(([lat, lon, t, acc, , steps]) => [lat, lon, t, acc, steps >= 0 ? steps : undefined])))
    .map(([lat, lon, t]) => [lat, lon, t]);
  return {
    name: `Walk on ${new Date(w.startedAt).toLocaleDateString([], { weekday: 'long' })}`,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
    duration: w.endedAt - w.startedAt,
    distance: polylineLength(points),
    points,
    source, // 'auto' (recorded by the phone) or 'health' (Apple Health)
    nativeId: w.id,
  };
}
