"""EV charger classification from OSM `socket:*` tags.

DC sockets (CCS1/CCS2/CHAdeMO/Tesla Supercharger/GB-T DC) => fast (快充).
AC sockets (Type 1/Type 2/Tesla destination) => slow (慢充).
A station can be both. Nothing usable tagged => unknown, never guessed.
"""

from __future__ import annotations

import re

DC_SOCKETS = {
    "type1_combo": "CCS1",
    "type2_combo": "CCS2",
    "chademo": "CHAdeMO",
    "tesla_supercharger": "Tesla Supercharger",
    "tesla_supercharger_ccs": "Tesla Supercharger (CCS)",
    "gb_dc": "GB/T DC",
    "nacs": "NACS",
}
AC_SOCKETS = {
    "type1": "Type 1 (J1772)",
    "type2": "Type 2",
    "type2_cable": "Type 2 (有線)",
    "tesla_destination": "Tesla Destination",
    "gb_ac": "GB/T AC",
}
# NACS is used for both AC and DC; treat as DC only when power says so.
_AMBIGUOUS = {"nacs"}
FAST_POWER_KW = 20.0


def _kw(value: str | None) -> float | None:
    if not value:
        return None
    m = re.search(r"([\d.]+)\s*(kw|w)?", value.lower())
    if not m:
        return None
    n = float(m.group(1))
    return n / 1000 if m.group(2) == "w" else n


def _count(value: str) -> int:
    if value in ("yes", ""):
        return 1
    try:
        return max(int(value), 0)
    except ValueError:
        return 1


def classify(tags: dict[str, str]) -> dict:
    sockets = []
    for key, value in tags.items():
        if not key.startswith("socket:") or key.count(":") != 1 or value == "no":
            continue
        kind = key.split(":", 1)[1]
        power = _kw(tags.get(f"{key}:output"))
        if kind in _AMBIGUOUS:
            current = "DC" if power and power >= FAST_POWER_KW else "AC" if power else None
            label = DC_SOCKETS[kind]
        elif kind in DC_SOCKETS:
            current, label = "DC", DC_SOCKETS[kind]
        elif kind in AC_SOCKETS:
            current, label = "AC", AC_SOCKETS[kind]
        else:
            continue
        sockets.append({"type": kind, "label": label, "current": current, "count": _count(value), "output_kw": power})

    station_kw = _kw(tags.get("charging_station:output") or tags.get("output"))
    has_dc = any(s["current"] == "DC" for s in sockets)
    has_ac = any(s["current"] == "AC" for s in sockets)
    if not sockets and station_kw is not None:
        has_dc = station_kw >= FAST_POWER_KW
        has_ac = not has_dc

    if has_dc and has_ac:
        speed = "both"
    elif has_dc:
        speed = "fast"
    elif has_ac:
        speed = "slow"
    else:
        speed = "unknown"
    powers = [s["output_kw"] for s in sockets if s["output_kw"]] + ([station_kw] if station_kw else [])
    return {
        "speed": speed,
        "speed_label": {"fast": "快充 (DC)", "slow": "慢充 (AC)", "both": "快充 + 慢充", "unknown": "未標示"}[speed],
        "sockets": sockets,
        "max_kw": max(powers) if powers else None,
    }
