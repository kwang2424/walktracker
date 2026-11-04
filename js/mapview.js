// The map: Mapbox GL JS with the Mapbox Standard style, plus our own layers for
// blocks and walk lines. Everything outside this file uses [lat, lon]; Mapbox
// wants [lon, lat], so conversions happen here.
/* global mapboxgl */

import { drawBadge, badgeName } from './placeicons.js';
import { zoneRing } from './zones.js';

const STYLE = 'mapbox://styles/mapbox/standard';
const STATE = { none: 0, partial: 1, walked: 2 };
const LIVE_EVERY_MS = 2000; // redraw the live walk line at most this often
export const BLOCKS_MIN_ZOOM = 13; // below this, neighborhoods are shown shaded instead of blocks
export const PATHS_MIN_ZOOM = 14.5; // park paths are dense; show them a bit closer in
export { PLACE_COLORS } from './placeicons.js';

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
    showTransitLabels: false, // our own station badges replace Mapbox's (one icon per station, always lined up)
    showLandmarkIcons: false,
    showPedestrianRoads: full,
  };
}

export class MapView {
  constructor(container, { token, theme = 'faded', dark = false, colors, onBlockClick, onHoodClick, onPlaceClick, onUserMove, onMoveEnd, onAuthError } = {}) {
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
    this.placesData = collection([]);
    this.zonesData = collection([]);
    this.heatData = collection([]);
    this.heatVisible = false;
    this.trimData = collection([]);
    this.replayData = collection([]);
    this.placeVisited = new Map(); // place index -> true
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
    // One tap handler, in priority order: a landmark or station dot, then (zoomed
    // out) the neighborhood, then (zoomed in) the block.
    this.map.on('click', (e) => {
      if (!this._ready()) return;
      // While picking a block for a no-tracking area, a tap only picks.
      if (this.onPick) return this.onPick([e.lngLat.lat, e.lngLat.lng]);
      const pad = 10; // finger-sized
      const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
      const place = this.map.queryRenderedFeatures(box, { layers: ['places'] })[0];
      if (place) return onPlaceClick?.(place.properties.i);
      if (this.map.getZoom() < BLOCKS_MIN_ZOOM) {
        const hood = this.map.queryRenderedFeatures(e.point, { layers: ['hoods-fill'] })[0];
        if (hood) return onHoodClick?.(hood.id);
        return;
      }
      // Streets win over paths when both are under the finger.
      const hits = this.map.queryRenderedFeatures(e.point, { layers: ['blocks-hit'] });
      const block = hits.find((f) => !f.properties.p) || (this.map.getZoom() >= PATHS_MIN_ZOOM - 0.5 ? hits[0] : undefined);
      if (block) onBlockClick?.(this.idOf[block.id], [e.lngLat.lat, e.lngLat.lng]);
    });
    // Only a refused token that stops the map loading at all counts as a token
    // problem. A single refused tile later on shouldn't send you back to setup.
    this.map.on('error', (e) => {
      const status = e?.error?.status;
      if (status !== 401 && status !== 403) { console.warn('Map:', e?.error?.message || e); return; }
      if (this.styleLoaded) console.warn('Mapbox refused a request', status, e?.error?.url || '');
      else onAuthError?.(status);
    });
    for (const layer of ['blocks-hit', 'places']) {
      this.map.on('mouseenter', layer, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layer, () => { this.map.getCanvas().style.cursor = ''; });
    }
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
    const isPath = ['==', ['get', 'p'], 1];
    // Park paths, trails and plazas: dotted, shown once zoomed in a little more.
    add({
      id: 'paths', type: 'line', source: 'blocks', layout: round, minzoom: PATHS_MIN_ZOOM - 0.5, filter: isPath,
      paint: {
        'line-color': ['match', s, 2, c.walked, 1, c.partial, c.unwalked],
        'line-opacity': ['match', s, 2, 1, 1, 0.95, 0.75],
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'],
          14, width(1.2, 1.6, 2, 4),
          16, width(2.2, 3, 3.5, 8),
          19, width(4, 6, 7, 14)],
        'line-dasharray': [0.1, 1.8],
        'line-emissive-strength': 1,
      },
    });
    add({
      id: 'blocks', type: 'line', source: 'blocks', layout: round, minzoom: BLOCKS_MIN_ZOOM - 0.5, filter: ['!', isPath],
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
    // Personal heatmap: blue where you've walked once, glowing yellow to red
    // where you walk all the time (points every ~10 m from every walk).
    m.addSource('heat', { type: 'geojson', data: this.heatData });
    add({
      id: 'heat', type: 'heatmap', source: 'heat', layout: { visibility: this.heatVisible ? 'visible' : 'none' },
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.25, 14, 0.6, 17, 1.2],
        'heatmap-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 2, 14, 6, 16, 12, 19, 40],
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)', 0.05, 'rgba(37,99,235,0.35)', 0.25, 'rgba(37,99,235,0.8)', 0.5, '#06b6d4', 0.75, '#facc15', 1, '#ef4444'],
        'heatmap-opacity': 0.85,
      },
    });
    // Trimming a walk: the part kept, and the parts being cut off.
    m.addSource('trim', { type: 'geojson', data: this.trimData });
    add({
      id: 'trim-cut', type: 'line', source: 'trim', layout: round, filter: ['==', ['get', 'cut'], 1],
      paint: { 'line-color': '#9ca3af', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 17, 5], 'line-opacity': 0.8, 'line-dasharray': [1, 1.6], 'line-emissive-strength': 1 },
    });
    add({
      id: 'trim', type: 'line', source: 'trim', layout: round, filter: ['==', ['get', 'cut'], 0],
      paint: { 'line-color': c.track, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 6], 'line-opacity': 0.95, 'line-emissive-strength': 1 },
    });
    // Replaying a walk: the line so far and a dot at its head.
    m.addSource('replay', { type: 'geojson', data: this.replayData });
    add({
      id: 'replay-line', type: 'line', source: 'replay', layout: round, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': c.track, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 6], 'line-opacity': 0.95, 'line-emissive-strength': 1 },
    });
    add({
      id: 'replay-head', type: 'circle', source: 'replay', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 7, 'circle-color': c.track, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3, 'circle-emissive-strength': 1 },
    });
    // No-tracking areas: a light shaded circle with a dashed edge; the one
    // being placed is drawn in the accent color.
    m.addSource('zones', { type: 'geojson', data: this.zonesData });
    const editing = ['==', ['get', 'edit'], 1];
    add({
      id: 'zones-fill', type: 'fill', source: 'zones',
      paint: { 'fill-color': ['case', editing, c.walked, '#64748b'], 'fill-opacity': ['case', editing, 0.18, 0.12], 'fill-emissive-strength': 1 },
    });
    add({
      id: 'zones-line', type: 'line', source: 'zones', layout: round,
      paint: { 'line-color': ['case', editing, c.walked, '#64748b'], 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.8, 'line-emissive-strength': 1 },
    });
    // Landmarks and subway stations: round badges, outlined until visited.
    // Station names show from zoom 15, landmark names from 17.
    this._addBadges();
    m.addSource('places', { type: 'geojson', data: this.placesData });
    const kind = ['get', 'kind'];
    const layer = {
      id: 'places', type: 'symbol', source: 'places', minzoom: 12.5, filter: this._placeFilter(),
      layout: {
        'icon-image': ['concat', 'wt-', kind, ['case', ['get', 'v'], '-on', '-off']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.55, 15, 0.85, 17, 1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['==', kind, 'station'], 1, 0],
        'text-field': ['step', ['zoom'], '', 15, ['match', kind, 'station', ['get', 'name'], ''], 17, ['get', 'name']],
        'text-font': this._fonts(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10.5, 18, 12.5],
        'text-anchor': 'top',
        'text-offset': [0, 1.1],
        'text-max-width': 8,
        'text-optional': true,
      },
      paint: {
        'text-color': this.look.dark ? '#e5e7eb' : '#374151',
        'text-halo-color': this.look.dark ? 'rgba(17,24,39,0.9)' : 'rgba(255,255,255,0.95)',
        'text-halo-width': 1.4,
        'icon-emissive-strength': 1,
        'text-emissive-strength': 1,
      },
    };
    // Above street names, like Mapbox's own points of interest.
    m.addLayer(this._isStandard() ? { ...layer, slot: 'top' } : layer);
    this._applyAllStates();
  }

  // Fonts for our labels: Mapbox's own in Standard, else whatever the style uses.
  _fonts() {
    if (this._isStandard()) return ['DIN Pro Medium', 'Arial Unicode MS Regular'];
    const withFont = (this.map.getStyle().layers || []).find((l) => Array.isArray(l.layout?.['text-font']));
    return withFont ? withFont.layout['text-font'] : ['Open Sans Regular'];
  }

  _addBadges() {
    for (const kind of ['landmark', 'station']) {
      for (const visited of [false, true]) {
        const canvas = drawBadge(kind, visited, { dark: this.look.dark, ratio: 2 });
        const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const name = badgeName(kind, visited);
        if (this.map.hasImage(name)) this.map.updateImage(name, image);
        else this.map.addImage(name, image, { pixelRatio: 2 });
      }
    }
  }

  // No-tracking areas ([{ lat, lon, r }]) and, while adding one, its preview.
  setZones(zones, preview = null) {
    const features = [...zones, ...(preview ? [{ ...preview, edit: 1 }] : [])].map((z) => ({
      type: 'Feature', properties: { edit: z.edit || 0 }, geometry: { type: 'Polygon', coordinates: [zoneRing(z)] },
    }));
    this.zonesData = collection(features);
    this.map.getSource('zones')?.setData(this.zonesData);
  }

  // Which kinds of places to show: { landmark: true, station: true }.
  setPlaceKinds(kinds) {
    this.placeKinds = { ...this.placeKinds, ...kinds };
    if (this.map.getLayer('places')) this.map.setFilter('places', this._placeFilter());
  }

  _placeFilter() {
    const on = Object.entries(this.placeKinds || { landmark: true, station: true }).filter(([, v]) => v).map(([k]) => k);
    return on.length ? ['in', ['get', 'kind'], ['literal', on]] : ['==', 1, 0];
  }

  // Landmarks and stations: [{ index, kind, name, lat, lon, spots? }]. A station
  // gets a badge at each of its platforms (merged when close together), so big
  // complexes like Atlantic Av-Barclays Ctr show where each part really is.
  setPlaces(items) {
    this.placeItems = items;
    this._renderPlaces();
  }

  _renderPlaces() {
    const features = [];
    for (const p of this.placeItems || []) {
      const v = !!this.placeVisited.get(p.index);
      (p.spots || [[p.lat, p.lon]]).forEach(([lat, lon], n) => {
        features.push({
          // Big complexes have several badges; only the first is labeled.
          type: 'Feature', id: features.length, properties: { i: p.index, kind: p.kind, name: n ? '' : p.name, v },
          geometry: { type: 'Point', coordinates: [lon, lat] },
        });
      });
    }
    this.placesData = collection(features);
    this.map.getSource('places')?.setData(this.placesData);
  }

  // Visits change rarely; redraw the badges once per frame at most.
  setPlaceVisited(index, on = true) {
    if (!!this.placeVisited.get(index) === on) return;
    this.placeVisited.set(index, on);
    if (this.placesQueued) return;
    this.placesQueued = true;
    requestAnimationFrame(() => { this.placesQueued = false; this._renderPlaces(); });
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
    const darkChanged = next.dark !== this.look.dark;
    this.look = next;
    if (darkChanged && this.map.getLayer('places')) {
      this._addBadges();
      this.map.setPaintProperty('places', 'text-color', next.dark ? '#e5e7eb' : '#374151');
      this.map.setPaintProperty('places', 'text-halo-color', next.dark ? 'rgba(17,24,39,0.9)' : 'rgba(255,255,255,0.95)');
    }
    for (const [k, v] of Object.entries(basemapConfig(next))) {
      try { this.map.setConfigProperty('basemap', k, v); } catch (err) { console.warn('Map look not applied', k, err); }
    }
  }

  setColors(colors) {
    this.colors = colors;
    if (!this._ready()) return;
    const s = ['coalesce', ['feature-state', 's'], 0];
    this.map.setPaintProperty('blocks', 'line-color', ['match', s, 2, colors.walked, 1, colors.partial, colors.unwalked]);
    this.map.setPaintProperty('paths', 'line-color', ['match', s, 2, colors.walked, 1, colors.partial, colors.unwalked]);
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
      return { type: 'Feature', id: i, properties: b.path ? { p: 1 } : {}, geometry: { type: 'LineString', coordinates: b.coords.map(ll) } };
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

  // Heatmap points: [[lat, lon]].
  setHeat(points) {
    this.heatData = collection(points.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ll(p) } })));
    this.map.getSource('heat')?.setData(this.heatData);
  }

  setHeatVisible(on) {
    this.heatVisible = on;
    if (this.map.getLayer('heat')) this.map.setLayoutProperty('heat', 'visibility', on ? 'visible' : 'none');
  }

  // A walk being replayed, drawn up to point k (null clears it).
  setReplay(points, k) {
    const shown = points ? points.slice(0, k + 1) : [];
    this.replayData = collection(shown.length ? [
      ...(shown.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: shown.map(ll) } }] : []),
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ll(shown[shown.length - 1]) } },
    ] : []);
    this.map.getSource('replay')?.setData(this.replayData);
  }

  // A walk being trimmed: points [[lat, lon]], keeping indexes i0..i1.
  setTrim(points, i0, i1) {
    const line = (pts, cut) => (pts.length > 1 ? [{ type: 'Feature', properties: { cut }, geometry: { type: 'LineString', coordinates: pts.map(ll) } }] : []);
    this.trimData = collection(points.length ? [
      ...line(points.slice(0, i0 + 1), 1), ...line(points.slice(i1), 1), ...line(points.slice(i0, i1 + 1), 0),
    ] : []);
    this.map.getSource('trim')?.setData(this.trimData);
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
  fitPoints(points, { maxZoom = 17, animate = true, bottom = null } = {}) {
    if (!points.length) return;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of points) {
      s = Math.min(s, p[0]); n = Math.max(n, p[0]);
      w = Math.min(w, p[1]); e = Math.max(e, p[1]);
    }
    const h = this.map.getContainer().clientHeight;
    const pad = Math.min(40, h / 10);
    this.map.fitBounds([[w, s], [e, n]], {
      padding: { top: Math.min(140, h / 4), bottom: bottom ?? Math.min(120, h / 4), left: pad, right: pad },
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
