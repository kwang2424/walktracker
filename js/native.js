// When WalkTracker runs inside its iPhone app (see ios/), the app supplies GPS
// that keeps working in the background, and can record walks by itself while
// the app is closed. In a normal browser `native` is null and none of this applies.
import { polylineLength } from './geo.js';

export const native = (typeof window !== 'undefined' && window.walktrackerNative) || null;

// A walk the phone recorded on its own -> a saved walk in the app's format.
export function nativeWalkToTrack(w, source = 'auto') {
  const points = w.points.map(([lat, lon, t]) => [lat, lon, t]);
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
