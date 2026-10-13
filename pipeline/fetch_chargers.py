"""Download official EV charging stations from TDX (交通部 運輸資料流通服務).

    python -m pipeline.fetch_chargers           # all regions -> data/raw/<region>.tdx_chargers.json

Needs a TDX API key: TDX_CLIENT_ID / TDX_CLIENT_SECRET from the environment
(GitHub Actions secrets) or from a local, git-ignored .env.tdx file. Without a
key, or if TDX is unreachable, the previous file is kept and OSM chargers are
still used, so a refresh is never blocked.

Data: 交通部「充電站之基本資料」(data.gov.tw 170220), 政府資料開放授權條款第1版.
Apps using TDX data must show 「資料介接「交通部TDX平臺」」 with the TDX logo.
One request per city per refresh, far below the free member quota.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import config
from .fetch_osm import RAW_DIR, UA

ROOT = Path(__file__).resolve().parent.parent
TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
API = "https://tdx.transportdata.tw/api/basic/v1/EV"
SOURCE = "https://data.gov.tw/dataset/170220"
ATTRIBUTION = "資料介接「交通部TDX平臺」"
LICENSE = "政府資料開放授權條款第1版（相容 CC BY 4.0）"
# TDX connector Type -> (label, OSM-style socket key)
CONNECTOR_TYPES = {
    1: ("CCS1", "type1_combo"), 2: ("CCS2", "type2_combo"), 3: ("CHAdeMO", "chademo"),
    4: ("Tesla TPC", "tesla_tpc"), 5: ("Type 1 (J1772)", "type1"), 6: ("Type 2", "type2"),
    254: ("其他", "other"), 255: ("未知", "unknown"),
}
CURRENT = {1: "AC", 2: "DC"}


def credentials() -> tuple[str, str] | None:
    cid, secret = os.environ.get("TDX_CLIENT_ID"), os.environ.get("TDX_CLIENT_SECRET")
    env = ROOT / ".env.tdx"
    if (not cid or not secret) and env.exists():
        values = {}
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
        cid, secret = values.get("TDX_CLIENT_ID"), values.get("TDX_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def token(cid: str, secret: str) -> str:
    r = requests.post(TOKEN_URL, data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret},
                      headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


PACE_S = 3  # seconds between calls; back-to-back calls for several cities hit TDX's rate limit (429)
_last_call = 0.0


def _get(path: str, tok: str, tries: int = 4) -> dict:
    """GET at a gentle pace, retrying rate limits (429, honouring Retry-After) and brief 5xx outages."""
    global _last_call
    for attempt in range(tries):
        time.sleep(max(0.0, _last_call + PACE_S - time.monotonic()))
        _last_call = time.monotonic()
        r = requests.get(f"{API}/{path}", params={"$format": "JSON"},
                         headers={"Authorization": f"Bearer {tok}", "User-Agent": UA, "Accept-Encoding": "gzip"}, timeout=120)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < tries - 1:
            wait = r.headers.get("Retry-After")
            wait = int(wait) if wait and wait.isdigit() else 30 * (attempt + 1)
            print(f"TDX {path}: HTTP {r.status_code}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        if not r.ok:
            print(f"TDX {path}: HTTP {r.status_code} {r.text[:200]!r}", file=sys.stderr)
        r.raise_for_status()
        return r.json()
    raise AssertionError("unreachable")


def _text(v) -> str | None:
    """TDX names are either plain strings or {"Zh_tw": ..., "En": ...}."""
    if isinstance(v, dict):
        v = v.get("Zh_tw") or v.get("En")
    v = (v or "").strip() if isinstance(v, str) else v
    return v or None


def normalise(station: dict, operators: dict[str, str]) -> dict | None:
    lat, lng = station.get("PositionLat"), station.get("PositionLon")
    if lat is None or lng is None:
        pos = station.get("StationPosition") or {}
        lat, lng = pos.get("PositionLat"), pos.get("PositionLon")
    if not lat or not lng:
        return None
    connectors = []
    for c in station.get("Connectors") or []:
        label, key = CONNECTOR_TYPES.get(c.get("Type"), ("未知", "unknown"))
        connectors.append({"type": key, "label": label, "current": CURRENT.get(c.get("Power")), "count": c.get("Quantity") or 1})
    name = _text(station.get("StationName")) or "充電站"
    sid = station.get("StationID") or f"{name}@{lat:.5f},{lng:.5f}"
    op_id = station.get("OperatorID")
    return {
        "id": sid,
        "name": name,
        "operator_id": op_id,
        "operator": operators.get(op_id) if op_id else None,
        "operation_type": {1: "公辦民營", 2: "公辦公營", 3: "私有民營"}.get(station.get("OperationType")),
        "lat": round(float(lat), 6), "lng": round(float(lng), 6),
        "spaces": station.get("Spaces"),
        "charging_points": station.get("ChargingPoints"),
        "connectors": connectors,
        "service_time": _text(station.get("ServiceTime")),
        "charging_rate": _text(station.get("ChargingRate")),
        "parking_rate": _text(station.get("ParkingRate")),
        "floors": _text(station.get("Floors")),
        "restriction": _text(station.get("UsageRestriction")),
        "description": _text(station.get("Description")),
    }


def fetch_city(city: str, tok: str) -> tuple[list[dict], dict]:
    try:  # operator names are a nicety; never lose the stations over them
        ops = _get(f"Operator/City/{city}", tok)
    except requests.RequestException:
        ops = {}
    operators = {o.get("OperatorID"): _text(o.get("OperatorName")) for o in (ops.get("Operators") or [])}
    data = _get(f"Station/City/{city}", tok)
    stations = [s for s in (normalise(s, operators) for s in (data.get("Stations") or [])) if s]
    return stations, {"update_time": data.get("UpdateTime"), "src_update_time": data.get("SrcUpdateTime"), "count": data.get("Count")}


def _bbox(region_id: str) -> tuple[float, float, float, float] | None:
    meta = ROOT / "data" / "regions" / "index.json"
    if meta.exists():
        for r in json.loads(meta.read_text()):
            if r["id"] == region_id:
                w, s, e, n = r["bbox"]
                pad = config.CHARGER_RADIUS_M / 111_320
                return s - pad, w - pad, n + pad, e + pad
    return None


def main(argv: list[str]) -> None:
    creds = credentials()
    if not creds:
        print("TDX_CLIENT_ID / TDX_CLIENT_SECRET not set (env or .env.tdx); keeping previous charger data", file=sys.stderr)
        return
    started = datetime.now(timezone.utc)
    try:
        tok = token(*creds)
    except requests.RequestException as e:
        print(f"TDX login failed ({e.__class__.__name__}); keeping previous charger data", file=sys.stderr)
        return
    cache: dict[str, tuple[list[dict], dict]] = {}
    for rid in argv or list(config.REGIONS):
        region = config.REGIONS[rid]
        city = region["tdx_city"]
        try:
            if city not in cache:
                cache[city] = fetch_city(city, tok)
        except requests.RequestException as e:
            print(f"{rid}: TDX request failed ({e.__class__.__name__}); keeping previous file", file=sys.stderr)
            continue
        stations, info = cache[city]
        box = _bbox(rid)
        if box:
            s, w, n, e = box
            stations = [x for x in stations if s <= x["lat"] <= n and w <= x["lng"] <= e]
        out = {
            "region": rid, "city": city, "fetched_at": started.isoformat(timespec="seconds"),
            "source": SOURCE, "publisher": "交通部", "title": "充電站之基本資料",
            "license": LICENSE, "attribution": ATTRIBUTION, **info,
            "stations": sorted(stations, key=lambda x: x["id"]),
        }
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        path = RAW_DIR / f"{rid}.tdx_chargers.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
        dc = sum(any(c["current"] == "DC" for c in x["connectors"]) for x in stations)
        ac = sum(any(c["current"] == "AC" for c in x["connectors"]) for x in stations)
        print(f"wrote {path} ({len(stations)} stations in region of {info.get('count')} in {city}; with DC {dc}, with AC {ac})")


if __name__ == "__main__":
    main(sys.argv[1:])
