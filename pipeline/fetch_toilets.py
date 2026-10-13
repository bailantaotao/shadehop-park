"""Download public toilets from 環境部「全國公廁建檔資料」(data.gov.tw 30794).

    python -m pipeline.fetch_toilets           # all regions -> data/raw/<region>.toilets.json

Needs a free 環境部 open-data API key: MOENV_API_KEY from the environment (GitHub Actions
secret) or a local, git-ignored .env.moenv file. Without a key, or if the API is unreachable,
the previous file is kept and OSM toilets are still used, so a refresh is never blocked.

The registry has one row per toilet room (男廁/女廁/親子廁所/無障礙...) with a diaper-table
count; rows at the same spot are grouped into one site. Places include parks, stations, malls,
gas stations and restaurants - all usable by families, so none are dropped.
Data: 環境部環境管理署, 政府資料開放授權條款第1版.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import config
from .fetch_osm import RAW_DIR, UA

ROOT = Path(__file__).resolve().parent.parent
API = "https://data.moenv.gov.tw/api/v2/fac_p_07"
SOURCE = "https://data.gov.tw/dataset/30794"
LICENSE = "政府資料開放授權條款第1版（相容 CC BY 4.0）"
PAGE = 1000


def api_key() -> str | None:
    key = os.environ.get("MOENV_API_KEY")
    env = ROOT / ".env.moenv"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("MOENV_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    return key or None


def fetch_county(code: str, key: str) -> list[dict]:
    rows, offset = [], 0
    while True:
        r = requests.get(API, params={"api_key": key, "limit": PAGE, "offset": offset, "format": "JSON",
                                      "filters": f"county,EQ,{code}"}, headers={"User-Agent": UA}, timeout=120)
        r.raise_for_status()
        data = r.json()
        page = data.get("records", data) if isinstance(data, dict) else data
        if not isinstance(page, list):
            raise ValueError(f"unexpected response: {str(data)[:200]}")
        rows += page
        if len(page) < PAGE:
            return rows
        offset += PAGE


def place_name(name: str) -> str:
    """'中油鶯歌加油站-男廁' -> '中油鶯歌加油站', '捷運景美站親子' -> '捷運景美站' (the room is in `types`)."""
    # Taipei often drops 廁: 捷運景美站男 / 捷運景美站親子.
    short = re.sub(r"[-－_ ]*(男|女|親子無障礙|親子|無障礙|性別友善|混合)*(廁所?|洗手間|化妝室)?\d*$", "", name).strip(" -－")
    return short or name


def group_sites(rows: list[dict]) -> list[dict]:
    sites: dict[tuple, dict] = {}
    for r in rows:
        try:
            lat, lng = float(r["latitude"]), float(r["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (21 < lat < 26.5 and 119 < lng < 122.5):
            continue
        name = place_name(r.get("name") or "")
        # Rooms of one place share the address; coordinates differ by a few metres.
        k = (r.get("address") or name, round(lat, 3), round(lng, 3))
        s = sites.setdefault(k, {"name": name, "lat": round(lat, 6), "lng": round(lng, 6), "address": r.get("address"),
                                 "category": r.get("type2"), "types": [], "diaper": 0, "grade": r.get("grade")})
        if len(name) < len(s["name"]):
            s["name"] = name  # the shortest room name is the place
        if r.get("type") and r["type"] not in s["types"]:
            s["types"].append(r["type"])
        try:
            s["diaper"] += int(r.get("diaper") or 0)
        except ValueError:
            pass
    return sorted(sites.values(), key=lambda s: (s["lat"], s["lng"], s["name"]))


def main(argv: list[str]) -> None:
    key = api_key()
    if not key:
        print("MOENV_API_KEY not set (env or .env.moenv); keeping previous toilet data", file=sys.stderr)
        return
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for rid in argv or list(config.REGIONS):
        code = config.REGIONS[rid].get("moenv_county")
        if not code:
            continue
        try:
            rows = fetch_county(code, key)
        except (requests.RequestException, ValueError) as e:
            print(f"{rid}: 環境部 toilets request failed ({e.__class__.__name__}); keeping previous file", file=sys.stderr)
            continue
        sites = group_sites(rows)
        out = {"region": rid, "county": code, "fetched_at": started, "source": SOURCE, "publisher": "環境部環境管理署",
               "title": "全國公廁建檔資料", "license": LICENSE, "rows": len(rows), "sites": sites}
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        path = RAW_DIR / f"{rid}.toilets.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
        family = sum("親子廁所" in s["types"] for s in sites)
        diaper = sum(s["diaper"] > 0 for s in sites)
        print(f"wrote {path} ({len(rows)} rooms -> {len(sites)} sites; 親子廁所 {family}, 尿布台 {diaper})")


if __name__ == "__main__":
    main(sys.argv[1:])
