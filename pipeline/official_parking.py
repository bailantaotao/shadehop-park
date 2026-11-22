"""Give OpenStreetMap car parks the name, fee and hours the city registered for them.

    python -m pipeline.official_parking          # update data/parks/*.json in place (no shade rebuild)

build_data applies the same matching while building. A lot matches the nearest official car park
within MATCH_M; the official name then leads (the OSM one is kept as osm_name), and the fare,
hours, address and car spaces fill what OSM lacks.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from . import config

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MATCH_M = 60  # official coordinates are often the entrance or the address point, a little off the lot outline


def load(region_id: str) -> dict | None:
    p = DATA / "raw" / f"{region_id}.official_parking.json"
    return json.loads(p.read_text()) if p.exists() else None


class Matcher:
    def __init__(self, official: dict | None):
        self.official = official
        self.lots = [x for x in (official or {}).get("lots") or []
                     if math.isfinite(x.get("lat", math.inf)) and math.isfinite(x.get("lng", math.inf))]
        # A coarse grid (~110 m cells) so each lookup checks only nearby lots.
        self.grid: dict[tuple[int, int], list[dict]] = {}
        for lot in self.lots:
            self.grid.setdefault(self._cell(lot["lat"], lot["lng"]), []).append(lot)

    @staticmethod
    def _cell(lat: float, lng: float) -> tuple[int, int]:
        return int(math.floor(lat * 1000)), int(math.floor(lng * 1000))

    @staticmethod
    def _dist(lat1, lng1, lat2, lng2) -> float:
        k = math.cos(math.radians((lat1 + lat2) / 2))
        return math.hypot((lat1 - lat2) * 111_195, (lng1 - lng2) * 111_195 * k)

    def nearest(self, lat: float, lng: float) -> tuple[float, dict] | None:
        cy, cx = self._cell(lat, lng)
        best = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for lot in self.grid.get((cy + dy, cx + dx), ()):
                    d = self._dist(lat, lng, lot["lat"], lot["lng"])
                    if d <= MATCH_M and (best is None or d < best[0]):
                        best = (d, lot)
        return best

    def enrich(self, q: dict) -> dict:
        """Return the parking entry with the official facts merged in (unchanged when none match)."""
        loc = q.get("location")
        hit = self.nearest(loc["lat"], loc["lng"]) if self.lots and loc else None
        if not hit:
            return q
        lot = hit[1]
        out = {k: v for k, v in q.items() if k not in ("official",)}
        if out.get("name") != lot["name"]:
            out["osm_name"] = None if q.get("name") == q.get("kind_label") else q.get("name")
        out["name"] = lot["name"]
        out["official"] = {
            "name": lot["name"],
            "address": lot.get("address"),
            "fare": lot.get("fare"),
            "hours": lot.get("hours"),
            "cars": lot.get("cars"),
            "source": lot.get("source"),
            "match_m": int(round(hit[0])),
        }
        if not out.get("capacity") and lot.get("cars"):
            out["capacity"] = lot["cars"]
        if not out.get("opening_hours") and lot.get("hours"):
            out["opening_hours"] = lot["hours"]
        return out

    def source_entries(self) -> list[dict]:
        if not self.official:
            return []
        return [{"name": s["name"], "url": s["url"], "license": self.official.get("license"),
                 "as_of": (self.official.get("fetched_at") or "")[:10]} for s in self.official.get("sources") or []]


def apply(p: dict, m: "Matcher") -> bool:
    """Merge official facts into one park's parking list and sources; True when anything changed."""
    if not p.get("parking"):
        return False
    before = json.dumps([p["parking"], p.get("sources")], ensure_ascii=False, sort_keys=True)
    p["parking"] = [m.enrich(q) for q in p["parking"]]
    names = {e["name"] for e in m.source_entries()}
    p["sources"] = [s for s in p.get("sources") or [] if s.get("name") not in names]
    if any(q.get("official") for q in p["parking"]):
        p["sources"] += m.source_entries()
    return json.dumps([p["parking"], p.get("sources")], ensure_ascii=False, sort_keys=True) != before


def main(argv: list[str]) -> None:
    """Apply to the parks already built and rewrite data/ (parks, region maps, CSV) without a shade rebuild."""
    from .build_data import write_outputs
    matchers = {rid: Matcher(load(rid)) for rid in (argv or list(config.REGIONS))}
    parks = [json.loads(f.read_text()) for f in sorted((DATA / "parks").glob("*.json"))]
    changed = sum(apply(p, matchers[p["region"]["id"]]) for p in parks if p["region"]["id"] in matchers)
    named = sum(bool(p["parking"] and p["parking"][0].get("official")) for p in parks)
    write_outputs(parks, json.loads((DATA / "meta.json").read_text()))
    print(f"updated {changed} parks; the nearest lot has an official name in {named}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
