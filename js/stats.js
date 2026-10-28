// Progress-over-time stats. Pure functions; no DOM.
import { polylineLength } from './geo.js';

const DAY = 86400000;

// Feeds tracks into the engine oldest first and notes when each block was finished.
// Returns { completedAt: Map<blockId, time>, newByTrack: Map<trackId, count> }.
export function replayTracks(engine, tracks) {
  const completedAt = new Map();
  const newByTrack = new Map();
  for (const t of [...tracks].sort((a, b) => a.startedAt - b.startedAt)) {
    let n = 0;
    for (const id of engine.addTrack(t.points)) {
      if (!completedAt.has(id) && engine.isWalked(id)) {
        completedAt.set(id, t.startedAt);
        n++;
      }
    }
    newByTrack.set(t.id, n);
  }
  return { completedAt, newByTrack };
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Days in a row (ending today, or yesterday if you haven't walked yet today)
// with at least `minMeters` walked.
export function streak(tracks, now = Date.now(), minMeters = 200) {
  const perDay = new Map();
  for (const t of tracks) {
    const k = dayKey(t.startedAt);
    perDay.set(k, (perDay.get(k) || 0) + (t.distance ?? polylineLength(t.points)));
  }
  const walkedOn = (ms) => (perDay.get(dayKey(ms)) || 0) >= minMeters;
  let day = new Date(now);
  day.setHours(12, 0, 0, 0); // noon avoids daylight-saving edge cases
  if (!walkedOn(day.getTime())) day = new Date(day.getTime() - DAY);
  let n = 0;
  while (walkedOn(day.getTime())) {
    n++;
    day = new Date(day.getTime() - DAY);
  }
  return n;
}

export function startOfWeek(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

export function weekStats(tracks, completedAt, now = Date.now()) {
  const from = startOfWeek(now);
  let meters = 0, walks = 0, blocks = 0;
  for (const t of tracks) {
    if (t.startedAt < from) continue;
    walks++;
    meters += t.distance ?? polylineLength(t.points);
  }
  for (const time of completedAt.values()) if (time >= from) blocks++;
  return { meters, walks, blocks };
}
