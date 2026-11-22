"""Download the 7-ELEVEN store list from the chain's own store locator (emap.pcsc.com.tw).

    python -m pipeline.fetch_711           # -> data/raw/711.stores.json

OSM is volunteer-mapped, so some 7-ELEVEN stores are missing or stale there. The chain's locator
lists every store with exact coordinates, opening hours and services (toilet, ATM, ...). It has no
public API: this calls the same two endpoints the web page uses (GetTown, SearchStore), one request
per district with a pause in between, and only for the cities the site covers. The file is written
only when every district succeeded, so a half-finished refresh never replaces a good one.
Visitors never hit 7-ELEVEN: build_data reads this file and bakes the nearest store into each park.
"""

from __future__ import annotations

import json
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests

from .fetch_osm import RAW_DIR, UA

ENDPOINT = "https://emap.pcsc.com.tw/EMapSDK.aspx"
PAGE = "https://emap.pcsc.com.tw/emap.aspx"
# City codes of the locator: Taipei, Keelung, New Taipei, Taoyuan, Hsinchu city / county, Miaoli
# (neighbours of the covered regions, so a park near the border still finds its nearest store).
CITIES = {"01": "台北市", "02": "基隆市", "03": "新北市", "04": "桃園市", "05": "新竹市", "06": "新竹縣", "07": "苗栗縣"}
PAUSE_S = 0.6
OUT = RAW_DIR / "711.stores.json"


def _post(session: requests.Session, data: dict, tries: int = 3) -> ET.Element:
    for attempt in range(tries):
        try:
            r = session.post(ENDPOINT, data=data, timeout=30)
            r.raise_for_status()
            root = ET.fromstring(r.content)
            if root.findtext("MessageID") == "00000":
                return root
            raise RuntimeError(root.findtext("Status") or "unexpected response")
        except (requests.RequestException, ET.ParseError, RuntimeError) as e:
            if attempt == tries - 1:
                raise RuntimeError(f"7-ELEVEN locator failed for {data}: {e}") from e
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def parse_stores(root: ET.Element) -> list[dict]:
    """SearchStore XML -> store dicts. X / Y are degrees * 1e6."""
    out = []
    for g in root.iter("GeoPosition"):
        def t(key: str) -> str:
            return (g.findtext(key) or "").strip()
        if not (t("POIID") and t("X") and t("Y")):
            continue
        services = t("StoreImageTitle")
        out.append({
            "id": t("POIID"),
            "name": t("POIName"),
            "lat": round(float(t("Y")) / 1e6, 6),
            "lng": round(float(t("X")) / 1e6, 6),
            "address": t("Address"),
            "hours": t("OP_TIME") or None,
            "toilet": "廁所" in services,
        })
    return out


def fetch_all(cities: dict[str, str] = CITIES, pause: float = PAUSE_S) -> list[dict]:
    session = requests.Session()
    session.headers["User-Agent"] = UA
    stores: dict[str, dict] = {}
    for code, city in cities.items():
        towns = _post(session, {"commandid": "GetTown", "cityid": code})
        names = [g.findtext("TownName") for g in towns.iter("GeoPosition") if g.findtext("TownName")]
        before = len(stores)
        for town in names:
            time.sleep(pause)
            root = _post(session, {"commandid": "SearchStore", "city": city, "town": town, "roadname": "", "ID": "",
                                   "StoreName": "", "SpecialStore_Kind": "", "leftMenuChecked": "", "address": ""})
            for s in parse_stores(root):
                stores[s["id"]] = s
        print(f"{city}: {len(names)} districts, {len(stores) - before} stores", file=sys.stderr)
    return sorted(stores.values(), key=lambda s: s["id"])


def main() -> None:
    stores = fetch_all()
    if len(stores) < 500:  # Taipei alone has ~1,000: a short list means the page changed or blocked us
        sys.exit(f"only {len(stores)} stores; keeping the previous {OUT.name}")
    doc = {"source": PAGE, "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "stores": stores}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {len(stores)} stores to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
