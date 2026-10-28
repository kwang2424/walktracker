// GPX read/write. Regex-based so it works in Node tests as well as the browser.

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? parseFloat(m[1]) : NaN;
};

// Returns [{ name, points: [[lat, lon, timeMs], ...] }], one entry per <trk> (or per file
// if the GPX only has routes/waypoints-free segments).
export function parseGpx(text) {
  const tracks = [];
  const trkRe = /<trk\b[\s\S]*?<\/trk>/g;
  const blocks = text.match(trkRe) || [text];
  for (const trk of blocks) {
    const nameMatch = trk.match(/<name>([\s\S]*?)<\/name>/);
    const points = [];
    const ptRe = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
    let m;
    while ((m = ptRe.exec(trk))) {
      const lat = attr(m[2], 'lat');
      const lon = attr(m[2], 'lon');
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const timeMatch = m[4] && m[4].match(/<time>([^<]+)<\/time>/);
      const t = timeMatch ? Date.parse(timeMatch[1]) : NaN;
      points.push(Number.isFinite(t) ? [lat, lon, t] : [lat, lon]);
    }
    if (points.length) {
      tracks.push({ name: nameMatch ? decode(nameMatch[1].trim()) : '', points });
    }
  }
  return tracks;
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toGpx(tracks) {
  const body = tracks
    .map((t) => {
      const pts = t.points
        .map((p) => {
          const time = p[2] ? `<time>${new Date(p[2]).toISOString()}</time>` : '';
          return `      <trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}">${time}</trkpt>`;
        })
        .join('\n');
      return `  <trk>\n    <name>${esc(t.name || '')}</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>`;
    })
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="WalkTracker" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `${body}\n</gpx>\n`
  );
}
