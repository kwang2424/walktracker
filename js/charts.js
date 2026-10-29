// Two small charts for the Stats page, drawn as SVG.
// - Weekly distance: one column per week, single series (the title names it, so no legend).
// - Walking days: a calendar grid, one sequential green ramp from light (a little) to dark (a lot).
// Tap or hover a mark to read its exact values in the line above the chart.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const short = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
const kmText = (m) => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;

// A clean round axis top (1, 2, 5 × 10^n) at or above `max`.
function niceMax(max) {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

// weeks: [{ start, meters, walks, blocks }], oldest first.
export function weeklyChart(container, weeks) {
  container.replaceChildren();
  const readout = document.createElement('div');
  readout.className = 'chart-readout';
  const width = Math.max(260, container.clientWidth || 320);
  const height = 150;
  const pad = { top: 18, right: 4, bottom: 22, left: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxKm = niceMax(Math.max(...weeks.map((w) => w.meters)) / 1000);
  const band = plotW / weeks.length;
  const barW = Math.min(24, band - 6);
  const y = (m) => pad.top + plotH - (m / 1000 / maxKm) * plotH;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart', role: 'img',
    'aria-label': `Distance walked per week, last ${weeks.length} weeks` });
  // Recessive hairline grid: baseline and top value only.
  for (const v of [0, maxKm]) {
    const yy = y(v * 1000);
    svg.append(el('line', { x1: pad.left, x2: width - pad.right, y1: yy, y2: yy, class: 'chart-grid' }));
    const t = el('text', { x: pad.left - 6, y: yy + 4, class: 'chart-tick', 'text-anchor': 'end' });
    t.textContent = `${v} km`;
    svg.append(t);
  }
  const bars = [];
  weeks.forEach((w, i) => {
    const cx = pad.left + band * i + band / 2;
    const top = y(w.meters);
    const h = pad.top + plotH - top;
    if (w.meters > 0) {
      // Rounded 4px data end, square at the baseline.
      const r = Math.min(4, h, barW / 2);
      const x0 = cx - barW / 2, x1 = cx + barW / 2, base = pad.top + plotH;
      const bar = el('path', { class: 'chart-bar',
        d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z` });
      svg.append(bar);
      bars[i] = bar;
    }
    // Labels: first, middle and last week only.
    if (i === 0 || i === weeks.length - 1 || i === Math.floor(weeks.length / 2)) {
      const t = el('text', { x: cx, y: height - 6, class: 'chart-tick', 'text-anchor': 'middle' });
      t.textContent = i === weeks.length - 1 ? 'This week' : short(w.start);
      svg.append(t);
    }
    // Hit target: the whole column band, bigger than the bar.
    const hit = el('rect', { x: pad.left + band * i, y: pad.top, width: band, height: plotH, class: 'chart-hit' });
    hit.addEventListener('pointerenter', () => select(i));
    hit.addEventListener('click', () => select(i));
    svg.append(hit);
  });

  // Direct label on the latest week only.
  const last = weeks[weeks.length - 1];
  if (last.meters > 0) {
    const t = el('text', { x: pad.left + band * (weeks.length - 0.5), y: y(last.meters) - 5, class: 'chart-value', 'text-anchor': 'middle' });
    t.textContent = (last.meters / 1000).toFixed(1);
    svg.append(t);
  }

  // Highlight one week (fading the others) and show its numbers; `focus: false`
  // just shows the numbers, with every bar at full strength.
  function select(i, focus = true) {
    const w = weeks[i];
    bars.forEach((b, j) => b?.classList.toggle('dim', focus && j !== i));
    const label = i === weeks.length - 1 ? 'This week' : `Week of ${short(w.start)}`;
    readout.textContent = `${label}: ${kmText(w.meters)} · ${w.walks} walk${w.walks === 1 ? '' : 's'} · ${w.blocks} new block${w.blocks === 1 ? '' : 's'}`;
  }
  svg.addEventListener('pointerleave', () => select(weeks.length - 1, false));
  select(weeks.length - 1, false);
  container.append(readout, svg);
}

// Walking days: 4 steps of one hue (by km walked that day), plus empty.
const LEVELS = [1000, 3000, 6000]; // < 1 km, 1-3 km, 3-6 km, 6+ km
const level = (m) => (m <= 0 ? 0 : 1 + LEVELS.filter((t) => m >= t).length);

// days: [{ date, meters }], Monday-aligned, oldest first.
export function calendarChart(container, days, now = Date.now()) {
  container.replaceChildren();
  const readout = document.createElement('div');
  readout.className = 'chart-readout';
  const weeks = Math.ceil(days.length / 7);
  const labelW = 28;
  const width = Math.max(260, container.clientWidth || 320);
  const gap = 2;
  const cell = Math.min(18, Math.floor((width - labelW) / weeks) - gap);
  const height = 7 * (cell + gap) + 16;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart', role: 'img',
    'aria-label': `Days walked, last ${weeks} weeks` });
  ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((d, r) => {
    if (!d) return;
    const t = el('text', { x: 0, y: r * (cell + gap) + cell - 3, class: 'chart-tick' });
    t.textContent = d;
    svg.append(t);
  });
  let lastMonth = -1;
  let selected = null;
  days.forEach((d, i) => {
    if (d.date > now) return; // no future days
    const col = Math.floor(i / 7), row = i % 7;
    const x = labelW + col * (cell + gap), yy = row * (cell + gap);
    const rect = el('rect', { x, y: yy, width: cell, height: cell, rx: 3, class: `heat heat-${level(d.meters)}` });
    const pick = () => {
      selected?.classList.remove('picked');
      rect.classList.add('picked');
      selected = rect;
      const date = new Date(d.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      readout.textContent = d.meters > 0 ? `${date}: ${kmText(d.meters)} walked` : `${date}: no walk`;
    };
    rect.addEventListener('pointerenter', pick);
    rect.addEventListener('click', pick);
    svg.append(rect);
    // Month labels along the bottom, at the first week of each month.
    const month = new Date(d.date).getMonth();
    if (row === 0 && month !== lastMonth) {
      lastMonth = month;
      const t = el('text', { x, y: height - 2, class: 'chart-tick' });
      t.textContent = new Date(d.date).toLocaleDateString([], { month: 'short' });
      svg.append(t);
    }
  });
  const walked = days.filter((d) => d.meters > 0).length;
  readout.textContent = `${walked} day${walked === 1 ? '' : 's'} walked in the last ${weeks} weeks`;

  const legend = document.createElement('div');
  legend.className = 'heat-legend';
  legend.innerHTML = '<span>Less</span>' + [0, 1, 2, 3, 4].map((l) => `<i class="heat-${l}"></i>`).join('') + '<span>More</span>';
  container.append(readout, svg, legend);
}
