"""Reuse shade timetables between data refreshes.

The timetable (12 months x 24 slots of shadow geometry per park) is ~90% of build time, and most
parks and the buildings around them do not change from week to week. Each timetable is keyed by a
fingerprint of everything it depends on: the play-area shape and position, every nearby caster
(shape, heights, kind), and the shade/sun code plus the config values that code reads. Any change
to those gives a new key, so a cached table is only reused when it would be computed identically.

The cache lives in .cache/shade/<region>.json.gz (git-ignored; CI keeps it with actions/cache) and
holds only the keys used by the latest build, so it does not grow.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
from pathlib import Path

from . import config

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache" / "shade"
_SOURCES = ("shade.py", "sun.py")


def _code_version() -> str:
    h = hashlib.sha256()
    here = Path(__file__).resolve().parent
    for name in _SOURCES:
        src = (here / name).read_text()
        h.update(src.encode())
        for k in sorted(set(re.findall(r"config\.([A-Z0-9_]+)", src))):
            h.update(f"{k}={getattr(config, k)!r}".encode())
    return h.hexdigest()


VERSION = _code_version()


def key(zone, casters, lat: float, lng: float) -> str:
    h = hashlib.sha256(VERSION.encode())
    h.update(zone.wkb)
    h.update(f"{lat!r},{lng!r}".encode())
    for c in casters:
        h.update(c.geom.wkb)
        h.update(f"|{c.z0!r}|{c.z1!r}|{c.kind}|{c.height_known}".encode())
    return h.hexdigest()[:32]


def load(region_id: str, cache_dir: Path = CACHE_DIR) -> dict:
    path = cache_dir / f"{region_id}.json.gz"
    try:
        with gzip.open(path, "rt") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}  # no cache yet, or unreadable: just recompute


def save(region_id: str, tables: dict, cache_dir: Path = CACHE_DIR) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    with gzip.open(cache_dir / f"{region_id}.json.gz", "wt") as fh:
        json.dump(tables, fh, separators=(",", ":"), sort_keys=True)
