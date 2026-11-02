#!/usr/bin/env python3
"""Pull the walkable streets out of OpenStreetMap extracts.

    python3 scripts/extract_streets.py OUT.json scripts/regions.json OSM_DIR

OSM_DIR holds <region name>.osm.pbf for each region in regions.json (see
download_extracts.py). Only streets touching a region's bounding box are
kept. The output is one JSON file read by build_city.mjs:

    {"nodes": [[id, lat, lon], ...], "ways": [[id, [node ids], name, highway], ...]}
"""
import json
import os
import sys

import osmium

# Keep in sync with WALKABLE_HIGHWAYS in js/geo.js (a test checks this).
# Footpaths and park paths are left out on purpose: blocks are streets.
WALKABLE = {
    'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary',
    'tertiary_link', 'residential', 'unclassified', 'living_street', 'pedestrian',
    'trunk',
}


def sidewalks(tags):
    """'separate' if sidewalks are drawn as their own lines, 'no' if the street
    has none, else None (not tagged, or sidewalks are part of the street)."""
    values = [v for k, v in tags.items() if k == 'sidewalk' or k.startswith('sidewalk:') and k.count(':') == 1]
    if any('separate' in v for v in values):
        return 'separate'
    sides = {tags.get('sidewalk:left'), tags.get('sidewalk:right')}
    if tags.get('sidewalk') in ('no', 'none') or tags.get('sidewalk:both') == 'no' or sides == {'no'}:
        return 'no'
    return None


def walkable(tags):
    highway = tags.get('highway')
    if tags.get('area') == 'yes':
        return False
    # Named alleys (Cortlandt Alley, Staple Street...) are streets too; other
    # service roads (driveways, parking lots) are not.
    if highway == 'service':
        return tags.get('service') == 'alley' and bool(tags.get('name')) and tags.get('access') not in ('private', 'no')
    if highway not in WALKABLE:
        return False
    foot = tags.get('foot')
    # An explicit foot tag wins over access: Fulton Mall is access=no, bus=yes,
    # foot=yes (closed to cars, open to people walking).
    if foot in ('yes', 'designated', 'permissive'):
        return True
    if foot == 'private' or (tags.get('access') in ('private', 'no') and foot != 'use_sidepath'):
        return False
    # foot=no often just means "walk on the sidewalk": the street still counts
    # when its sidewalks are drawn separately (Eastern Parkway, Grand Concourse).
    # Without that it's a roadway people can't walk along (bridge decks,
    # expressway-like main lanes, airport roads).
    if foot == 'no':
        return sidewalks(tags) == 'separate'
    # Trunk roads in NYC are mostly big avenues with sidewalks (Linden Blvd,
    # Conduit Ave, West St); skip the ones that are roads for cars only.
    if highway == 'trunk':
        return tags.get('motorroad') != 'yes' and sidewalks(tags) != 'no'
    return True


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = {}  # id -> ([node ids], name, highway)
        self.nodes = {}  # id -> (lat, lon)
        self.bbox = None  # [south, west, north, east] of the region being read

    def inside(self, lat, lon):
        s, w, n, e = self.bbox
        return s <= lat <= n and w <= lon <= e

    def way(self, w):
        if w.id in self.ways or 'highway' not in w.tags or not walkable(dict(w.tags)):
            return
        pts = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes if n.location.valid()]
        if len(pts) < 2 or not any(self.inside(lat, lon) for _, lat, lon in pts):
            return
        for ref, lat, lon in pts:
            self.nodes[ref] = (round(lat, 6), round(lon, 6))
        self.ways[w.id] = ([ref for ref, _, _ in pts], w.tags.get('name', ''), w.tags['highway'])


def main(out_path, regions_path, osm_dir):
    reader = Reader()
    for region in json.load(open(regions_path))['regions']:
        pbf = os.path.join(osm_dir, region['name'] + '.osm.pbf')
        if not os.path.exists(pbf):
            print(f'skipping {region["name"]}: no {pbf}')
            continue
        reader.bbox = region['bbox']
        reader.apply_file(pbf, locations=True, idx='flex_mem')
    if not reader.ways:
        sys.exit('no streets found')
    out = {
        'nodes': [[i, lat, lon] for i, (lat, lon) in reader.nodes.items()],
        'ways': [[i, ids, name, hw] for i, (ids, name, hw) in reader.ways.items()],
    }
    with open(out_path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'{len(reader.ways)} streets, {len(reader.nodes)} points')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
