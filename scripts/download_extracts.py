#!/usr/bin/env python3
"""Download the OpenStreetMap extracts listed in scripts/regions.json.

    python3 scripts/download_extracts.py scripts/regions.json OSM_DIR

For each region, tries its URLs in order and saves the first that works as
OSM_DIR/<name>.osm.pbf. If every URL fails, an existing file there (for
example one restored from the GitHub Actions cache) is kept, so a download
site being down never blocks a deploy. Writes fresh=true|false to
$GITHUB_OUTPUT when run in Actions.
"""
import json
import os
import subprocess
import sys

MIN_BYTES = int(os.environ.get('MIN_EXTRACT_BYTES', 1_000_000))  # anything smaller is an error page


def download(url, dest):
    part = dest + '.part'
    result = subprocess.run([
        'curl', '-sSfL', '--connect-timeout', '30', '--max-time', '1500',
        '--retry', '2', '--retry-delay', '20', '-o', part, url,
    ])
    if result.returncode == 0 and os.path.exists(part) and os.path.getsize(part) >= MIN_BYTES:
        os.replace(part, dest)
        return True
    if os.path.exists(part):
        os.remove(part)
    return False


def main(regions_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    fresh = False
    for region in json.load(open(regions_path))['regions']:
        dest = os.path.join(out_dir, region['name'] + '.osm.pbf')
        for url in region['urls']:
            print(f'{region["name"]}: downloading {url}', flush=True)
            if download(url, dest):
                print(f'{region["name"]}: ok ({os.path.getsize(dest) / 1e6:.0f} MB)')
                fresh = True
                break
            print(f'::warning::{region["name"]}: could not download {url}')
        else:
            if os.path.exists(dest):
                print(f'::warning::{region["name"]}: all downloads failed, using the previous copy')
            else:
                print(f'::warning::{region["name"]}: all downloads failed and there is no previous copy; '
                      'the app will use the public street servers there')
    if 'GITHUB_OUTPUT' in os.environ:
        with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
            f.write(f'fresh={"true" if fresh else "false"}\n')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
