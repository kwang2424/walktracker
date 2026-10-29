// Achievements: badges for milestones, computed from your progress (nothing
// extra is stored except which ones you've already been told about).

// "Finished" a street or neighborhood means 90% of its length is walked: GPS
// and odd little dead ends make a strict 100% close to impossible.
export const FINISHED = 0.9;

const km = (n) => `${n.toLocaleString()} km`;
const blocks = (n) => `${n.toLocaleString()} block${n === 1 ? '' : 's'}`;

// [id, group, icon, title, description, fact, target]
const DEFS = [
  ['first-block', 'Blocks', '👟', 'First steps', 'Walk your first block', 'blocks', 1],
  ...[10, 100, 500, 1000, 5000, 10000].map((n) => [`blocks-${n}`, 'Blocks', '🧱', blocks(n), `Walk ${blocks(n)}`, 'blocks', n]),
  ...[10, 50, 100, 500, 1000].map((n) => [`km-${n}`, 'Distance', '📏', km(n), `Walk ${km(n)} in total`, 'km', n]),
  ['street-1', 'Streets', '🛣️', 'Street finisher', 'Finish a street (90% of it)', 'streetsDone', 1],
  ...[10, 50, 250].map((n) => [`streets-${n}`, 'Streets', '🛣️', `${n} streets`, `Finish ${n} streets`, 'streetsDone', n]),
  ...[5, 25, 100].map((n) => [`visit-${n}`, 'Neighborhoods', '🧭', `Explorer ${n}`, `Walk in ${n} neighborhoods`, 'hoodsVisited', n]),
  ['hood-half', 'Neighborhoods', '🏘️', 'Halfway home', 'Walk half of a neighborhood', 'hoodsHalf', 1],
  ['hood-1', 'Neighborhoods', '🏙️', 'Local', 'Finish a neighborhood (90% of it)', 'hoodsDone', 1],
  ['hood-5', 'Neighborhoods', '🏙️', 'Know the area', 'Finish 5 neighborhoods', 'hoodsDone', 5],
  ['boroughs-5', 'NYC', '🗽', 'Five boroughs', 'Walk in all five boroughs', 'boroughsVisited', 5],
  ...[1, 5, 10, 25].map((n) => [`city-${n}`, 'NYC', '🌆', `${n}% of NYC`, `Walk ${n}% of NYC's streets`, 'cityPct', n]),
  ...[3, 7, 30].map((n) => [`streak-${n}`, 'Streaks', '🔥', `${n}-day streak`, `Walk ${n} days in a row`, 'bestStreak', n]),
];

export const ACHIEVEMENTS = DEFS.map(([id, group, icon, title, desc, fact, target]) => ({ id, group, icon, title, desc, fact, target }));

// facts: { blocks, km, streetsDone, hoodsVisited, hoodsHalf, hoodsDone, boroughsVisited, cityPct, bestStreak }
export function evaluate(facts) {
  return ACHIEVEMENTS.map((a) => {
    const value = facts[a.fact] ?? 0;
    return { ...a, value, earned: value >= a.target, progress: Math.min(1, value / a.target) };
  });
}

// Facts from the app's numbers. `streets` is [[name, borough, blocks, meters]]
// (streets.json); `walkedByStreet` maps "name|borough" to { walkedLength }.
export function factsFrom({ summary, tracksTotals, streets, walkedByStreet, bestStreak }) {
  const hoods = summary.hoods.filter((h) => h.length);
  let streetsDone = 0;
  for (const [name, borough, , length] of streets || []) {
    const w = walkedByStreet.get(`${name}|${borough}`);
    if (w && w.walkedLength >= FINISHED * length) streetsDone++;
  }
  return {
    blocks: summary.walked,
    km: Math.floor(tracksTotals.meters / 1000),
    streetsDone,
    hoodsVisited: hoods.filter((h) => h.walked > 0).length,
    hoodsHalf: hoods.filter((h) => h.walkedLength >= 0.5 * h.length).length,
    hoodsDone: hoods.filter((h) => h.walkedLength >= FINISHED * h.length).length,
    boroughsVisited: summary.boroughs.filter((b) => b.walked > 0).length,
    cityPct: summary.length ? Math.floor((100 * summary.walkedLength) / summary.length) : 0,
    bestStreak,
  };
}
