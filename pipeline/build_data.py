"""Turn raw OSM data into park records with shade, rain cover, parking and chargers.

    python -m pipeline.build_data          # reads data/raw/<region>.osm.json.gz
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import math
import multiprocessing
import os
import re
import shutil
import sys
import time
from pathlib import Path

from shapely import STRtree
from shapely.geometry import Point
from shapely.ops import unary_union

from . import config, shade_cache
from .chargers import classify, is_car_charger
from .geo import LocalProjection, element_geometry, is_area
from .shade import Caster, ShadeModel, best_windows, daytime_shaded_share, timetable

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

EXCLUDED_ACCESS = {"private", "no"}
# Bridges in these states are not (yet / any more) physically there.
NOT_BUILT = {"proposed", "razed", "abandoned", "disused"}
FOOT_HIGHWAYS = {"footway", "path", "cycleway", "steps", "pedestrian", "corridor", "bridleway"}
LEVEL_LABELS = {
    "A": "全天候遮蔽（下雨可玩）",
    "B": "部分遮陽設施 / 樹蔭",
    "C": "建物陰影遮陰（依時段）",
    "none": "大多曝曬",
}
PARKING_KIND = {
    "surface": "平面停車場",
    "multi-storey": "立體停車場",
    "underground": "地下停車場",
    "rooftop": "屋頂停車場",
    "street_side": "路邊停車",
    "lane": "路邊停車格",
}


def num(value: str | None) -> float | None:
    if value is None:
        return None
    m = re.match(r"\s*([\d.]+)", str(value))
    try:
        return float(m.group(1)) if m else None
    except ValueError:
        return None


def osm_ref(el: dict) -> dict:
    return {"type": el["type"], "id": el["id"], "url": f"https://www.openstreetmap.org/{el['type']}/{el['id']}"}


def building_height(tags: dict, default: float = config.DEFAULT_BUILDING_HEIGHT_M) -> tuple[float, float, bool]:
    """(z0, z1, known) for a building; `default` is used when neither height nor levels is tagged."""
    h = num(tags.get("height"))
    levels = num(tags.get("building:levels"))
    if h is not None and levels and h > levels * config.MAX_LEVEL_HEIGHT_M + config.MAX_ROOF_EXTRA_M:
        h = None  # typo such as height=290 on an 8-storey block; trust the level count
    known = h is not None
    if h is None and levels is not None:
        h = levels * config.LEVEL_HEIGHT_M + (num(tags.get("roof:levels")) or 0) * config.LEVEL_HEIGHT_M
        known = True
    if h is None:
        h = default
    z0 = num(tags.get("min_height"))
    if z0 is None and num(tags.get("building:min_level")) is not None:
        z0 = num(tags["building:min_level"]) * config.LEVEL_HEIGHT_M
    return (z0 or 0.0), max(h, (z0 or 0.0) + 0.5), known


def bridge_width(tags: dict) -> float:
    w = num(tags.get("width")) or num(tags.get("est_width"))
    if w:
        return w
    if tags.get("highway") in FOOT_HIGHWAYS:
        return 3.0
    lanes = num(tags.get("lanes"))
    if lanes:
        return lanes * config.LANE_WIDTH_M + 1.0
    if "railway" in tags:
        return config.BRIDGE_WIDTH_BY_CLASS["railway"]
    return config.BRIDGE_WIDTH_BY_CLASS.get(tags.get("highway", ""), config.BRIDGE_WIDTH_FALLBACK)


REGION_PREFIXES = sorted({r["name"].removesuffix("區").removesuffix("市") for r in config.REGIONS.values()} | {"台北"}, key=len, reverse=True)


def park_key(name: str | None, prefixes: tuple[str, ...] = ()) -> str | None:
    """Comparable park name: no bracketed codes, spaces, city/district prefix or generic words.

    '扶輪公園(公13)', '林口扶輪公園' (with prefix '林口') -> '扶輪公園'; '足夢運動公園 遊戲場' -> '足夢公園'.
    Names that reduce to nothing distinctive (e.g. '林口運動公園' -> '公園') return None.
    """
    if not name:
        return None
    k = re.sub(r"[（(].*?[)）]|\s|遊戲場|運動", "", name)
    for prefix in sorted(set(REGION_PREFIXES) | set(prefixes), key=len, reverse=True):
        k = k.removeprefix(prefix)
    return k if len(k) >= 3 and k != "公園" else None


def city_aliases(name: str, prefixes: tuple[str, ...] = ()) -> set[str]:
    """Keys for a registry name, including aliases in brackets: '林口社區運動公園(小熊公園，公鄰23)' -> 小熊公園."""
    keys = {park_key(name, prefixes)}
    for inner in re.findall(r"[（(](.*?)[)）]", name):
        keys |= {park_key(part, prefixes) for part in re.split(r"[，,、]", inner) if part.endswith("公園")}
    return {k for k in keys if k}


def short_district(name: str | None) -> str | None:
    """'林口區' -> '林口' (district names are written both ways)."""
    return name.removesuffix("區") if name and len(name) > 2 else name


def fact(value, method: str, verified_at: str, confidence: str, source: str, **extra) -> dict:
    d = {"value": value, "method": method, "verified_at": verified_at, "confidence": confidence, "source": source}
    d.update(extra)
    return d


# Parks are independent, so build_one runs in forked worker processes that share the
# already-indexed Builder (set just before forking).
_WORKER = None


def _build_worker(job: tuple[str, int]) -> dict | None:
    pool, i = job
    return _WORKER.build_one(*_WORKER._jobs[pool][i])


class Builder:
    def __init__(self, raw: dict, city: dict | None = None, region: dict | None = None, tdx: dict | None = None):
        self.raw = raw
        # Shade timetables from the previous build, by fingerprint (see shade_cache); main() fills it.
        self.tt_cache: dict = {}
        self.tt_used: dict = {}  # the tables this build used, to save as the next cache
        self.city = city
        self.tdx = tdx
        self.region = region or config.REGIONS[raw.get("region") or config.DEFAULT_REGION]
        self.osm_date = (raw.get("osm_base") or raw["fetched_at"])[:10]
        self.boundary = element_geometry(raw["boundary"])
        c = self.boundary.centroid
        self.proj = LocalProjection(c.y, c.x)
        self.boundary_xy = self.proj.to_xy(self.boundary)
        self.districts = []
        for rel in raw.get("districts") or []:
            g = element_geometry(rel)
            if g is not None and (rel.get("tags") or {}).get("name"):
                self.districts.append((rel["tags"]["name"], g))
        self.city_unmatched: list[dict] = []
        self._index()

    # ---------------------------------------------------------------- indexing
    def _default_heights(self) -> dict[str, float]:
        """Per building=* value, a conservative (lower-quartile) height from buildings of that
        type in the same data that do carry height/levels. Used only for untagged buildings."""
        known: dict[str, list[float]] = {}
        for el in self.raw["elements"]:
            tags = el.get("tags", {})
            kind = tags.get("building")
            if not kind or kind in ("no", "roof"):
                continue
            _, z1, ok = building_height(tags)
            if ok:
                known.setdefault(kind, []).append(z1)
        out = {}
        for kind, hs in sorted(known.items()):
            if len(hs) >= config.TYPE_HEIGHT_MIN_SAMPLES:
                hs.sort()
                out[kind] = max(config.DEFAULT_BUILDING_HEIGHT_M, hs[len(hs) // 4])
        return out

    def _index(self) -> None:
        self.default_heights = self._default_heights()
        self.playgrounds, self.parks, self.casters, self.covers = [], [], [], []
        self.parking, self.chargers, self.toilets, self.water, self.streets = [], [], [], [], []
        self.trees_xy = []
        seen = set()
        for el in self.raw["elements"]:
            key = (el["type"], el["id"])
            if key in seen:
                continue
            seen.add(key)
            tags = el.get("tags", {})
            geom = element_geometry(el)
            if geom is None or geom.is_empty:
                continue
            xy = self.proj.to_xy(geom)
            item = {"el": el, "tags": tags, "geom": geom, "xy": xy}

            if tags.get("leisure") == "playground":
                self.playgrounds.append(item)
            if tags.get("leisure") == "park" and is_area(geom):
                self.parks.append(item)

            bridge = tags.get("bridge")
            built = tags.get("highway") not in NOT_BUILT and tags.get("railway") not in NOT_BUILT
            if bridge and bridge != "no" and built and ("highway" in tags or "railway" in tags) and el["type"] == "way":
                if not is_area(xy):
                    deck = xy.buffer(bridge_width(tags) / 2, cap_style="flat")
                    low = tags.get("highway") in FOOT_HIGHWAYS
                    z0 = 4.0 if low else config.VIADUCT_DECK_BOTTOM_M
                    z1 = 5.0 if low else config.VIADUCT_DECK_TOP_M
                    self.casters.append(Caster(deck, z0, z1, "viaduct", False))
                    # Footbridges/boardwalks are too narrow to shelter anyone from rain.
                    if not low:
                        self.covers.append({"geom": deck, "kind": "under_viaduct", "item": item})
            elif tags.get("man_made") == "bridge" and is_area(xy):
                self.casters.append(Caster(xy, config.VIADUCT_DECK_BOTTOM_M, config.VIADUCT_DECK_TOP_M, "viaduct", False))
                self.covers.append({"geom": xy, "kind": "under_viaduct", "item": item})
            elif tags.get("building") == "roof" or tags.get("amenity") == "shelter":
                roof = xy if is_area(xy) else xy.centroid.buffer(config.SHELTER_NODE_RADIUS_M)
                kind = "pavilion" if tags.get("shelter_type") in ("gazebo", "pavilion") else "roof"
                self.casters.append(Caster(roof, config.ROOF_HEIGHT_M - 0.5, config.ROOF_HEIGHT_M, "roof", False))
                self.covers.append({"geom": roof, "kind": kind, "item": item})
            elif "building" in tags and tags["building"] != "no" and is_area(xy):
                z0, z1, known = building_height(tags, self.default_heights.get(tags["building"], config.DEFAULT_BUILDING_HEIGHT_M))
                self.casters.append(Caster(xy, z0, z1, "building", known))

            if tags.get("natural") == "tree" and el["type"] == "node":
                crown = num(tags.get("diameter_crown")) or config.TREE_DEFAULT_CROWN_M
                h = num(tags.get("height")) or config.TREE_DEFAULT_HEIGHT_M
                canopy = xy.buffer(crown / 2)
                self.casters.append(Caster(canopy, max(h * 0.4, 1.5), h, "tree", False))
                self.trees_xy.append(canopy)

            access = tags.get("access", "")
            if tags.get("amenity") == "parking" and access not in EXCLUDED_ACCESS:
                self.parking.append(item)
            if tags.get("amenity") == "charging_station" and access not in EXCLUDED_ACCESS and is_car_charger(tags):
                self.chargers.append(item)
            if tags.get("amenity") == "toilets" and access not in EXCLUDED_ACCESS:
                self.toilets.append(item)
            if tags.get("amenity") == "drinking_water":
                self.water.append(item)
            if "highway" in tags and tags.get("name") and not is_area(geom):
                self.streets.append(item)

        for c in self.chargers:
            c["charger"] = self._osm_charger(c)
        self._merge_tdx_chargers()
        self.shade = ShadeModel(self.casters)
        self.cover_tree = STRtree([c["geom"] for c in self.covers]) if self.covers else None
        self.tree_tree = STRtree(self.trees_xy) if self.trees_xy else None

    # ---------------------------------------------------------------- chargers
    def _osm_charger(self, item: dict) -> dict:
        t = item["tags"]
        return {
            "name": t.get("name") or t.get("brand") or t.get("operator") or "充電站",
            "operator": t.get("operator"),
            "brand": t.get("brand") or t.get("network"),
            **classify(t),
            "capacity": int(t["capacity"]) if t.get("capacity", "").isdigit() else None,
            "fee": t.get("fee"),
            "opening_hours": t.get("opening_hours"),
            "access": t.get("access"),
            "location": self._latlng(item["geom"]),
            "osm": osm_ref(item["el"]),
            "source": "osm",
            "verified_at": self.osm_date,
            "method": "osm",
        }

    def _tdx_charger(self, st: dict) -> dict:
        sockets = [{"type": c["type"], "label": c["label"], "current": c["current"], "count": c["count"], "output_kw": None}
                   for c in st["connectors"]]
        dc = any(c["current"] == "DC" for c in sockets)
        ac = any(c["current"] == "AC" for c in sockets)
        speed = "both" if dc and ac else "fast" if dc else "slow" if ac else "unknown"
        return {
            "name": st["name"],
            "operator": st.get("operator"),
            "brand": None,
            "speed": speed,
            "speed_label": {"fast": "快充 (DC)", "slow": "慢充 (AC)", "both": "快充 + 慢充", "unknown": "未標示"}[speed],
            "speed_source": "official" if speed != "unknown" else None,
            "sockets": sockets,
            "max_kw": None,
            "capacity": st.get("spaces"),
            "fee": None,
            "opening_hours": st.get("service_time"),
            "access": None,
            "charging_rate": st.get("charging_rate"),
            "parking_rate": st.get("parking_rate"),
            "floors": st.get("floors"),
            "restriction": st.get("restriction"),
            "operation_type": st.get("operation_type"),
            "location": {"lat": st["lat"], "lng": st["lng"]},
            "osm": None,
            "tdx_id": st["id"],
            "source": "tdx",
            "verified_at": (self.tdx.get("src_update_time") or self.tdx["fetched_at"])[:10],
            "method": "official_data",
        }

    def _merge_tdx_chargers(self) -> None:
        """Official TDX stations replace OSM chargers at the same spot (within CHARGER_MERGE_M),
        except an OSM fast charger next to a TDX site without DC (e.g. a Supercharger beside a
        car park with AC posts) - those are different stations."""
        if not self.tdx:
            return
        items = []
        for st in self.tdx["stations"]:
            pt = Point(st["lng"], st["lat"])
            item = {"el": {"type": "tdx", "id": st["id"]}, "tags": {}, "geom": pt, "xy": self.proj.to_xy(pt)}
            item["charger"] = self._tdx_charger(st)
            items.append(item)
        keep = []
        for c in self.chargers:
            near = [t for t in items if t["xy"].distance(c["xy"]) <= config.CHARGER_MERGE_M]
            osm_fast = c["charger"]["speed"] in ("fast", "both")
            if near and not (osm_fast and not any(t["charger"]["speed"] in ("fast", "both") for t in near)):
                continue  # same station; the official record wins
            keep.append(c)
        self.osm_chargers_merged = len(self.chargers) - len(keep)
        self.chargers = keep + items

    # ---------------------------------------------------------------- helpers
    def _nearest(self, items: list[dict], zone, radius: float) -> list[tuple[float, dict]]:
        out = []
        for it in items:
            d = it["xy"].distance(zone)
            if d <= radius:
                out.append((d, it))
        out.sort(key=lambda t: (t[0], str(t[1]["el"]["id"])))
        return out

    def _latlng(self, geom) -> dict:
        p = geom if isinstance(geom, Point) else geom.representative_point()
        return {"lat": round(p.y, 6), "lng": round(p.x, 6)}

    def _containing_park(self, pt) -> dict | None:
        for p in self.parks:
            if p["geom"].contains(pt):
                return p
        return None

    def _district(self, pt) -> str | None:
        for name, g in self.districts:
            if g.contains(pt):
                return name
        return None if self.districts else self.region["name"]

    def _nearest_street(self, zone) -> str | None:
        best = self._nearest(self.streets, zone, 150)
        return best[0][1]["tags"]["name"] if best else None

    # ---------------------------------------------------------------- records
    def _cover(self, zone, tags: dict) -> dict:
        ratios: dict[str, float] = {}
        items: dict[str, list] = {}
        if self.cover_tree is not None:
            by_kind: dict[str, list] = {}
            for i in self.cover_tree.query(zone):
                c = self.covers[i]
                if c["geom"].intersects(zone):
                    by_kind.setdefault(c["kind"], []).append(c["geom"])
                    items.setdefault(c["kind"], []).append(osm_ref(c["item"]["el"]))
            for kind, geoms in by_kind.items():
                ratios[kind] = round(unary_union(geoms).intersection(zone).area / zone.area, 2)
        all_cover, area = 0.0, 0.0
        if items:
            geoms = [self.covers[i]["geom"] for i in self.cover_tree.query(zone)]
            area = unary_union(geoms).intersection(zone).area
            all_cover = round(area / zone.area, 2)
        tagged = tags.get("covered")
        if tagged == "yes":
            all_cover, area = max(all_cover, 1.0), zone.area
            ratios["roof"] = max(ratios.get("roof", 0), 1.0)
        elif tagged == "partial":
            all_cover = max(all_cover, config.COVERED_PARTIAL_RATIO)
        return {"ratio": all_cover, "area_m2": int(round(area)), "by_kind": ratios, "refs": items, "tagged": tagged}

    def build_one(self, item: dict, kind: str = "playground") -> dict | None:
        """One record from an OSM playground/park item, or from an official registry point
        (item["official"] set, no OSM element)."""
        tags, el = item["tags"], item["el"]
        entry = item.get("official")
        if tags.get("access", "") in EXCLUDED_ACCESS:
            return None
        center = item["geom"] if isinstance(item["geom"], Point) else item["geom"].representative_point()
        if not self.boundary.contains(center):
            return None
        estimated = not is_area(item["xy"])
        zone = item["xy"].centroid.buffer(config.PLAYGROUND_NODE_RADIUS_M) if estimated else item["xy"]
        if zone.area < 4:
            return None

        if kind == "park":
            park_name = tags.get("name")
            if park_name:
                name, name_source = park_name, "osm_name"
            else:
                street = self._nearest_street(zone)
                name, name_source = (f"公園（近{street}）", "nearest_street") if street else ("未命名公園", "none")
        else:
            park = self._containing_park(center)
            park_name = park["tags"].get("name") if park else None
            if entry:
                name, name_source = entry["name"], "official"
            elif tags.get("name"):
                name, name_source = tags["name"], "osm_name"
            elif park_name:
                name, name_source = f"{park_name} 遊戲場", "park_name"
            else:
                street = self._nearest_street(zone)
                name, name_source = (f"遊戲場（近{street}）", "nearest_street") if street else ("未命名遊戲場", "none")

        src = self.city["source"] if entry else osm_ref(el)["url"]
        d = self.osm_date

        # --- indoor? A point/area inside a building outline is either an indoor venue
        # (親子館, KidZania) or a courtyard of a complex mapped as one building, so only an
        # explicit tag makes it indoor; otherwise it is "possible" and flagged for checking.
        casters = self.shade.nearby(zone, config.SHADOW_SEARCH_RADIUS_M)
        inside = zone.centroid
        enclosing = [c for c in casters if c.kind == "building" and c.geom.contains(inside)]
        if tags.get("indoor") == "yes" or tags.get("location") in ("indoor", "inside"):
            indoor = True
        else:
            indoor = "possible" if enclosing else False
        if indoor == "possible":
            casters = [c for c in casters if c not in enclosing]  # its own outline is not a shadow
        if estimated and not enclosing:
            # A point playground is approximated by a circle; it cannot extend into buildings,
            # and counting their footprints as "shade" would overstate it.
            walls = [c.geom for c in casters if c.kind == "building" and c.geom.intersects(zone)]
            if walls:
                trimmed = zone.difference(unary_union(walls))
                if trimmed.area >= config.MIN_ESTIMATED_ZONE_M2:
                    zone = trimmed

        # --- rain / roof cover
        cover = self._cover(zone, tags)
        viaduct_area = cover["by_kind"].get("under_viaduct", 0) * zone.area
        if indoor is True:
            rain_value = True
        elif cover["ratio"] >= config.COVERED_FULL_RATIO or (
                # A sizeable patch under a viaduct makes a mapped play area rain-proof. For a whole park
                # we don't know where the equipment is, so a strip under a bridge is only "partial".
                kind == "playground" and viaduct_area >= config.COVERED_MIN_AREA_M2
                and cover["ratio"] >= config.COVERED_PARTIAL_RATIO):
            rain_value = True
        elif cover["ratio"] >= config.COVERED_PARTIAL_RATIO or viaduct_area >= config.COVERED_MIN_AREA_M2:
            rain_value = "partial"
        else:
            rain_value = False
        rain = fact(
            rain_value, "computed" if cover["refs"] else "osm", d,
            "medium" if rain_value is not False else "low", src,
            covered_ratio=cover["ratio"],
            covered_area_m2=cover["area_m2"],
            note=(
                "OSM 標示為室內場所；可能需購票或有開放時間，請先確認" if indoor is True else
                (f"約 {cover['area_m2']} m² 在高架/屋頂下（佔 {int(cover['ratio'] * 100)}%）；"
                 "由 OSM 幾何交集推算，尚未實地驗證，請確認該區域可進入")
                if rain_value is not False else
                "位於 OSM 建物輪廓內，可能是室內場館或社區中庭，請確認" if indoor == "possible" else
                "OSM 未標示覆蓋此處的高架或屋頂；未實地驗證"
            ),
        )

        # --- computed shade timetable
        buildings = [c for c in casters if c.kind == "building"]
        known_share = (sum(c.height_known for c in buildings) / len(buildings)) if buildings else 1.0
        tt_key = shade_cache.key(zone, casters, center.y, center.x)
        table = self.tt_cache.get(tt_key)
        if table is None:
            table = timetable(zone, casters, center.y, center.x)
        share = round(daytime_shaded_share(table), 2)
        tt_conf = "medium" if known_share >= 0.7 else "low"

        trees_in_zone = len([i for i in self.tree_tree.query(zone) if self.trees_xy[i].intersects(zone)]) if self.tree_tree else 0

        # --- shade types
        shade_types = []
        if indoor is True:
            shade_types.append(fact(True, "osm", d, "medium", src, type="indoor", level="A", rain_proof=True))
        for cover_kind, ratio in sorted(cover["by_kind"].items()):
            shade_types.append(fact(True, "computed", d, "medium", src, type=cover_kind,
                                    level="A" if ratio >= config.COVERED_FULL_RATIO else "B",
                                    rain_proof=cover_kind in ("under_viaduct", "roof", "pavilion"),
                                    covered_ratio=ratio, osm=cover["refs"].get(cover_kind, [])))
        if trees_in_zone:
            shade_types.append(fact(True, "osm", d, "low", src, type="tree_canopy", level="B", rain_proof=False,
                                    trees=trees_in_zone, note="樹冠大小未知時以直徑 6m 估計；落葉季節遮蔭會變少"))
        if share >= config.LEVEL_C_MIN_DAYTIME_SHARE:
            shade_types.append(fact(True, "computed", d, tt_conf, src, type="building_shadow", level="C",
                                    rain_proof=False, daytime_shaded_share=share))

        if rain_value is True:
            level = "A"
        elif share >= config.LEVEL_C_MIN_DAYTIME_SHARE:
            level = "C"
        elif rain_value == "partial" or trees_in_zone:
            level = "B"
        else:
            level = "none"

        # --- parking
        parking = []
        for dist, p in self._nearest(self.parking, zone, config.PARKING_RADIUS_M)[: config.PARKING_MAX]:
            t = p["tags"]
            parking.append({
                "name": t.get("name") or PARKING_KIND.get(t.get("parking", ""), "停車場"),
                "kind": t.get("parking"),
                "kind_label": PARKING_KIND.get(t.get("parking", ""), "停車場"),
                "distance_m": int(round(dist)),
                "distance_method": "straight_line",
                "capacity": int(t["capacity"]) if t.get("capacity", "").isdigit() else None,
                "capacity_disabled": t.get("capacity:disabled"),
                "capacity_parent": t.get("capacity:parent"),
                "fee": t.get("fee"),
                "maxheight_m": num(t.get("maxheight")),
                "operator": t.get("operator"),
                "opening_hours": t.get("opening_hours"),
                "access": t.get("access"),
                "location": self._latlng(p["geom"]),
                "osm": osm_ref(p["el"]),
                "verified_at": d,
                "method": "osm",
            })

        # --- EV chargers
        chargers = []
        # Every charger within the radius (not a capped few), so the summary counts are right.
        for dist, c in self._nearest(self.chargers, zone, config.CHARGER_RADIUS_M):
            chargers.append({**c["charger"], "distance_m": int(round(dist)), "distance_method": "straight_line"})
        fast = [c for c in chargers if c["speed"] in ("fast", "both")]
        slow = [c for c in chargers if c["speed"] in ("slow", "both")]
        charger_summary = {
            "radius_m": config.CHARGER_RADIUS_M,
            "total": len(chargers),
            "fast": len(fast),
            "slow": len(slow),
            "unknown": len([c for c in chargers if c["speed"] == "unknown"]),
            "nearest_fast_m": fast[0]["distance_m"] if fast else None,
            "nearest_slow_m": slow[0]["distance_m"] if slow else None,
            "nearest_any_m": chargers[0]["distance_m"] if chargers else None,
        }
        # Keep the nearest few, but always include the nearest fast charger.
        shown = chargers[: config.CHARGER_MAX]
        if fast and fast[0] not in shown:
            shown.append(fast[0])
        tdx_used = any(c["source"] == "tdx" for c in shown)

        # --- nearby amenities
        toilets = self._nearest(self.toilets, zone, config.AMENITY_RADIUS_M)
        water = self._nearest(self.water, zone, config.AMENITY_RADIUS_M)
        amenities = {
            "toilet": fact(bool(toilets) or None, "osm", d, "medium" if toilets else "low", src,
                           distance_m=int(round(toilets[0][0])) if toilets else None,
                           changing_table=any(t[1]["tags"].get("changing_table") == "yes" for t in toilets) or None,
                           note=None if toilets else f"OSM 在 {config.AMENITY_RADIUS_M}m 內未標示公廁；不代表沒有"),
            "drinking_water": fact(bool(water) or None, "osm", d, "medium" if water else "low", src,
                                   distance_m=int(round(water[0][0])) if water else None),
        }

        loc = self._latlng(item["geom"])
        return {
            "id": f"{self.region['id_prefix']}-{el['type'][0]}{el['id']}",
            "kind": kind,
            "playground_mapped": kind == "playground" and not entry,
            "name": name,
            "name_source": name_source,
            "park_name": park_name,
            "region": {"id": self.region["id"], "city": self.region["city"],
                       "district": self._district(center) or (entry or {}).get("district") or self.region["name"]},
            "location": loc,
            "address": tags.get("addr:full") or (" ".join(filter(None, [tags.get("addr:street"), tags.get("addr:housenumber")])) or None),
            "osm": None if entry else osm_ref(el),
            "geometry_estimated": estimated,
            "indoor": indoor,
            "area_m2": int(round(zone.area)),
            "level": level,
            "level_label": LEVEL_LABELS[level],
            "rain_cover": rain,
            "shade_types": shade_types,
            "daytime_shaded_share": share,
            "best_shade_windows": best_windows(table),
            "_tt_key": tt_key,
            "shade_timetable": fact(None, "computed", d, tt_conf, src,
                                    slot_start="06:00", slot_minutes=config.TIMETABLE_SLOT_MIN,
                                    building_height_known_share=round(known_share, 2),
                                    buildings_considered=len(buildings),
                                    slots=table,
                                    note="依 OSM 建物高度/樓層、高架、屋頂、樹木與太陽位置推算（每月 15 日）；未計地形與臨時遮蔽"),
            "playground": {
                "surface": tags.get("surface"),
                "min_age": tags.get("min_age"),
                "max_age": tags.get("max_age"),
                "wheelchair": tags.get("wheelchair"),
                "opening_hours": tags.get("opening_hours"),
                "fee": tags.get("fee"),
                "equipment": sorted(k.split(":", 1)[1] for k, v in tags.items() if k.startswith("playground:") and v not in ("no", "0")),
            },
            "amenities": amenities,
            "parking": parking,
            "chargers": shown,
            "charger_summary": charger_summary,
            "updated_at": d,
            "sources": [
                {"name": "OpenStreetMap", "license": "ODbL 1.0", "url": "https://www.openstreetmap.org/copyright", "as_of": self.raw.get("osm_base")},
            ] + ([{"name": f"{self.tdx['attribution']}：{self.tdx['publisher']}「{self.tdx['title']}」", "license": self.tdx["license"],
                   "url": self.tdx["source"], "as_of": self.tdx.get("src_update_time") or self.tdx["fetched_at"]}] if tdx_used else []),
        }

    def _build_many(self, jobs: list[tuple[dict, str]]) -> list[dict | None]:
        """build_one over (item, kind) jobs, in parallel when there are enough of them."""
        global _WORKER
        workers = min(os.cpu_count() or 1, config.BUILD_WORKERS)
        if len(jobs) < 40 or workers < 2 or "fork" not in multiprocessing.get_all_start_methods():
            return [self.build_one(item, kind) for item, kind in jobs]
        self._jobs = {"jobs": jobs}
        _WORKER = self
        try:
            with multiprocessing.get_context("fork").Pool(workers) as pool:
                return pool.map(_build_worker, [("jobs", i) for i in range(len(jobs))], chunksize=4)
        finally:
            _WORKER, self._jobs = None, {}

    def build(self) -> list[dict]:
        jobs = [(p, "playground") for p in self.playgrounds]
        if self.region.get("park_candidates"):
            # Most Taiwanese neighbourhood parks have play equipment that OSM does not map
            # separately; list parks without a mapped playground as unconfirmed candidates.
            pg_points = [p["geom"] if isinstance(p["geom"], Point) else p["geom"].representative_point() for p in self.playgrounds]
            jobs += [(park, "park") for park in self.parks if not any(park["geom"].contains(pt) for pt in pg_points)]
        built = [(r, item["xy"]) for r, (item, _) in zip(self._build_many(jobs), jobs) if r]
        self._keep_tables(r for r, _ in built)
        keep = self._merge_same_name(self._dedupe(built))
        if self.city and self.city.get("kind") == "playgrounds":
            keep += self._match_official_points(keep)
        else:
            self._match_city(keep)
        for r in keep:
            r.pop("_zone", None)
        self._keep_tables(keep)  # official-only points built after matching
        keep.sort(key=lambda r: r["id"])
        return keep

    def _keep_tables(self, records) -> None:
        """Move each record's timetable fingerprint into tt_used (the next build's cache), including
        records later dropped as duplicates - the next build computes those again too."""
        for r in records:
            k = r.pop("_tt_key", None)
            if k:
                self.tt_used[k] = r["shade_timetable"]["slots"]

    def _dedupe(self, built: list[tuple[dict, object]]) -> list[dict]:
        """Drop duplicates: a node mapped inside/next to an already-mapped area, or an area
        mostly inside a larger one of the same kind (e.g. the equipment patch of a playground)."""
        records = [r for r, _ in built]
        shapes = [xy for _, xy in built]
        tree = STRtree(shapes)
        keep = []
        for i, r in enumerate(records):
            xy = shapes[i]
            near = [j for j in tree.query(xy.buffer(25)).tolist() if j != i and not records[j]["geometry_estimated"]]
            if r["geometry_estimated"]:
                dup = any(shapes[j].distance(xy) < 25 for j in near)
            else:
                dup = any(
                    records[j]["kind"] == r["kind"] and shapes[j].area > xy.area
                    and shapes[j].intersection(xy).area >= config.NESTED_DUPLICATE_RATIO * xy.area
                    for j in near
                )
            if not dup:
                r["_zone"] = xy if is_area(xy) else xy.buffer(config.PLAYGROUND_NODE_RADIUS_M)
                keep.append(r)
        return keep

    def _merge_same_name(self, records: list[dict]) -> list[dict]:
        """Several unnamed OSM points or fragments in one park all get the same derived name
        ("X公園 遊戲場", "公園（近Y路）") and would stack as separate markers. Keep one per cluster of
        same-name, same-kind (and same indoor status) places within SAME_NAME_MERGE_M: the best covered, then the largest."""
        rank = {"A": 0, "C": 1, "B": 2, "none": 3}
        order = sorted(range(len(records)), key=lambda i: (rank[records[i]["level"]], -(records[i]["area_m2"] or 0), records[i]["id"]))
        kept: list[dict] = []
        for i in order:
            r = records[i]
            if not any(k["name"] == r["name"] and k["kind"] == r["kind"] and k["indoor"] == r["indoor"]
                       and k["_zone"].distance(r["_zone"]) < self._merge_gap(k, r) for k in kept):
                kept.append(r)
        return kept

    @staticmethod
    def _merge_gap(a: dict, b: dict) -> float:
        # Mapped outlines are real shapes: only near-touching fragments are one place. Two outlined
        # play areas in a big park (青年公園) stay separate; estimated points merge within the wider gap.
        both_mapped = not a["geometry_estimated"] and not b["geometry_estimated"]
        return config.SAME_NAME_MERGE_MAPPED_M if both_mapped else config.SAME_NAME_MERGE_M

    def _official(self, entry: dict, method: str, distance_m: int | None = None, group: list[dict] | None = None) -> dict:
        group = group or [entry]
        equipment: dict[str, int] = {}
        for e in group:
            for k, v in (e.get("equipment") or {}).items():
                equipment[k] = equipment.get(k, 0) + v
        return {
            "name": entry["name"],
            "address": entry.get("address"),
            "management": entry.get("management"),
            "phone": entry.get("phone"),
            "equipment": equipment or None,
            "facilities": entry.get("facilities"),
            "features": entry.get("features"),
            "registry_points": len(group),
            "method": method,
            "distance_m": distance_m,
            "verified_at": self.city["fetched_at"][:10],
            "source": self.city["source"],
        }

    def _registry_source(self) -> dict:
        return {"name": f"{self.city['publisher']}「{self.city['title']}」", "license": self.city["license"],
                "url": self.city["source"], "as_of": self.city["fetched_at"]}

    def _match_official_points(self, records: list[dict]) -> list[dict]:
        """Registry with coordinates (Taipei). The registry often lists one play area as several
        points a few metres apart, so: every official point within OFFICIAL_MATCH_M of an OSM
        playground is attached to the nearest one (equipment summed); the remaining points are
        grouped by name within OFFICIAL_MERGE_M and listed as their own records."""
        for r in records:
            r["official"] = None
        pg = [r for r in records if r["kind"] == "playground"]
        tree = STRtree([r["_zone"] for r in pg]) if pg else None
        attached: dict[str, list[tuple[float, dict]]] = {}
        leftovers = []
        for e in self.city["entries"]:
            pt = Point(e["lng"], e["lat"])
            if not self.boundary.contains(pt):
                continue
            xy = self.proj.to_xy(pt)
            best = None
            if tree is not None:
                for j in tree.query(xy.buffer(config.OFFICIAL_MATCH_M)).tolist():
                    dist = pg[j]["_zone"].distance(xy)
                    if dist <= config.OFFICIAL_MATCH_M and (best is None or dist < best[0]):
                        best = (dist, pg[j])
            if best is None:
                leftovers.append((e, pt, xy))
            else:
                attached.setdefault(best[1]["id"], []).append((best[0], e))
        by_id = {r["id"]: r for r in pg}
        for rid, hits in attached.items():
            hits.sort(key=lambda h: (h[0], h[1]["ref"]))
            r = by_id[rid]
            r["official"] = self._official(hits[0][1], "location_match", int(round(hits[0][0])), [e for _, e in hits])
            r["sources"].append(self._registry_source())
        # Group leftover points of the same park name that are close together.
        groups: list[list[tuple[dict, Point, object]]] = []
        for e, pt, xy in leftovers:
            for g in groups:
                if g[0][0]["name"] == e["name"] and any(xy.distance(o[2]) <= config.OFFICIAL_MERGE_M for o in g):
                    g.append((e, pt, xy))
                    break
            else:
                groups.append([(e, pt, xy)])
        items = []
        for g in groups:
            e, pt, xy = g[0]  # registry order is by ref, so the id is stable
            items.append({"el": {"type": "official", "id": e["ref"]}, "tags": {"leisure": "playground"},
                          "geom": pt, "xy": xy, "official": e, "group": [o[0] for o in g]})
        new = []
        for item, r in zip(items, self._build_many([(it, "playground") for it in items])):
            if r:
                r["official"] = self._official(item["official"], "official_record", None, item["group"])
                r["sources"].append(self._registry_source())
                new.append(r)
        return new

    def _match_city(self, records: list[dict]) -> None:
        """Registry without coordinates (New Taipei): attach the official entry by park name."""
        for r in records:
            r["official"] = None
        if not self.city:
            return
        entries = self.city["entries"]
        # District names are a common prefix in OSM park names ('林口扶輪公園' vs registry '扶輪公園').
        prefixes = tuple(sorted({short_district(n) for n, _ in self.districts} - {None}))
        by_key: dict[str, list[dict]] = {}
        for row in entries:
            for k in city_aliases(row["name"], prefixes):
                by_key.setdefault(k, []).append(row)
        matched = set()
        for r in records:
            keys = {park_key(r["park_name"], prefixes), park_key(r["name"] if r["name_source"] == "osm_name" else None, prefixes)} - {None}
            rows = {row["ref"]: row for k in keys for row in by_key.get(k, [])}
            # Same name in several districts (e.g. 中山公園): keep the one in this park's district.
            if len(rows) > 1:
                d = short_district(r["region"]["district"])
                rows = {ref: row for ref, row in rows.items() if short_district(row.get("district")) == d}
            if len(rows) != 1:
                continue  # no match, or ambiguous
            row = next(iter(rows.values()))
            if row.get("district") and self.districts and short_district(row["district"]) != short_district(r["region"]["district"]):
                continue  # same name, different district: not the same park
            matched.add(row["ref"])
            r["official"] = self._official(row, "name_match")
            r["sources"].append(self._registry_source())
            if row.get("playground") and r["kind"] == "park":
                # The city's own playground list confirms play equipment in this park.
                r["kind"] = "playground"
        self.city_unmatched = [{"name": row["name"], "address": row.get("address")} for row in entries if row["ref"] not in matched]

    def chargers_geojson(self) -> list[dict]:
        """Every car charger in the region's bbox (OSM + official TDX), for the map's charger layer."""
        feats = []
        for c in self.chargers:
            r = c["charger"]
            fid = f"t{r['tdx_id']}" if r["source"] == "tdx" else f"{c['el']['type'][0]}{c['el']['id']}"
            feats.append({
                "type": "Feature",
                "id": fid,
                "geometry": {"type": "Point", "coordinates": [r["location"]["lng"], r["location"]["lat"]]},
                "properties": {
                    "name": r["name"], "operator": r["operator"] or r["brand"],
                    "speed": r["speed"], "speed_label": r["speed_label"], "speed_source": r["speed_source"],
                    "max_kw": r["max_kw"],
                    "sockets": [f"{x['label']}" + (f" {x['current']}" if x.get("current") else "") + f"×{x['count']}"
                                + (f" {x['output_kw']:g}kW" if x.get("output_kw") else "") for x in r["sockets"]],
                    "capacity": r["capacity"], "fee": r["fee"], "opening_hours": r["opening_hours"], "access": r["access"],
                    "charging_rate": r.get("charging_rate"), "parking_rate": r.get("parking_rate"),
                    "floors": r.get("floors"), "restriction": r.get("restriction"),
                    "source": r["source"], "osm": (r["osm"] or {}).get("url"), "region": self.region["id"],
                },
            })
        return feats

    def casters_geojson(self, parks: list[dict]) -> dict:
        """Shade casters near any park, for drawing live shadows on the map (tiled by write_outputs)."""
        zones = unary_union([
            self.proj.to_xy(Point(p["location"]["lng"], p["location"]["lat"])).buffer(config.SHADOW_SEARCH_RADIUS_M)
            for p in parks
        ]) if parks else None
        feats = []
        if zones is not None and self.shade.tree is not None:
            for i in sorted(set(self.shade.tree.query(zones, predicate="intersects").tolist())):
                c = self.casters[i]
                g = self.proj.to_lnglat(c.geom.simplify(0.5))
                polys = g.geoms if g.geom_type == "MultiPolygon" else [g]
                for poly in polys:
                    if poly.is_empty:
                        continue
                    feats.append({
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in poly.exterior.coords]]},
                        "properties": {"k": c.kind, "z0": round(c.z0, 1), "z1": round(c.z1, 1), "h": int(c.height_known)},
                    })
        return {"type": "FeatureCollection", "features": feats}

    def meta(self, parks: list[dict]) -> dict:
        levels = {k: sum(1 for p in parks if p["level"] == k) for k in LEVEL_LABELS}
        charger_source = None
        if self.tdx:
            charger_source = {k: self.tdx.get(k) for k in ("title", "publisher", "source", "license", "attribution", "fetched_at", "src_update_time")}
        registry = None
        if self.city:
            registry = {k: self.city.get(k) for k in ("title", "publisher", "source", "license", "fetched_at", "kind")}
            registry["entries"] = len(self.city["entries"])
        return {
            "region": {k: v for k, v in self.region.items() if not k.startswith("osm_")},
            "generated_from_osm_base": self.raw.get("osm_base"),
            "fetched_at": self.raw.get("fetched_at"),
            "bbox": [round(v, 5) for v in self.boundary.bounds],
            "city_registry": registry,
            "charger_source": charger_source,
            "counts": {
                "parks": len(parks),
                "mapped_playgrounds": sum(1 for p in parks if p["playground_mapped"]),
                "park_candidates": sum(1 for p in parks if p["kind"] == "park"),
                "city_registry_parks": len(self.city["entries"]) if self.city else None,
                "matched_city_registry": sum(1 for p in parks if p.get("official") and p["official"]["method"] != "official_record"),
                "official_only": sum(1 for p in parks if p.get("official") and p["official"]["method"] == "official_record"),
                "by_level": levels,
                "parking_lots_in_bbox": len(self.parking),
                "chargers_in_bbox": len(self.chargers),
                "chargers_official": sum(1 for c in self.chargers if c["charger"]["source"] == "tdx"),
                "chargers_osm_only": sum(1 for c in self.chargers if c["charger"]["source"] == "osm"),
                "buildings_in_bbox": sum(1 for c in self.casters if c.kind == "building"),
                "buildings_with_height": sum(1 for c in self.casters if c.kind == "building" and c.height_known),
            },
            "license": "Data © OpenStreetMap contributors, ODbL 1.0. Derived shade values are estimates.",
            "assumptions": {
                k: getattr(config, k) for k in (
                    "PLAYGROUND_NODE_RADIUS_M", "LEVEL_HEIGHT_M", "DEFAULT_BUILDING_HEIGHT_M",
                    "VIADUCT_DECK_BOTTOM_M", "VIADUCT_DECK_TOP_M", "ROOF_HEIGHT_M",
                    "TREE_DEFAULT_CROWN_M", "TREE_DEFAULT_HEIGHT_M", "COVERED_FULL_RATIO",
                    "COVERED_PARTIAL_RATIO", "SHADED_SLOT_RATIO", "LEVEL_C_MIN_DAYTIME_SHARE",
                    "PARKING_RADIUS_M", "CHARGER_RADIUS_M", "AMENITY_RADIUS_M",
                    "MAX_LEVEL_HEIGHT_M", "TYPE_HEIGHT_MIN_SAMPLES", "OFFICIAL_MATCH_M", "OFFICIAL_MERGE_M", "CHARGER_MERGE_M",
                )
            },
            "default_building_heights_by_type": self.default_heights,
            # Official parks with no matching OSM record: missing/unnamed in OSM, or not a playground site.
            "city_registry_not_in_osm": self.city_unmatched,
            "level_labels": LEVEL_LABELS,
        }


def summary(p: dict) -> dict:
    """Flat properties for the map/GeoJSON."""
    return {
        "id": p["id"],
        "name": p["name"],
        "region": p["region"]["id"],
        "district": p["region"]["district"],
        "level": p["level"],
        "rain": p["rain_cover"]["value"],
        "covered_ratio": p["rain_cover"]["covered_ratio"],
        "shaded_share": p["daytime_shaded_share"],
        "parking_nearest_m": p["parking"][0]["distance_m"] if p["parking"] else None,
        "parking_name": p["parking"][0]["name"] if p["parking"] else None,
        "fast_nearest_m": p["charger_summary"]["nearest_fast_m"],
        "slow_nearest_m": p["charger_summary"]["nearest_slow_m"],
        "toilet": p["amenities"]["toilet"]["value"],
        "kind": p["kind"],
        "indoor": p.get("indoor", False),
        "official": bool(p.get("official")),
        "height_known": p["shade_timetable"]["building_height_known_share"],
        "timetable": p["shade_timetable"]["slots"],
        "best": p["best_shade_windows"],
    }


def combine_meta(metas: list[dict]) -> dict:
    """Dataset-wide meta: per-region details under `regions`, summed counts at the top."""
    counts: dict = {}
    for m in metas:
        for k, v in m["counts"].items():
            if isinstance(v, dict):
                counts.setdefault(k, {})
                for kk, vv in v.items():
                    counts[k][kk] = counts[k].get(kk, 0) + vv
            elif v is not None:
                counts[k] = counts.get(k, 0) + v
    bases = [m["generated_from_osm_base"] for m in metas if m["generated_from_osm_base"]]
    first = metas[0]
    return {
        "regions": {m["region"]["id"]: {k: v for k, v in m.items() if k not in ("assumptions", "level_labels", "license")} for m in metas},
        "region_ids": [m["region"]["id"] for m in metas],
        # Oldest OSM snapshot among regions, so "as of" never overstates freshness.
        "generated_from_osm_base": min(bases) if bases else None,
        "fetched_at": min(m["fetched_at"] for m in metas if m["fetched_at"]) if any(m["fetched_at"] for m in metas) else None,
        "counts": counts,
        "coverage": "、".join(m["region"]["city"] + (m["region"]["name"] if m["region"]["name"] != m["region"]["city"] else "") for m in metas),
        "license": first["license"],
        "assumptions": first["assumptions"],
        "level_labels": first["level_labels"],
    }


def caster_tiles(features: list[dict]) -> dict[str, list[dict]]:
    """Group shadow casters into CASTER_TILE_DEG tiles keyed 'x_y' (by first vertex),
    so the map loads only the tiles in view."""
    tiles: dict[str, list[dict]] = {}
    for f in features:
        lng, lat = f["geometry"]["coordinates"][0][0]
        key = f"{math.floor(lng / config.CASTER_TILE_DEG)}_{math.floor(lat / config.CASTER_TILE_DEG)}"
        tiles.setdefault(key, []).append(f)
    return tiles


def _dump(path: Path, obj, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    else:
        path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")


def _feature_collection(parks: list[dict]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "id": p["id"], "geometry": {"type": "Point", "coordinates": [p["location"]["lng"], p["location"]["lat"]]}, "properties": summary(p)}
            for p in parks
        ],
    }


def write_outputs(parks: list[dict], meta: dict, out: Path = DATA, casters: list[dict] | dict | None = None,
                  chargers: list[dict] | None = None) -> None:
    if "regions" not in meta:  # a single region's meta
        meta = combine_meta([meta])
    (out / "parks").mkdir(parents=True, exist_ok=True)
    for old in (out / "parks").glob("*.json"):
        old.unlink()
    for p in parks:
        _dump(out / "parks" / f"{p['id']}.json", p, pretty=True)
    # No combined parks.json in data/: it outgrew Cloudflare's 25 MB file limit and bloated git.
    # The site build assembles per-region and slim downloads from data/parks/*.json instead.
    (out / "parks.json").unlink(missing_ok=True)
    _dump(out / "meta.json", meta, pretty=True)
    _dump(out / "parks.geojson", _feature_collection(parks))
    # Per-region map data, so a phone only downloads the region it is looking at.
    shutil.rmtree(out / "regions", ignore_errors=True)
    regions = []
    for rid in meta["region_ids"]:
        rm = meta["regions"][rid]
        mine = [p for p in parks if p["region"]["id"] == rid]
        _dump(out / "regions" / f"{rid}.geojson", _feature_collection(mine))
        regions.append({"id": rid, "label": rm["region"]["label"], "city": rm["region"]["city"], "name": rm["region"]["name"],
                        "parks": len(mine), "bbox": rm["bbox"]})
    _dump(out / "regions" / "index.json", regions, pretty=True)
    if chargers is not None:
        unique = {f["id"]: f for f in chargers}  # regions' bboxes may overlap
        _dump(out / "chargers.geojson", {"type": "FeatureCollection", "features": [unique[k] for k in sorted(unique)]})
    if casters is not None:
        features = casters["features"] if isinstance(casters, dict) else casters
        shutil.rmtree(out / "casters", ignore_errors=True)
        (out / "casters.geojson").unlink(missing_ok=True)
        tiles = caster_tiles(features)
        for key, feats in tiles.items():
            _dump(out / "casters" / f"{key}.geojson", {"type": "FeatureCollection", "features": feats})
        _dump(out / "casters" / "index.json", {"tile_deg": config.CASTER_TILE_DEG, "tiles": sorted(tiles)})
    buf = io.StringIO()
    cols = ["id", "name", "city", "district", "lat", "lng", "level", "rain_cover", "covered_ratio", "daytime_shaded_share",
            "nearest_parking", "nearest_parking_m", "nearest_fast_charger_m", "nearest_slow_charger_m",
            "toilet_within_200m", "official_name", "osm_url", "updated_at"]
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(cols)
    for p in parks:
        w.writerow([
            p["id"], p["name"], p["region"]["city"], p["region"]["district"], p["location"]["lat"], p["location"]["lng"], p["level"],
            p["rain_cover"]["value"], p["rain_cover"]["covered_ratio"], p["daytime_shaded_share"],
            p["parking"][0]["name"] if p["parking"] else "", p["parking"][0]["distance_m"] if p["parking"] else "",
            p["charger_summary"]["nearest_fast_m"] or "", p["charger_summary"]["nearest_slow_m"] or "",
            p["amenities"]["toilet"]["value"] or "", (p.get("official") or {}).get("name") or "",
            (p["osm"] or {}).get("url") or "", p["updated_at"],
        ])
    (out / "parks.csv").write_text(buf.getvalue())


def load_raw(region_id: str = config.DEFAULT_REGION, path: Path | None = None) -> dict:
    path = path or DATA / "raw" / f"{region_id}.osm.json.gz"
    with gzip.open(path, "rt") as fh:
        return json.load(fh)


def load_city(region_id: str = config.DEFAULT_REGION, path: Path | None = None) -> dict | None:
    path = path or DATA / "raw" / f"{region_id}.city_parks.json"
    return json.loads(path.read_text()) if path.exists() else None


def load_tdx(region_id: str = config.DEFAULT_REGION, path: Path | None = None) -> dict | None:
    path = path or DATA / "raw" / f"{region_id}.tdx_chargers.json"
    return json.loads(path.read_text()) if path.exists() else None


def main(argv: list[str]) -> None:
    region_ids = argv or list(config.REGIONS)
    parks, metas, casters, chargers = [], [], [], []
    for rid in region_ids:
        t = time.time()
        b = Builder(load_raw(rid), load_city(rid), config.REGIONS[rid], load_tdx(rid))
        b.tt_cache = shade_cache.load(rid)
        mine = b.build()
        reused = len(b.tt_used.keys() & b.tt_cache.keys())
        print(f"{rid}: shade timetables reused {reused}/{len(b.tt_used)} from cache", file=sys.stderr)
        shade_cache.save(rid, b.tt_used)
        parks += mine
        metas.append(b.meta(mine))
        casters += b.casters_geojson(mine)["features"]
        chargers += b.chargers_geojson()
        print(f"{rid}: {len(mine)} parks in {time.time() - t:.0f}s {json.dumps(metas[-1]['counts'], ensure_ascii=False)}", file=sys.stderr)
    parks.sort(key=lambda r: r["id"])
    write_outputs(parks, combine_meta(metas), casters=casters, chargers=chargers)


if __name__ == "__main__":
    main(sys.argv[1:])
