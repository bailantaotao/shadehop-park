"""Extract each region's raw OSM data from a Geofabrik Taiwan extract (.osm.pbf).

    python -m pipeline.extract_pbf                                   # download taiwan-latest, all regions
    python -m pipeline.extract_pbf --pbf ~/Downloads/taiwan-261012.osm.pbf taipei

Writes data/raw/<region>.osm.json.gz in the same shape as fetch_osm (Overpass
`out geom`), so build_data does not care which one produced it. Reading a
local file takes minutes and does not depend on the shared Overpass servers,
which are often overloaded; fetch_osm stays as a fallback.

Three passes over the file: (1) relations, (2) the member ways of boundary
and feature relations (outer rings are often untagged), (3) nodes and ways
inside each region's bbox, with the same tag filters as
fetch_osm.features_query. Tag/id filters run in C, so Python only sees the
objects it keeps; node locations are still cached for every node.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import osmium
import requests
from osmium.filter import KeyFilter

from . import config
from .fetch_osm import RAW_DIR, UA
from .geo import element_geometry

GEOFABRIK_URL = "https://download.geofabrik.de/asia/taiwan-latest.osm.pbf"
DEFAULT_PBF = RAW_DIR / "taiwan-latest.osm.pbf"
FEATURE_KEYS = ("leisure", "bridge", "man_made", "amenity", "building", "covered", "natural", "highway")
SERVICE_AMENITIES = {"parking", "charging_station", "toilets", "drinking_water", "shelter"}


def wanted(kind: str, tags: dict) -> bool:
    """Same selection as fetch_osm.features_query."""
    if tags.get("leisure") in ("playground", "park"):
        return True
    if tags.get("amenity") in SERVICE_AMENITIES:
        return True
    if "covered" in tags and "leisure" in tags:
        return True
    if kind == "node":
        return tags.get("natural") == "tree"
    if "building" in tags:  # ways and relations
        return True
    if kind == "way":
        return (
            ("bridge" in tags and ("highway" in tags or "railway" in tags))
            or tags.get("man_made") == "bridge"
            or ("highway" in tags and "name" in tags)
        )
    return False


def _tags(obj) -> dict:
    return {t.k: t.v for t in obj.tags}


def _way_coords(w) -> list[dict] | None:
    try:
        return [{"lat": round(n.location.lat, 7), "lon": round(n.location.lon, 7)} for n in w.nodes]
    except osmium.InvalidLocationError:
        return None


def _in_bbox(coords: list[dict], bbox) -> bool:
    s, w, n, e = bbox
    return any(s <= c["lat"] <= n and w <= c["lon"] <= e for c in coords)


def _relation(rel_id: int, rel: dict, ways: dict[int, list[dict]]) -> dict:
    members = [
        {"type": "way", "ref": ref, "role": role, "geometry": ways[ref]}
        for kind, ref, role in rel["members"] if kind == "w" and ref in ways
    ]
    return {"type": "relation", "id": rel_id, "tags": rel["tags"], "members": members}


def download(dest: Path = DEFAULT_PBF) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    with requests.get(GEOFABRIK_URL, headers={"User-Agent": UA}, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    tmp.replace(dest)
    return dest


def extract(pbf: Path, region_ids: list[str]) -> None:
    regions = [config.REGIONS[r] for r in region_ids]
    header = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING).header()
    osm_base = header.get("osmosis_replication_timestamp") or None
    started = datetime.now(timezone.utc)
    t0 = time.time()

    # Pass 1: relations - region/district boundaries and feature relations.
    boundaries: dict[int, dict] = {}
    features: dict[int, dict] = {}
    district_levels = {r["osm_district_level"] for r in regions if r.get("osm_district_level")}
    for rel in osmium.FileProcessor(str(pbf), osmium.osm.RELATION).with_filter(KeyFilter("boundary", *FEATURE_KEYS)):
        tags = _tags(rel)
        data = {"tags": tags, "members": [(m.type, m.ref, m.role) for m in rel.members]}
        if tags.get("boundary") == "administrative" and (
            any(all(tags.get(k) == v for k, v in r["osm_boundary_tags"].items()) for r in regions)
            or tags.get("admin_level") in district_levels
        ):
            boundaries[rel.id] = data
        if wanted("relation", tags):
            features[rel.id] = data
    print(f"pass 1: {len(boundaries)} boundaries, {len(features)} feature relations ({time.time() - t0:.0f}s)", file=sys.stderr)

    # Pass 2: geometry of the member ways of all relations kept above.
    need = {ref for rel in (*boundaries.values(), *features.values()) for kind, ref, _ in rel["members"] if kind == "w"}
    ways: dict[int, list[dict]] = {}
    proc = (osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations()
            .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)).with_filter(osmium.filter.IdFilter(need)))
    for w in proc:
        coords = _way_coords(w)
        if coords:
            ways[w.id] = coords
    print(f"pass 2: {len(ways)} member ways ({time.time() - t0:.0f}s)", file=sys.stderr)

    plan = []
    for r in regions:
        matches = [i for i, b in boundaries.items() if all(b["tags"].get(k) == v for k, v in r["osm_boundary_tags"].items())]
        if len(matches) != 1:
            raise SystemExit(f"{r['id']}: expected exactly one boundary relation, got {len(matches)}")
        rel = _relation(matches[0], boundaries[matches[0]], ways)
        geom = element_geometry(rel)
        minx, miny, maxx, maxy = geom.bounds
        lat0 = (miny + maxy) / 2
        dlat = config.BBOX_MARGIN_M / 111_320
        dlng = config.BBOX_MARGIN_M / (111_320 * math.cos(math.radians(lat0)))
        bbox = (miny - dlat, minx - dlng, maxy + dlat, maxx + dlng)
        districts = []
        if r.get("osm_district_level"):
            for i, b in boundaries.items():
                if i == matches[0] or b["tags"].get("admin_level") != r["osm_district_level"]:
                    continue
                d = _relation(i, b, ways)
                g = element_geometry(d)
                if g is not None and geom.contains(g.representative_point()):
                    districts.append(d)
        plan.append({"region": r, "boundary": rel, "districts": sorted(districts, key=lambda d: d["id"]), "bbox": bbox, "elements": []})

    # Pass 3: tagged nodes and ways inside each region's bbox.
    proc = osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations().with_filter(KeyFilter(*FEATURE_KEYS))
    for obj in proc:
        if obj.is_node():
            tags = _tags(obj)
            if not wanted("node", tags):
                continue
            lat, lon = obj.location.lat, obj.location.lon
            for p in plan:
                s, w_, n, e = p["bbox"]
                if s <= lat <= n and w_ <= lon <= e:
                    p["elements"].append({"type": "node", "id": obj.id, "lat": round(lat, 7), "lon": round(lon, 7), "tags": tags})
        else:
            tags = _tags(obj)
            if not wanted("way", tags):
                continue
            coords = ways.get(obj.id) or _way_coords(obj)
            if not coords:
                continue
            for p in plan:
                if _in_bbox(coords, p["bbox"]):
                    p["elements"].append({"type": "way", "id": obj.id, "tags": tags, "geometry": coords})
    for rel_id, f in features.items():
        rel = _relation(rel_id, f, ways)
        if not rel["members"]:
            continue
        for p in plan:
            if any(_in_bbox(m["geometry"], p["bbox"]) for m in rel["members"]):
                p["elements"].append(rel)
    print(f"pass 3: done ({time.time() - t0:.0f}s)", file=sys.stderr)

    for p in plan:
        r = p["region"]
        out = {
            "region": r["id"],
            "fetched_at": started.isoformat(timespec="seconds"),
            "osm_base": osm_base,
            "source": f"{pbf.name} (Geofabrik extract)",
            "license": "ODbL 1.0, © OpenStreetMap contributors",
            "boundary": p["boundary"],
            "districts": p["districts"],
            "bbox": p["bbox"],
            "elements": sorted(p["elements"], key=lambda el: (el["type"], el["id"])),
        }
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        path = RAW_DIR / f"{r['id']}.osm.json.gz"
        with gzip.GzipFile(path, "wb", mtime=0) as fh:
            fh.write(json.dumps(out, ensure_ascii=False, sort_keys=True).encode())
        print(f"wrote {path} ({len(out['elements'])} elements, {len(out['districts'])} districts, osm_base={osm_base})")


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pbf", type=Path, help="local .osm.pbf (default: download Geofabrik taiwan-latest)")
    ap.add_argument("regions", nargs="*", default=list(config.REGIONS))
    args = ap.parse_args(argv)
    pbf = args.pbf.expanduser() if args.pbf else download()
    extract(pbf, args.regions)


if __name__ == "__main__":
    main(sys.argv[1:])
