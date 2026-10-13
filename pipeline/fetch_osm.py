"""Download raw OpenStreetMap data for each region via the Overpass API.

    python -m pipeline.fetch_osm            # all regions -> data/raw/<region>.osm.json.gz
    python -m pipeline.fetch_osm taipei     # one region

Large regions are fetched in tiles (config `fetch_tiles`) so no single
Overpass request is big enough to time out.
"""

from __future__ import annotations

import gzip
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import config

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
UA = "shadehop-park/0.1 (https://github.com/bailantaotao/shadehop-park)"


def overpass(query: str) -> dict:
    last = None
    for attempt in range(4):
        for url in ENDPOINTS:
            try:
                r = requests.post(url, data={"data": query}, headers={"User-Agent": UA}, timeout=300)
                if r.status_code == 200:
                    return r.json()
                last = f"{url}: HTTP {r.status_code} {r.text[:200]}"
            except requests.RequestException as e:
                last = f"{url}: {e}"
            print("overpass failed:", last, file=sys.stderr)
        time.sleep(2 ** (attempt + 2))
    raise RuntimeError(f"all Overpass endpoints failed: {last}")


def boundary_query(region: dict) -> str:
    return f"""[out:json][timeout:120];
{region['osm_boundary']};
out geom;"""


def districts_query(region: dict) -> str:
    return f"""[out:json][timeout:120];
{region['osm_boundary']}->.b;
.b map_to_area->.r;
{region['osm_districts']};
out geom;"""


def tiles(bbox: tuple[float, float, float, float], n: int):
    s, w, north, e = bbox
    dlat, dlng = (north - s) / n, (e - w) / n
    for i in range(n):
        for j in range(n):
            yield s + i * dlat, w + j * dlng, s + (i + 1) * dlat, w + (j + 1) * dlng


def features_query(s: float, w: float, n: float, e: float) -> str:
    bb = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    return f"""[out:json][timeout:300][maxsize:536870912];
(
  nwr["leisure"="playground"]{bb};
  nwr["leisure"="park"]{bb};
  way["bridge"]["highway"]{bb};
  way["bridge"]["railway"]{bb};
  way["man_made"="bridge"]{bb};
  nwr["amenity"="shelter"]{bb};
  way["building"="roof"]{bb};
  nwr["covered"]["leisure"]{bb};
  way["building"]{bb};
  relation["building"]{bb};
  nwr["amenity"="parking"]{bb};
  nwr["amenity"="charging_station"]{bb};
  nwr["amenity"="toilets"]{bb};
  nwr["amenity"="drinking_water"]{bb};
  node["natural"="tree"]{bb};
  way["highway"]["name"]{bb};
);
out geom qt;"""


def fetch_region(region: dict) -> None:
    started = datetime.now(timezone.utc)
    b = overpass(boundary_query(region))
    rels = [el for el in b["elements"] if el["type"] == "relation"]
    if len(rels) != 1:
        raise SystemExit(f"{region['id']}: expected exactly one boundary relation, got {len(rels)}")
    rel = rels[0]
    districts = []
    if region.get("osm_districts"):
        districts = [el for el in overpass(districts_query(region))["elements"] if el["type"] == "relation"]
    bounds = rel["bounds"]
    lat0 = (bounds["minlat"] + bounds["maxlat"]) / 2
    dlat = config.BBOX_MARGIN_M / 111_320
    dlng = config.BBOX_MARGIN_M / (111_320 * math.cos(math.radians(lat0)))
    bbox = (bounds["minlat"] - dlat, bounds["minlon"] - dlng, bounds["maxlat"] + dlat, bounds["maxlon"] + dlng)
    elements, seen, osm_base = [], set(), None
    n = region.get("fetch_tiles", 1)
    for k, tile in enumerate(tiles(bbox, n), 1):
        f = overpass(features_query(*tile))
        osm_base = max(filter(None, [osm_base, f.get("osm3s", {}).get("timestamp_osm_base")]), default=None)
        for el in f["elements"]:
            key = (el["type"], el["id"])
            if key not in seen:
                seen.add(key)
                elements.append(el)
        print(f"{region['id']}: tile {k}/{n * n}, {len(elements)} elements so far", file=sys.stderr)
    out = {
        "region": region["id"],
        "fetched_at": started.isoformat(timespec="seconds"),
        "osm_base": osm_base,
        "license": "ODbL 1.0, © OpenStreetMap contributors",
        "boundary": rel,
        "districts": districts,
        "bbox": bbox,
        "elements": sorted(elements, key=lambda el: (el["type"], el["id"])),
    }
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / f"{region['id']}.osm.json.gz"
    # mtime=0 keeps the gzip byte-identical when the data has not changed.
    with gzip.GzipFile(path, "wb", mtime=0) as fh:
        fh.write(json.dumps(out, ensure_ascii=False, sort_keys=True).encode())
    print(f"wrote {path} ({len(out['elements'])} elements, osm_base={out['osm_base']})")


def main(argv: list[str]) -> None:
    for rid in argv or list(config.REGIONS):
        fetch_region(config.REGIONS[rid])


if __name__ == "__main__":
    main(sys.argv[1:])
