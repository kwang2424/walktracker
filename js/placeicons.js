// Map badges for landmarks and subway stations, drawn in the style of Mapbox's
// own point-of-interest icons: a round badge with a simple white glyph.
// Not visited yet: an outlined badge. Visited: a filled one.

export const PLACE_COLORS = { landmark: '#b7791f', station: '#6d28d9' };
const DARK_COLORS = { landmark: '#e0a43a', station: '#9f7aea' }; // brighter on the night map

const SIZE = 24; // CSS pixels

// Glyphs on a 24x24 grid, centered on (12, 12).
function train(ctx) {
  ctx.beginPath();
  ctx.roundRect(7.5, 5.5, 9, 10.5, 2.6);
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(9, 7.3, 6, 3.4, 0.9); // windscreen
  ctx.fill();
  ctx.beginPath();
  ctx.arc(9.9, 13.4, 0.95, 0, Math.PI * 2); // headlights
  ctx.arc(14.1, 13.4, 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(9.4, 16.6); ctx.lineTo(8, 18.6); // legs
  ctx.moveTo(14.6, 16.6); ctx.lineTo(16, 18.6);
  ctx.stroke();
}

function monument(ctx) {
  ctx.beginPath(); // pediment
  ctx.moveTo(6.4, 9.3); ctx.lineTo(12, 5.6); ctx.lineTo(17.6, 9.3); ctx.closePath();
  ctx.fill();
  ctx.fillRect(6.8, 9.9, 10.4, 1.1); // beam
  for (const x of [7.5, 10.1, 12.7, 15.3]) ctx.fillRect(x, 11.7, 1.2, 4.5); // columns
  ctx.fillRect(6, 16.9, 12, 1.6); // steps
}

const GLYPH = { station: train, landmark: monument };

// Draws one badge. Returns the canvas (size * ratio pixels square).
export function drawBadge(kind, visited, { dark = false, ratio = 2 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const color = (dark ? DARK_COLORS : PLACE_COLORS)[kind];
  const blank = dark ? '#1f2937' : '#ffffff';
  // A soft halo, like Mapbox's icons, so badges read on any background.
  ctx.beginPath();
  ctx.arc(12, 12, 11.5, 0, Math.PI * 2);
  ctx.fillStyle = dark ? 'rgba(15,23,42,0.85)' : 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(12, 12, 10, 0, Math.PI * 2);
  ctx.fillStyle = visited ? color : blank;
  ctx.fill();
  if (!visited) {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(12, 12, 9.2, 0, Math.PI * 2);
    ctx.stroke();
  }
  const ink = visited ? '#ffffff' : color;
  // Draw the glyph on its own layer so its cut-outs don't punch through the badge.
  const g = document.createElement('canvas');
  g.width = g.height = SIZE * ratio;
  const gctx = g.getContext('2d');
  gctx.scale(ratio, ratio);
  if (!visited) { // a smaller glyph keeps the outlined badge light
    gctx.translate(12, 12); gctx.scale(0.82, 0.82); gctx.translate(-12, -12);
  }
  gctx.fillStyle = gctx.strokeStyle = ink;
  GLYPH[kind](gctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(g, 0, 0);
  return canvas;
}

export const badgeName = (kind, visited) => `wt-${kind}-${visited ? 'on' : 'off'}`;
