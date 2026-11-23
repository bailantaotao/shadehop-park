"""Links added when the site is built (not by the data pipeline), so changing them needs only a
redeploy, not a full shade recomputation."""

from __future__ import annotations

import re
from urllib.parse import quote


def _place_query(p: dict) -> str:
    """What to look up on Google Maps: a real name plus city/district, so Google matches its own
    place (reviews, entrance, parking). For places we named after the nearest street, the
    coordinates instead, so the search does not land on some other "公園"."""
    official = (p.get("official") or {}).get("name")
    name = official or (p["name"] if p["name_source"] in ("osm_name", "official") else p.get("park_name"))
    name = re.sub(r"[（(][^）)]*[）)]", "", name or "").strip()  # registry codes like 中興公園(公十二)
    if name:
        district = p["region"]["district"] if p["region"]["district"] != p["region"]["city"] else ""
        return f"{name} {p['region']['city']}{district}"
    return f"{p['location']['lat']},{p['location']['lng']}"


def google_maps_url(p: dict) -> str:
    """A free Google Maps link (Maps URLs, no API key) where people can read the place's reviews."""
    return "https://www.google.com/maps/search/?api=1&query=" + quote(_place_query(p))


def directions_url(p: dict) -> str:
    """Google Maps directions to the same place the reviews link opens. A bare coordinate becomes a
    "dropped pin" that Google may route to an overpass or the middle of a road; its own place
    routes to the entrance or parking it knows about."""
    return "https://www.google.com/maps/dir/?api=1&destination=" + quote(_place_query(p))


def _area(p: dict) -> str:
    r = p["region"]
    return r["city"] + (r["district"] if r["district"] != r["city"] else "")


def _anchor(p: dict) -> str | None:
    """Words that pin a search to this park without coordinates: its name and area, or for a park we
    named after the nearest street, that street and area (an address Google can find)."""
    q = _place_query(p)
    if not re.fullmatch(r"-?[\d.]+,-?[\d.]+", q):
        return q
    m = re.search(r"[（(]近(.+?)[）)]", p.get("name") or "")
    return _area(p) + m.group(1) if m else None


def place_url(loc: dict | None, name: str | None = None, kind: str | None = None, park: dict | None = None,
              place_id: str | None = None) -> str | None:
    """Google Maps for a nearby parking lot, toilet, shop, station or charger.

    The Google Maps app ignores the q/ll centre for a plain category search and lists 停車場 around
    the phone instead (a park found by search, across town, got the parent's own neighbourhood). So
    the words carry the place: "<park> <area> 附近的停車場" for the kind of place, "<name> <area>"
    for a named one. ll/sll stay for the web version, which honours them."""
    if not loc:
        return None
    ll = f"{loc['lat']},{loc['lng']}"
    if place_id:
        # Google's own listing for this very place: it shows its name, not our coordinates.
        return f"https://www.google.com/maps/search/?api=1&query={ll}&query_place_id={quote(place_id, safe='')}"
    name, kind = (name or "").strip(), (kind or "").strip()
    if name:
        term = f"{name} {_area(park)}" if park else name
    elif kind:
        anchor = _anchor(park) if park else None
        term = f"{anchor} 附近的{kind}" if anchor else kind
    else:
        return f"https://www.google.com/maps/search/?api=1&query={ll}"
    return f"https://maps.google.com/maps?q={quote(term, safe='')}&ll={ll}&sll={ll}&z=18"
