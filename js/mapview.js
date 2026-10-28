// The map: Mapbox GL JS with the Mapbox Standard style, plus our own layers for
// blocks and walk lines. Everything outside this file uses [lat, lon]; Mapbox
// wants [lon, lat], so conversions happen here.
/* global mapboxgl */

const STYLE = 'mapbox://styles/mapbox/standard';
const STATE = { none: 0, partial: 1, walked: 2 };
const LIVE_EVERY_MS = 2000; // redraw the live walk line at most this often
export const BLOCKS_MIN_ZOOM = 13; // below this, neighborhoods are shown shaded instead of blocks

const ll = (p) => [p[1], p[0]];
const collection = (features) => ({ type: 'FeatureCollection', features });

// Mapbox Standard settings for a given look. 3D buildings are always off: they
// cost GPU (and battery) and hide the street blocks.
function basemapConfig({ theme, dark }) {
  const full = theme === 'default';
  return {
    theme,
    lightPreset: dark ? 'night' : 'day',
    show3dObjects: false,
    showPointOfInterestLabels: full,
    showTransitLabels: full,
    showLandmarkIcons: false,
    showPedestrianRoads: full,
  };
}

export class MapView {
  constructor(container, { token, theme = 'faded', dark = false, colors, onBlockClick, onHoodClick, onUserMove, onMoveEnd, onAuthError } = {}) {
    this.colors = colors;
    this.look = { theme, dark };
    this.idxOf = new Map(); // block id -> numeric feature id
    this.idOf = []; // numeric feature id -> block id
    this.states = []; // numeric feature id -> STATE value
    this.highlighted = new Set();
    this.blocksData = collection([]);
    this.tracksData = collection([]);
    this.liveData = collection([]);
    this.tracksVisible = true;
    this.hoodsData = collection([]);
    this.hoodStates = new Map(); // feature id -> fraction walked
    this.hoodLit = null;
    this.popup = null;
    this.me = null;

    mapboxgl.accessToken = token;
    this.map = new mapboxgl.Map({
      container,
      style: STYLE,
      config: { basemap: basemapConfig(this.look) },
      projection: 'mercator',
      center: [-73.9866, 40.7306],
      zoom: 15,
      maxZoom: 19,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
      performanceMetricsCollection: false, // don't send Mapbox render-speed reports
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.styleLoaded = false;
    this.map.on('style.load', () => { this.styleLoaded = true; this._addLayers(); });
    this.map.on('dragstart', () => onUserMove?.());
    this.map.on('moveend', () => onMoveEnd?.());
    // Zoomed out, tapping a neighborhood zooms into it. Zoomed in, taps go to blocks.
    this.map.on('click', 'hoods-fill', (e) => {
      if (this.map.getZoom() >= BLOCKS_MIN_ZOOM) return;
      const f = e.features?.[0];
      if (f && onHoodClick) onHoodClick(f.id);
    });
    // Only a refused token that stops the map loading at all counts as a token
    // problem. A single refused tile later on shouldn't send you back to setup.
    this.map.on('error', (e) => {
      const status = e?.error?.status;
      if (status !== 401 && status !== 403) { console.warn('Map:', e?.error?.message || e); return; }
      if (this.styleLoaded) console.warn('Mapbox refused a request', status, e?.error?.url || '');
      else onAuthError?.(status);
    });
    this.map.on('click', 'blocks-hit', (e) => {
      const f = e.features?.[0];
      if (f && onBlockClick) onBlockClick(this.idOf[f.id], [e.lngLat.lat, e.lngLat.lng]);
    });
    this.map.on('mouseenter', 'blocks-hit', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'blocks-hit', () => { this.map.getCanvas().style.cursor = ''; });
  }

  // Mapbox Standard (and styles built on it) offer "slots" for custom layers.
  _isStandard() {
    const style = this.map.getStyle() || {};
    return (style.imports || []).length > 0 || (style.layers || []).some((l) => l.type === 'slot');
  }

  // Our lines sit above roads but under street names, so names stay readable.
  // Mapbox Standard has a "middle" slot for exactly this; other styles get the
  // layers just before their labels.
  _placement() {
    if (this._isStandard()) return { slot: 'middle' };
    const layers = this.map.getStyle().layers;
    let lastShape = -1;
    layers.forEach((l, i) => { if (l.type !== 'symbol') lastShape = i; });
    return { before: layers[lastShape + 1]?.id };
  }

  _addLayers() {
    const m = this.map;
    const c = this.colors;
    const { slot, before } = this._placement();
    const add = (layer) => m.addLayer(slot ? { ...layer, slot } : layer, before);
    m.addSource('tracks', { type: 'geojson', data: this.tracksData });
    m.addSource('live', { type: 'geojson', data: this.liveData });
    m.addSource('blocks', { type: 'geojson', data: this.blocksData });
    m.addSource('hoods', { type: 'geojson', data: this.hoodsData });
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    // Neighborhoods: shaded by progress when zoomed out, a thin outline when zoomed in.
    const pct = ['coalesce', ['feature-state', 'pct'], 0];
    add({
      id: 'hoods-fill', type: 'fill', source: 'hoods',
      paint: {
        'fill-color': ['interpolate', ['linear'], pct, 0, c.unwalked, 0.0001, '#a7f3d0', 0.2, '#34d399', 1, '#047857'],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['>', pct, 0], 0.7, 0.22], 12.5, ['case', ['>', pct, 0], 0.5, 0.15], BLOCKS_MIN_ZOOM + 1, 0],
        'fill-emissive-strength': 1,
      },
    });
    add({
      id: 'hoods-line', type: 'line', source: 'hoods', layout: round,
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'hl'], false], c.walked, c.unwalked],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, ['case', ['boolean', ['feature-state', 'hl'], false], 3, 0.8],
          14, ['case', ['boolean', ['feature-state', 'hl'], false], 4, 1.6]],
        'line-opacity': ['case', ['boolean', ['feature-state', 'hl'], false], 1, 0.8],
        'line-emissive-strength': 1,
      },
    });
    add({
      id: 'tracks', type: 'line', source: 'tracks',
      layout: { ...round, visibility: this.tracksVisible ? 'visible' : 'none' },
      paint: { 'line-color': c.track, 'line-opacity': 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 17, 2.5] },
    });
    add({
      id: 'live', type: 'line', source: 'live', layout: round,
      paint: { 'line-color': c.track, 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 17, 4] },
    });
    const s = ['coalesce', ['feature-state', 's'], 0];
    const hl = ['boolean', ['feature-state', 'hl'], false];
    const width = (none, partial, walked, lit) => ['case', hl, lit, ['match', s, 2, walked, 1, partial, none]];
    add({
      id: 'blocks', type: 'line', source: 'blocks', layout: round, minzoom: BLOCKS_MIN_ZOOM - 0.5,
      paint: {
        'line-color': ['match', s, 2, c.walked, 1, c.partial, c.unwalked],
        'line-opacity': ['match', s, 2, 1, 1, 0.95, 0.7],
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'],
          12, width(0.8, 1.3, 1.8, 4),
          16, width(2.5, 4, 5.5, 10),
          19, width(6, 9, 12, 20)],
        'line-emissive-strength': 1, // keep colors bright under the night light preset
      },
    });
    // Invisible, extra-wide copy so blocks are easy to tap.
    m.addLayer({
      id: 'blocks-hit', type: 'line', source: 'blocks', layout: round, minzoom: BLOCKS_MIN_ZOOM,
      paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 },
    });
    this._applyAllStates();
  }

  _ready() {
    return !!this.map.getSource('blocks');
  }

  _applyAllStates() {
    if (!this._ready()) return;
    this.states.forEach((s, i) => this.map.setFeatureState({ source: 'blocks', id: i }, { s }));
    for (const i of this.highlighted) this.map.setFeatureState({ source: 'blocks', id: i }, { hl: true });
    for (const [i, pct] of this.hoodStates) this.map.setFeatureState({ source: 'hoods', id: i }, { pct });
    if (this.hoodLit != null) this.map.setFeatureState({ source: 'hoods', id: this.hoodLit }, { hl: true });
  }

  // Neighborhood outlines (GeoJSON with numeric feature ids).
  setHoods(geojson) {
    this.hoodsData = geojson;
    this.map.getSource('hoods')?.setData(geojson);
    this._applyAllStates();
  }

  setHoodProgress(i, pct) {
    if (this.hoodStates.get(i) === pct) return;
    this.hoodStates.set(i, pct);
    if (this._ready()) this.map.setFeatureState({ source: 'hoods', id: i }, { pct });
  }

  highlightHood(i) {
    if (this._ready() && this.hoodLit != null) this.map.setFeatureState({ source: 'hoods', id: this.hoodLit }, { hl: false });
    this.hoodLit = i;
    if (this._ready() && i != null) this.map.setFeatureState({ source: 'hoods', id: i }, { hl: true });
  }

  // theme: 'faded' | 'monochrome' | 'default'; dark: night lighting.
  setLook(look) {
    const next = { ...this.look, ...look };
    if (next.theme === this.look.theme && next.dark === this.look.dark) return;
    this.look = next;
    for (const [k, v] of Object.entries(basemapConfig(next))) {
      try { this.map.setConfigProperty('basemap', k, v); } catch (err) { console.warn('Map look not applied', k, err); }
    }
  }

  setColors(colors) {
    this.colors = colors;
    if (!this._ready()) return;
    const s = ['coalesce', ['feature-state', 's'], 0];
    this.map.setPaintProperty('blocks', 'line-color', ['match', s, 2, colors.walked, 1, colors.partial, colors.unwalked]);
    const pct = ['coalesce', ['feature-state', 'pct'], 0];
    this.map.setPaintProperty('hoods-fill', 'fill-color', ['interpolate', ['linear'], pct, 0, colors.unwalked, 0.0001, '#a7f3d0', 0.2, '#34d399', 1, '#047857']);
    this.map.setPaintProperty('tracks', 'line-color', colors.track);
    this.map.setPaintProperty('live', 'line-color', colors.track);
  }

  setBlocks(blocks) {
    this.idxOf = new Map();
    this.idOf = [];
    this.states = [];
    this.highlighted.clear();
    const features = blocks.map((b, i) => {
      this.idxOf.set(b.id, i);
      this.idOf.push(b.id);
      this.states.push(0);
      return { type: 'Feature', id: i, properties: {}, geometry: { type: 'LineString', coordinates: b.coords.map(ll) } };
    });
    this.blocksData = collection(features);
    if (this._ready()) {
      this.map.removeFeatureState({ source: 'blocks' });
      this.map.getSource('blocks').setData(this.blocksData);
    }
  }

  setBlockState(id, state) {
    const i = this.idxOf.get(id);
    if (i == null) return;
    const s = STATE[state] ?? 0;
    if (this.states[i] === s) return;
    this.states[i] = s;
    if (this._ready()) this.map.setFeatureState({ source: 'blocks', id: i }, { s });
  }

  highlight(ids, on) {
    for (const id of ids) {
      const i = this.idxOf.get(id);
      if (i == null) continue;
      if (on) this.highlighted.add(i);
      else this.highlighted.delete(i);
      if (this._ready()) this.map.setFeatureState({ source: 'blocks', id: i }, { hl: on });
    }
  }

  setTracks(pointLists) {
    this.tracksData = collection(pointLists.filter((pts) => pts.length > 1).map((pts) => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map(ll) },
    })));
    this.map.getSource('tracks')?.setData(this.tracksData);
  }

  setTracksVisible(on) {
    this.tracksVisible = on;
    if (this.map.getLayer('tracks')) this.map.setLayoutProperty('tracks', 'visibility', on ? 'visible' : 'none');
  }

  // Throttled: re-sending a long line on every GPS fix would waste battery.
  setLive(points) {
    this.livePoints = points;
    if (!points.length) {
      clearTimeout(this.liveTimer);
      this.liveTimer = null;
      this._pushLive();
      return;
    }
    if (this.liveTimer) return;
    const wait = Math.max(0, (this.liveAt || 0) + LIVE_EVERY_MS - Date.now());
    this.liveTimer = setTimeout(() => { this.liveTimer = null; this._pushLive(); }, wait);
  }

  _pushLive() {
    this.liveAt = Date.now();
    const pts = this.livePoints || [];
    this.liveData = collection(pts.length > 1
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map(ll) } }]
      : []);
    this.map.getSource('live')?.setData(this.liveData);
  }

  showMe(p) {
    if (!this.me) {
      const el = document.createElement('div');
      el.className = 'me-dot';
      this.me = new mapboxgl.Marker({ element: el }).setLngLat(ll(p)).addTo(this.map);
    } else this.me.setLngLat(ll(p));
  }

  openPopup(p, el) {
    this.closePopup();
    this.popup = new mapboxgl.Popup({ maxWidth: '300px', offset: 10, focusAfterOpen: false })
      .setLngLat(ll(p)).setDOMContent(el).addTo(this.map);
  }

  closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  // Fit a list of [lat, lon] points on screen, clear of the cards and buttons.
  fitPoints(points, { maxZoom = 17, animate = true } = {}) {
    if (!points.length) return;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of points) {
      s = Math.min(s, p[0]); n = Math.max(n, p[0]);
      w = Math.min(w, p[1]); e = Math.max(e, p[1]);
    }
    const h = this.map.getContainer().clientHeight;
    const pad = Math.min(40, h / 10);
    this.map.fitBounds([[w, s], [e, n]], {
      padding: { top: Math.min(140, h / 4), bottom: Math.min(120, h / 4), left: pad, right: pad },
      maxZoom, animate, duration: 600,
    });
  }

  flyTo(p, zoom) {
    this.map.easeTo({ center: ll(p), zoom, duration: 800 });
  }

  setView(p, zoom) {
    this.map.jumpTo({ center: ll(p), zoom });
  }

  panTo(p) {
    this.map.easeTo({ center: ll(p), duration: 600 });
  }

  getZoom() {
    return this.map.getZoom();
  }

  getCenter() {
    const c = this.map.getCenter();
    return [c.lat, c.lng];
  }

  getBBox() {
    const b = this.map.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  }

  // True when p is off screen or within `margin` (share of the screen) of an edge.
  isNearEdge(p, margin = 0.25) {
    const { x, y } = this.map.project(ll(p));
    const el = this.map.getContainer();
    const w = el.clientWidth, h = el.clientHeight;
    return x < w * margin || x > w * (1 - margin) || y < h * margin || y > h * (1 - margin);
  }
}
