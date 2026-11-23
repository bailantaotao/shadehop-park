"""Tie OpenStreetMap car parks to Google Maps places, and drop the unnamed lots Google does not know.

    python -m pipeline.google_place              # look up lots not asked about yet (needs .env.google)
    python -m pipeline.google_place --limit 500  # at most 500 requests this run
    python -m pipeline.google_place --apply      # rewrite data/ from the saved answers, no requests

Why: a lot OSM only calls 停車場 / 平面停車場 has no name to search, so its Google Maps link ended in
bare coordinates and read as an error. Google's Text Search (IDs only: no name or coordinate comes back,
and place IDs are the one thing its terms allow us to keep) says whether a car park sits within ~35 m of
the lot. The place ID then goes into the navigation link, so Google shows its own name for the lot.

A generic lot Google has no car park for is dropped: people who checked found those were mostly private or
closed. Every lot is asked about, named ones too: a lot with a real name is searched by that name within ~150 m, of any
Google type (a big lot's coordinate is often off its entrance, and some lots are filed as 交通服務 only); an
unnamed one by position within ~35 m, car parks only. A lot Google has no
car park for is dropped either way. Two lots that resolve to the same place ID are one car park OSM split in
pieces; only the nearest stays.

Each answer is then checked once more: Place Details (types only) must say the place is a car park (parking,
parking_lot, parking_garage) or a 交通服務 (how Google files some lots). A restaurant, shop or office the
name search landed on is rejected, so it counts as "Google has no car park there".

Bike-share docks are filed by Google as car parks too (YouBike三井站 is "parking_lot"). Each match is
therefore also checked against a "YouBike" search on the same spot: a place that search returns is a dock,
not a lot, and the lot is asked again with docks excluded.

Answers live in data/raw/google_places.json, keyed by OSM element, so a lot is asked about once.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "raw" / "google_places.json"
ENDPOINT = "https://places.googleapis.com/v1/places:searchText"
HALF_DEG = 0.00030  # ~33 m: only a car park right on the lot counts, not the one next door
HALF_DEG_NAMED = 0.00135  # ~150 m: a named lot is matched by its name, not by type (Google files some lots as 交通服務)


def lot_key(q: dict) -> str | None:
    o = q.get("osm")
    return f"{o['type']}/{o['id']}" if o else None


def is_generic(q: dict) -> bool:
    """A lot with no name of its own (only its kind)."""
    name = (q.get("name") or "").strip()
    return name in ("", (q.get("kind_label") or "").strip())


def search_name(q: dict) -> str:
    """What to search for: the lot's own name, or just 停車場 for an unnamed one."""
    return "停車場" if is_generic(q) else re.sub(r"[（(][^）)]*[）)]", "", q["name"]).strip() or "停車場"


def load() -> dict:
    return json.loads(CACHE.read_text())["lots"] if CACHE.exists() else {}


def save(lots: dict) -> None:
    CACHE.write_text(json.dumps({"version": 1, "lots": dict(sorted(lots.items()))}, ensure_ascii=False, indent=0) + "\n")


def apply(p: dict, lots: dict) -> bool:
    """Attach place IDs to one park's lots, drop the generic ones Google lacks, and merge split lots.
    A lot not asked about yet is kept untouched. True when the list changed."""
    keep, seen, changed = [], set(), False
    for q in p.get("parking") or []:
        hit = lots.get(lot_key(q) or "")
        if hit is not None and not hit.get("id"):
            changed = True  # asked, and Google has no car park there
            continue
        if hit is not None:
            if hit["id"] in seen:
                changed = True
                continue
            seen.add(hit["id"])
            if q.get("google_place_id") != hit["id"]:
                q = {**q, "google_place_id": hit["id"]}
                changed = True
        keep.append(q)
    p["parking"] = keep
    return changed


def _key() -> str:
    for f in (ROOT / ".env.google",):
        if f.exists():
            for line in f.read_text().splitlines():
                if line.startswith("GOOGLE_PLACES_KEY="):
                    return line.split("=", 1)[1].strip()
    return os.environ.get("GOOGLE_PLACES_KEY", "")


def ask(key: str, lat: float, lng: float, text: str = "停車場", half: float = HALF_DEG, parking_only: bool = True) -> str | None:
    """The place ID of a car park within ~35 m, None when Google has none. Raises on a failed request."""
    body = {
        "textQuery": text, "languageCode": "zh-TW", "pageSize": 1,
        "locationRestriction": {"rectangle": {
            "low": {"latitude": lat - half, "longitude": lng - half * 1.1},
            "high": {"latitude": lat + half, "longitude": lng + half * 1.1}}},
    }
    if parking_only:
        body.update({"includedType": "parking", "strictTypeFiltering": True})
    req = urllib.request.Request(ENDPOINT, json.dumps(body).encode(), {
        "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id"})
    for attempt in range(4):
        try:
            res = json.load(urllib.request.urlopen(req, timeout=20))
            return (res.get("places") or [{}])[0].get("id")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(2 + attempt * 3)
                continue
            raise RuntimeError(f"Places API {e.code}: {e.read().decode()[:200]}") from e
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1 + attempt)
    raise RuntimeError("Places API unreachable")


SHARED_QUERIES = ("YouBike", "微笑單車")  # Google lists YouBike docks under both names


def ask_many(key: str, lat: float, lng: float, text: str, half: float, parking_only: bool, size: int = 5) -> list[str]:
    """Place IDs Google lists for a text within a box around the spot (IDs only, up to size)."""
    body = {"textQuery": text, "languageCode": "zh-TW", "pageSize": size,
            "locationRestriction": {"rectangle": {
                "low": {"latitude": lat - half, "longitude": lng - half * 1.1},
                "high": {"latitude": lat + half, "longitude": lng + half * 1.1}}}}
    if parking_only:
        body.update({"includedType": "parking", "strictTypeFiltering": True})
    req = urllib.request.Request(ENDPOINT, json.dumps(body).encode(), {
        "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id"})
    for attempt in range(4):
        try:
            return [p["id"] for p in json.load(urllib.request.urlopen(req, timeout=20)).get("places") or []]
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(2 + attempt * 3)
                continue
            raise RuntimeError(f"Places API {e.code}: {e.read().decode()[:200]}") from e
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1 + attempt)
    raise RuntimeError("Places API unreachable")


def shared_ids(key: str, lat: float, lng: float, half: float) -> set[str]:
    out: set[str] = set()
    for text in SHARED_QUERIES:
        out.update(ask_many(key, lat, lng, text, half, False, 20))
        time.sleep(0.1)
    return out


PARKISH = {"parking", "parking_lot", "parking_garage", "transportation_service"}


def verify(key: str, place_id: str) -> bool:
    """True when Google files the place as a car park. A place that no longer exists is not one."""
    req = urllib.request.Request(f"https://places.googleapis.com/v1/places/{place_id}?languageCode=zh-TW", headers={
        "X-Goog-Api-Key": key, "X-Goog-FieldMask": "types"})
    for attempt in range(4):
        try:
            return bool(PARKISH & set(json.load(urllib.request.urlopen(req, timeout=20)).get("types") or []))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(2 + attempt * 3)
                continue
            raise RuntimeError(f"Places API {e.code}: {e.read().decode()[:200]}") from e
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1 + attempt)
    raise RuntimeError("Places API unreachable")


def pending(parks: list[dict], lots: dict) -> dict[str, tuple[float, float, str, float]]:
    todo: dict[str, tuple[float, float, str, float]] = {}
    for p in parks:
        for q in p.get("parking") or []:
            k = lot_key(q)
            if k and k not in lots and q.get("location"):
                todo[k] = (q["location"]["lat"], q["location"]["lng"], search_name(q),
                           HALF_DEG if is_generic(q) else HALF_DEG_NAMED)
    return todo


def main(argv: list[str]) -> None:
    from .build_data import write_outputs
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else None
    parks = [json.loads(f.read_text()) for f in sorted((DATA / "parks").glob("*.json"))]
    lots = load()
    todo = pending(parks, lots)
    print(f"{len(todo)} lots to ask about, {len(lots)} already answered", file=sys.stderr)
    if "--apply" not in argv and todo:
        key = _key()
        if not key:
            sys.exit("GOOGLE_PLACES_KEY missing: put it in .env.google")
        done = 0
        for k, (lat, lng, text, half) in list(todo.items())[: limit or None]:
            try:
                lots[k] = {"id": ask(key, lat, lng, text, half, half == HALF_DEG), "at": date.today().isoformat()}
            except RuntimeError as e:
                print(f"stopped at {k}: {e}", file=sys.stderr)
                break
            done += 1
            if done % 100 == 0:
                save(lots)
                print(f"  {done} asked", file=sys.stderr)
            time.sleep(0.12)
        save(lots)
        print(f"asked {done}; {len(todo) - done} still to ask", file=sys.stderr)
    unchecked = [k for k, v in lots.items() if v.get("id") and "ok" not in v]
    if "--apply" not in argv and unchecked:
        key = key if "key" in dir() else _key()
        rejected = 0
        for n, k in enumerate(unchecked, 1):
            try:
                ok = verify(key, lots[k]["id"])
            except RuntimeError as e:
                print(f"verify stopped at {k}: {e}", file=sys.stderr)
                break
            lots[k]["ok"] = ok
            if not ok:
                lots[k] = {"id": None, "rejected": lots[k]["id"], "at": lots[k]["at"]}
                rejected += 1
            if n % 200 == 0:
                save(lots)
                print(f"  {n}/{len(unchecked)} verified, {rejected} rejected", file=sys.stderr)
            time.sleep(0.1)
        save(lots)
        print(f"verified {len(unchecked)}; rejected {rejected} that are not car parks", file=sys.stderr)
    if "--apply" not in argv:
        key = _key()
        spots = {}
        for p in parks:
            for q in p.get("parking") or []:
                k = lot_key(q)
                if k and lots.get(k, {}).get("id") and "dock_checked" not in lots[k] and q.get("location"):
                    spots[k] = (q["location"]["lat"], q["location"]["lng"], search_name(q), q)
        found = redone = 0
        for n, (k, (lat, lng, text, q)) in enumerate(spots.items(), 1):
            half = HALF_DEG if is_generic(q) else HALF_DEG_NAMED
            try:
                docks = shared_ids(key, lat, lng, half)
                if lots[k]["id"] in docks:
                    found += 1
                    old = lots[k]["id"]
                    new = None
                    for cand in ask_many(key, lat, lng, text, half, half == HALF_DEG, 5):
                        if cand not in docks and cand != old and verify(key, cand):
                            new = cand
                            break
                    redone += bool(new)
                    lots[k] = {"id": new, "rejected": old, "why": "bike-share dock", "at": lots[k]["at"], "dock_checked": True}
                else:
                    lots[k]["dock_checked"] = True
            except RuntimeError as e:
                print(f"dock check stopped at {k}: {e}", file=sys.stderr)
                break
            if n % 200 == 0:
                save(lots)
                print(f"  {n}/{len(spots)} checked for docks, {found} were docks ({redone} re-matched)", file=sys.stderr)
            time.sleep(0.1)
        save(lots)
        print(f"dock check: {found} matches were bike-share docks; {redone} lots found a real car park instead", file=sys.stderr)
    changed = sum(apply(p, lots) for p in parks)
    left = len(pending(parks, lots))
    write_outputs(parks, json.loads((DATA / "meta.json").read_text()))
    print(f"updated {changed} parks; {left} lots not asked about yet (kept)", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
