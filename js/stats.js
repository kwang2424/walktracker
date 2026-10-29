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

// ---- For the Stats page ----------------------------------------------------

const metersOf = (t) => t.distance ?? polylineLength(t.points);

// Totals across all walks.
export function totals(tracks) {
  let meters = 0, longest = 0;
  for (const t of tracks) {
    const m = metersOf(t);
    meters += m;
    if (m > longest) longest = m;
  }
  return { walks: tracks.length, meters, longest };
}

// Longest run of consecutive days with at least `minMeters` walked.
export function bestStreak(tracks, minMeters = 200) {
  const perDay = new Map();
  for (const t of tracks) {
    const d = new Date(t.startedAt);
    d.setHours(12, 0, 0, 0);
    perDay.set(d.getTime(), (perDay.get(d.getTime()) || 0) + metersOf(t));
  }
  const days = [...perDay].filter(([, m]) => m >= minMeters).map(([k]) => k).sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const day of days) {
    // Noon-to-noon is 23-25 h across daylight saving changes.
    run = prev != null && Math.abs(day - prev - DAY) < 2 * 3600000 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

// The last `weeks` weeks (Monday to Sunday), oldest first:
// [{ start, meters, walks, blocks }]
export function weeklyTotals(tracks, completedAt, weeks = 12, now = Date.now()) {
  const thisWeek = startOfWeek(now);
  const starts = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - 7 * i);
    starts.push(d.getTime());
  }
  const out = starts.map((start) => ({ start, meters: 0, walks: 0, blocks: 0 }));
  const bucket = (time) => {
    if (time < starts[0]) return null;
    let i = starts.length - 1;
    while (i > 0 && time < starts[i]) i--;
    return out[i];
  };
  for (const t of tracks) {
    const b = bucket(t.startedAt);
    if (b) { b.meters += metersOf(t); b.walks++; }
  }
  for (const time of completedAt.values()) {
    const b = bucket(time);
    if (b) b.blocks++;
  }
  return out;
}

// Meters walked per day for the last `weeks` whole weeks (Monday-aligned, so
// it fits a calendar grid), oldest first: [{ date, meters }]
export function dailyTotals(tracks, weeks = 16, now = Date.now()) {
  const first = new Date(startOfWeek(now));
  first.setDate(first.getDate() - 7 * (weeks - 1));
  const days = [];
  const index = new Map();
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    index.set(dayKey(d.getTime()), days.length);
    days.push({ date: d.getTime(), meters: 0 });
  }
  for (const t of tracks) {
    const i = index.get(dayKey(t.startedAt));
    if (i != null) days[i].meters += metersOf(t);
  }
  return days;
}
