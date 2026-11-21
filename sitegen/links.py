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


def place_url(loc: dict | None) -> str | None:
    """Google Maps pin at a nearby toilet, shop or station (coordinates: the name alone can match a
    different branch of the same chain)."""
    if not loc:
        return None
    return f"https://www.google.com/maps/search/?api=1&query={loc['lat']},{loc['lng']}"
