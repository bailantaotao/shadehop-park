"""Download the city's official park registry (New Taipei open data).

    python -m pipeline.fetch_city           # writes data/raw/<region>.city_parks.json

The registry has names, addresses and the managing office but no coordinates,
so it is only used to cross-check and enrich OSM parks by name. If the portal
is unreachable the previous file is kept, so an OSM refresh is never blocked.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

import requests

from . import config
from .fetch_osm import RAW_DIR, UA

DATASET_ID = "5FE3A136-29CC-4695-A17E-6636A32C3342"
DATASET_URL = f"https://data.ntpc.gov.tw/datasets/{DATASET_ID}"
API = f"https://data.ntpc.gov.tw/api/datasets/{DATASET_ID}/json"
LICENSE = "政府資料開放授權條款第1版（相容 CC BY 4.0）"
PAGE_SIZE = 1000


def fetch() -> list[dict]:
    rows, page = [], 0
    while True:
        r = requests.get(API, params={"page": page, "size": PAGE_SIZE}, headers={"User-Agent": UA}, timeout=60)
        r.raise_for_status()
        batch = r.json()
        rows += batch
        if len(batch) < PAGE_SIZE:
            return rows
        page += 1


def main() -> None:
    path = RAW_DIR / f"{config.REGION['id']}.city_parks.json"
    started = datetime.now(timezone.utc)
    try:
        rows = fetch()
    except (requests.RequestException, ValueError) as e:
        print(f"city park registry not refreshed ({e}); keeping {path}", file=sys.stderr)
        return
    rows = [r for r in rows if r.get("area") == config.REGION["name"]]
    if not rows:
        print(f"city park registry returned no rows for {config.REGION['name']}; keeping {path}", file=sys.stderr)
        return
    out = {
        "fetched_at": started.isoformat(timespec="seconds"),
        "source": DATASET_URL,
        "publisher": "新北市政府農業局",
        "license": LICENSE,
        "parks": sorted(rows, key=lambda r: int(r.get("seqno") or 0)),
    }
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    print(f"wrote {path} ({len(rows)} parks)")


if __name__ == "__main__":
    main()
