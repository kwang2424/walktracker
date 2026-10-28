#!/usr/bin/env python3
"""Build the app's street data from an OpenStreetMap .osm.pbf extract.

The output is a folder of small tiles that the app downloads from its own
site, so adding an area doesn't depend on the busy public Overpass servers.

    python3 scripts/build_streets.py data/streets NewYork.osm.pbf [more.osm.pbf ...]

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
        self.ways = []  # (id, [node ids], name, highway)
        self.nodes = {}  # id -> (lat, lon)
        self.places = []

    def node(self, n):
        place = n.tags.get('place')
        if place in PLACES and n.tags.get('name') and n.location.valid():
            self.places.append([round(n.location.lat, 5), round(n.location.lon, 5), n.tags['name'], place])

    def way(self, w):
        if not walkable(w.tags):
            return
        ids = []
        for n in w.nodes:
            if not n.location.valid():
                continue
            ids.append(n.ref)
            self.nodes[n.ref] = (round(n.location.lat, 6), round(n.location.lon, 6))
        if len(ids) >= 2:
            self.ways.append((w.id, ids, w.tags.get('name', ''), w.tags['highway']))


def tiles_for_way(coords):
    """Every tile the way touches, including ones a long segment just passes through."""
    out = set()
    for (a_lat, a_lon), (b_lat, b_lon) in zip(coords, coords[1:]):
        steps = max(1, int(max(abs(b_lat - a_lat), abs(b_lon - a_lon)) / (TILE_DEG / 4)))
        for i in range(steps + 1):
            t = i / steps
            out.add(tile_of(a_lat + (b_lat - a_lat) * t, a_lon + (b_lon - a_lon) * t))
    return out


def main(out_dir, pbfs):
    reader = Reader()
    regions = []
    for pbf in pbfs:
        before = set(reader.nodes)
        reader.apply_file(pbf, locations=True, idx='flex_mem')
        added = [reader.nodes[i] for i in reader.nodes.keys() - before]
        name = os.path.basename(pbf).split('.')[0]
        regions.append({'name': name, 'bounds': [
            min(c[0] for c in added), min(c[1] for c in added), max(c[0] for c in added), max(c[1] for c in added)]})

    tiles = {}
    for way_id, ids, name, highway in reader.ways:
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
        'places': reader.places,
    }
    with open(os.path.join(out_dir, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print(f'{len(reader.ways)} streets, {len(tiles)} tiles, {total / 1e6:.1f} MB, '
          f'{len(reader.places)} place names, regions {regions}')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
