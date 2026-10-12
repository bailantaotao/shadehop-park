"""ShadeHop MCP server: lets AI agents query shaded/rain-proof playgrounds, parking and EV chargers.

    pip install -r requirements-mcp.txt
    python -m mcp_server.server                       # stdio, reads data/parks.json
    SHADEHOP_DATA_URL=https://.../api/parks.json python -m mcp_server.server
    python -m mcp_server.server --http --port 8000    # streamable HTTP

Optional real-time parking (TDX): set TDX_CLIENT_ID / TDX_CLIENT_SECRET.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = (os.environ.get("SITE_URL") or "https://bailantaotao.github.io/shadehop-park").rstrip("/")
TPE = timezone(timedelta(hours=8))
SLOT_START, SLOT_MIN = 6 * 60, 30
DISCLAIMER = "遮陰為依 OpenStreetMap 建物/高架資料與太陽位置的模型推估；距離為直線距離。請附上 as_of 與 url 引用。"


@lru_cache(maxsize=1)
def load() -> dict:
    url = os.environ.get("SHADEHOP_DATA_URL")
    if url:
        import requests

        return requests.get(url, timeout=30).json()
    return json.loads((ROOT / "data" / "parks.json").read_text())


def _parks() -> list[dict]:
    return load()["parks"]


def _as_of() -> str | None:
    return load()["meta"].get("generated_from_osm_base")


def _dist_km(lat1, lng1, lat2, lng2) -> float:
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lng2 - lng1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def _slot(when: datetime) -> tuple[int, int | None]:
    local = when.astimezone(TPE)
    idx = (local.hour * 60 + local.minute - SLOT_START) // SLOT_MIN
    return local.month, idx if 0 <= idx < 24 else None


def _parse_when(when: str | None) -> datetime:
    if not when:
        return datetime.now(TPE)
    dt = datetime.fromisoformat(when)
    return dt if dt.tzinfo else dt.replace(tzinfo=TPE)


def _brief(p: dict, month: int, slot: int | None, origin: tuple[float, float] | None) -> dict:
    shade = p["shade_timetable"]["slots"][str(month)][slot] if slot is not None else None
    out = {
        "id": p["id"],
        "name": p["name"],
        "url": f"{SITE_URL}/parks/{p['id']}/",
        "location": p["location"],
        "level": p["level"],
        "level_label": p["level_label"],
        "rain_cover": p["rain_cover"]["value"],
        "rain_cover_confidence": p["rain_cover"]["confidence"],
        "shade_at_requested_time": shade,
        "best_shade_window_this_month": p["best_shade_windows"][str(month)],
        "nearest_parking": ({k: p["parking"][0][k] for k in ("name", "distance_m", "capacity", "fee")} if p["parking"] else None),
        "chargers": {k: p["charger_summary"][k] for k in ("fast", "slow", "nearest_fast_m", "nearest_slow_m")},
        "toilet_within_200m": p["amenities"]["toilet"]["value"],
    }
    if origin:
        out["distance_km"] = round(_dist_km(origin[0], origin[1], p["location"]["lat"], p["location"]["lng"]), 2)
    return out


# ------------------------------------------------------------------- tools
def search_parks(
    lat: float | None = None,
    lng: float | None = None,
    radius_km: float = 5.0,
    when: str | None = None,
    need_rain_cover: bool = False,
    min_shade: float | None = None,
    need_fast_charger: bool = False,
    need_slow_charger: bool = False,
    max_parking_m: int | None = None,
    need_toilet: bool = False,
    limit: int = 10,
) -> dict:
    """Search playgrounds in 新北市林口區 by shade, rain cover, parking and EV charging.

    Args:
        lat, lng: Search origin (WGS84). Omit to search the whole district.
        radius_km: Max straight-line distance from origin.
        when: ISO datetime (Asia/Taipei if no offset). Default: now. Used for shade_at_requested_time.
        need_rain_cover: Only playgrounds under a viaduct/roof (rain-proof, level A).
        min_shade: 0-1. Only playgrounds whose computed shade at `when` is at least this (rain-proof ones always pass).
        need_fast_charger / need_slow_charger: Require a DC fast / AC slow EV charger within 2 km.
        max_parking_m: Require a parking lot within this straight-line distance.
        need_toilet: Require a public toilet within 200 m (per OSM).
        limit: Max results.
    """
    dt = _parse_when(when)
    month, slot = _slot(dt)
    origin = (lat, lng) if lat is not None and lng is not None else None
    results = []
    for p in _parks():
        if origin and _dist_km(lat, lng, p["location"]["lat"], p["location"]["lng"]) > radius_km:
            continue
        if need_rain_cover and p["rain_cover"]["value"] is not True:
            continue
        if min_shade is not None and p["rain_cover"]["value"] is not True:
            v = p["shade_timetable"]["slots"][str(month)][slot] if slot is not None else None
            if v is None or v < min_shade:
                continue
        cs = p["charger_summary"]
        if need_fast_charger and cs["nearest_fast_m"] is None:
            continue
        if need_slow_charger and cs["nearest_slow_m"] is None:
            continue
        if max_parking_m is not None and not (p["parking"] and p["parking"][0]["distance_m"] <= max_parking_m):
            continue
        if need_toilet and not p["amenities"]["toilet"]["value"]:
            continue
        results.append(_brief(p, month, slot, origin))

    def key(r):
        if origin:
            return (r["distance_km"],)
        return (r["rain_cover"] is not True, -(r["shade_at_requested_time"] or 0))

    results.sort(key=key)
    return {
        "as_of": _as_of(),
        "requested_time": dt.isoformat(timespec="minutes"),
        "slot_note": None if slot is not None else "requested time is outside 06:00-18:00; shade not computed",
        "count": len(results),
        "results": results[:limit],
        "disclaimer": DISCLAIMER,
    }


def _get(park_id: str) -> dict | None:
    return next((p for p in _parks() if p["id"] == park_id), None)


def get_park(park_id: str) -> dict:
    """Full record for one playground, including provenance (method, verified_at, confidence, source) for every fact."""
    p = _get(park_id)
    if not p:
        return {"error": "not_found", "park_id": park_id}
    return {"as_of": _as_of(), "url": f"{SITE_URL}/parks/{park_id}/", "park": p, "disclaimer": DISCLAIMER}


def get_shade_timeline(park_id: str, month: int | None = None) -> dict:
    """Half-hourly computed shade (0-1) from 06:00 to 18:00 for a month (default: current), plus the best window."""
    p = _get(park_id)
    if not p:
        return {"error": "not_found", "park_id": park_id}
    month = month or datetime.now(TPE).month
    row = p["shade_timetable"]["slots"][str(month)]
    slots = [{"start": f"{(SLOT_START + i * SLOT_MIN) // 60:02d}:{(SLOT_START + i * SLOT_MIN) % 60:02d}", "shade": v} for i, v in enumerate(row)]
    tt = p["shade_timetable"]
    return {
        "as_of": _as_of(), "park_id": park_id, "name": p["name"], "month": month,
        "rain_cover": p["rain_cover"]["value"],
        "best_window": p["best_shade_windows"][str(month)],
        "slots": slots,
        "confidence": tt["confidence"], "method": tt["method"], "note": tt["note"],
        "url": f"{SITE_URL}/parks/{park_id}/",
    }


def get_nearby_chargers(park_id: str, speed: str | None = None) -> dict:
    """EV chargers near a playground. speed: 'fast' (DC), 'slow' (AC) or omit for all."""
    p = _get(park_id)
    if not p:
        return {"error": "not_found", "park_id": park_id}
    cs = p["chargers"]
    if speed == "fast":
        cs = [c for c in cs if c["speed"] in ("fast", "both")]
    elif speed == "slow":
        cs = [c for c in cs if c["speed"] in ("slow", "both")]
    return {"as_of": _as_of(), "park_id": park_id, "summary": p["charger_summary"], "chargers": cs,
            "note": "快慢充依 OSM socket:* 標記判定；unknown 表示未標示，不代表沒有。距離為直線距離。"}


def get_nearby_parking(park_id: str, realtime: bool = True) -> dict:
    """Parking lots near a playground; when TDX credentials are configured, adds real-time available spaces."""
    p = _get(park_id)
    if not p:
        return {"error": "not_found", "park_id": park_id}
    out = {"as_of": _as_of(), "park_id": park_id, "parking": p["parking"], "realtime": None}
    if realtime:
        out["realtime"] = tdx_nearby(p["location"]["lat"], p["location"]["lng"])
    return out


# --------------------------------------------------------------- TDX (optional)
_token: dict = {}


def _tdx_token() -> str | None:
    cid, secret = os.environ.get("TDX_CLIENT_ID"), os.environ.get("TDX_CLIENT_SECRET")
    if not cid or not secret:
        return None
    if _token.get("exp", 0) > time.time() + 60:
        return _token["value"]
    import requests

    r = requests.post(
        "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
        data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret}, timeout=20,
    )
    r.raise_for_status()
    j = r.json()
    _token.update(value=j["access_token"], exp=time.time() + j.get("expires_in", 3600))
    return _token["value"]


def tdx_nearby(lat: float, lng: float, radius_m: int = 800) -> dict:
    """Real-time off-street parking availability from TDX (New Taipei). Never raises."""
    try:
        token = _tdx_token()
        if not token:
            return {"available": False, "reason": "TDX_CLIENT_ID/TDX_CLIENT_SECRET not configured"}
        import requests

        base = "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet"
        h = {"Authorization": f"Bearer {token}"}
        q = {"$spatialFilter": f"nearby({lat},{lng},{radius_m})", "$format": "JSON"}
        lots = requests.get(f"{base}/CarPark/City/NewTaipei", params=q, headers=h, timeout=20).json()
        lots = lots.get("CarParks", lots) if isinstance(lots, dict) else lots
        ids = {l["CarParkID"]: l for l in lots}
        avail = requests.get(f"{base}/ParkingAvailability/City/NewTaipei", params={"$format": "JSON"}, headers=h, timeout=30).json()
        update_time = avail.get("UpdateTime") if isinstance(avail, dict) else None
        rows = avail.get("ParkingAvailabilities", []) if isinstance(avail, dict) else avail
        out = []
        for a in rows:
            lot = ids.get(a.get("CarParkID"))
            if not lot:
                continue
            out.append({
                "name": (lot.get("CarParkName") or {}).get("Zh_tw"),
                "available_spaces": a.get("AvailableSpaces"),
                "total_spaces": a.get("TotalSpaces"),
                "data_collect_time": a.get("DataCollectTime"),
            })
        return {"available": True, "source": "TDX 運輸資料流通服務", "update_time": update_time, "lots": out}
    except Exception as e:  # noqa: BLE001 - real-time data is best-effort
        return {"available": False, "reason": f"TDX request failed: {e.__class__.__name__}"}


TOOLS = [search_parks, get_park, get_shade_timeline, get_nearby_chargers, get_nearby_parking]


def build_server():
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        name="shadehop-park",
        title="ShadeHop 林口遮陽公園",
        instructions=(
            "Find shaded or rain-proof children's playgrounds in 新北市林口區 (Linkou, New Taipei), with nearby parking "
            "and EV chargers (fast DC / slow AC). Always cite `as_of` and the park `url`. Shade values are model "
            "estimates; say so. If a field is null/unknown, say it is not recorded rather than guessing."
        ),
        website_url=SITE_URL,
    )
    for fn in TOOLS:
        server.tool()(fn)
    return server


def main(argv: list[str]) -> None:
    server = build_server()
    if "--http" in argv:
        port = int(argv[argv.index("--port") + 1]) if "--port" in argv else 8000
        server.run("streamable-http", port=port)
    else:
        server.run("stdio")


if __name__ == "__main__":
    main(sys.argv[1:])
