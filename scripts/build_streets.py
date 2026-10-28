#!/usr/bin/env python3
"""Build the app's street data from an OpenStreetMap .osm.pbf extract.

The output is a folder of small tiles that the app downloads from its own
site, so adding an area doesn't depend on the busy public Overpass servers.

    python3 scripts/build_streets.py data/streets scripts/regions.json OSM_DIR

OSM_DIR holds <region name>.osm.pbf for each region in regions.json (see
download_extracts.py). Regions without a file are skipped. Only streets
inside each region's bounding box are kept.

Each tile is <x>_<y>.json, holding the walkable streets that touch a
TILE_DEG x TILE_DEG square, in the same format Overpass returns. index.json
lists the tiles, each region's bounds, and neighborhood names.
"""
import json
import math
import os
import sys
from datetime import datetime, timezone

import osmium

TILE_DEG = 0.02  # about 2.2 km x 1.7 km in New York

# Keep in sync with WALKABLE_HIGHWAYS and overpassQuery() in js/geo.js.
WALKABLE = {
    'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary',
    'tertiary_link', 'residential', 'unclassified', 'living_street', 'pedestrian',
}
PLACES = {'neighbourhood', 'quarter', 'suburb', 'borough', 'city_district', 'town', 'village', 'city'}


def tile_of(lat, lon):
    return math.floor(lon / TILE_DEG), math.floor(lat / TILE_DEG)


def walkable(tags):
    if tags.get('highway') not in WALKABLE:
        return False
    if tags.get('area') == 'yes' or tags.get('foot') == 'no':
        return False
    return tags.get('access') not in ('private', 'no')


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = {}  # id -> ([node ids], name, highway)
        self.nodes = {}  # id -> (lat, lon)
        self.places = {}  # name -> [lat, lon, name, place]
        self.bbox = None  # [south, west, north, east] of the region being read

    def inside(self, lat, lon):
        s, w, n, e = self.bbox
        return s <= lat <= n and w <= lon <= e

    def node(self, n):
        place = n.tags.get('place')
        if place in PLACES and n.tags.get('name') and n.location.valid():
            lat, lon = n.location.lat, n.location.lon
            if self.inside(lat, lon):
                self.places[(n.tags['name'], place, round(lat, 2), round(lon, 2))] = [round(lat, 5), round(lon, 5), n.tags['name'], place]

    def way(self, w):
        if w.id in self.ways or not walkable(w.tags):
            return
        pts = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes if n.location.valid()]
        if len(pts) < 2 or not any(self.inside(lat, lon) for _, lat, lon in pts):
            return
        for ref, lat, lon in pts:
            self.nodes[ref] = (round(lat, 6), round(lon, 6))
        self.ways[w.id] = ([ref for ref, _, _ in pts], w.tags.get('name', ''), w.tags['highway'])


def tiles_for_way(coords):
    """Every tile the way touches, including ones a long segment just passes through."""
    out = set()
    for (a_lat, a_lon), (b_lat, b_lon) in zip(coords, coords[1:]):
        steps = max(1, int(max(abs(b_lat - a_lat), abs(b_lon - a_lon)) / (TILE_DEG / 4)))
        for i in range(steps + 1):
            t = i / steps
            out.add(tile_of(a_lat + (b_lat - a_lat) * t, a_lon + (b_lon - a_lon) * t))
    return out


def main(out_dir, regions_path, osm_dir):
    reader = Reader()
    regions = []
    for region in json.load(open(regions_path))['regions']:
        pbf = os.path.join(osm_dir, region['name'] + '.osm.pbf')
        if not os.path.exists(pbf):
            print(f'skipping {region["name"]}: no {pbf}')
            continue
        reader.bbox = region['bbox']
        before = len(reader.ways)
        reader.apply_file(pbf, locations=True, idx='flex_mem')
        if len(reader.ways) > before:
            regions.append({'name': region['name'], 'bounds': region['bbox']})
    if not reader.ways:
        sys.exit('no street data built')

    tiles = {}
    for way_id, (ids, name, highway) in reader.ways.items():
        coords = [reader.nodes[i] for i in ids]
        for key in tiles_for_way(coords):
            tiles.setdefault(key, []).append((way_id, ids, name, highway))

    os.makedirs(out_dir, exist_ok=True)
    total = 0
    for (x, y), ways in tiles.items():
        node_ids = sorted({i for _, ids, _, _ in ways for i in ids})
        elements = [{'type': 'node', 'id': i, 'lat': reader.nodes[i][0], 'lon': reader.nodes[i][1]} for i in node_ids]
        for way_id, ids, name, highway in ways:
            tags = {'highway': highway}
            if name:
                tags['name'] = name
            elements.append({'type': 'way', 'id': way_id, 'nodes': ids, 'tags': tags})
        text = json.dumps({'elements': elements}, separators=(',', ':'))
        total += len(text)
        with open(os.path.join(out_dir, f'{x}_{y}.json'), 'w') as f:
            f.write(text)

    index = {
        'version': 1,
        'license': 'Street data © OpenStreetMap contributors, ODbL',
        'built': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'regions': regions,
        'tileDeg': TILE_DEG,
        'tiles': sorted(f'{x}_{y}' for x, y in tiles),
        'places': list(reader.places.values()),
    }
    with open(os.path.join(out_dir, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print(f'{len(reader.ways)} streets, {len(tiles)} tiles, {total / 1e6:.1f} MB, '
          f'{len(reader.places)} place names, regions {regions}')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
