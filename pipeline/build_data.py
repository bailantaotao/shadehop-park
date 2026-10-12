"""Turn raw OSM data into park records with shade, rain cover, parking and chargers.

    python -m pipeline.build_data          # reads data/raw/<region>.osm.json.gz
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import re
from pathlib import Path

from shapely import STRtree
from shapely.geometry import Point
from shapely.ops import unary_union

from . import config
from .chargers import classify
from .geo import LocalProjection, element_geometry, is_area
from .shade import Caster, ShadeModel, best_windows, daytime_shaded_share, timetable

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

EXCLUDED_ACCESS = {"private", "no"}
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


def building_height(tags: dict) -> tuple[float, float, bool]:
    """(z0, z1, known) for a building."""
    h = num(tags.get("height"))
    known = h is not None
    if h is None and num(tags.get("building:levels")) is not None:
        h = num(tags["building:levels"]) * config.LEVEL_HEIGHT_M + (num(tags.get("roof:levels")) or 0) * config.LEVEL_HEIGHT_M
        known = True
    if h is None:
        h = config.DEFAULT_BUILDING_HEIGHT_M
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


def fact(value, method: str, verified_at: str, confidence: str, source: str, **extra) -> dict:
    d = {"value": value, "method": method, "verified_at": verified_at, "confidence": confidence, "source": source}
    d.update(extra)
    return d


class Builder:
    def __init__(self, raw: dict):
        self.raw = raw
        self.osm_date = (raw.get("osm_base") or raw["fetched_at"])[:10]
        self.boundary = element_geometry(raw["boundary"])
        c = self.boundary.centroid
        self.proj = LocalProjection(c.y, c.x)
        self.boundary_xy = self.proj.to_xy(self.boundary)
        self._index()

    # ---------------------------------------------------------------- indexing
    def _index(self) -> None:
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
            if bridge and bridge != "no" and ("highway" in tags or "railway" in tags) and el["type"] == "way":
                if not is_area(xy):
                    deck = xy.buffer(bridge_width(tags) / 2, cap_style="flat")
                    low = tags.get("highway") in FOOT_HIGHWAYS
                    z0 = 4.0 if low else config.VIADUCT_DECK_BOTTOM_M
                    z1 = 5.0 if low else config.VIADUCT_DECK_TOP_M
                    self.casters.append(Caster(deck, z0, z1, "viaduct", False))
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
                z0, z1, known = building_height(tags)
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
            if tags.get("amenity") == "charging_station" and access not in EXCLUDED_ACCESS:
                self.chargers.append(item)
            if tags.get("amenity") == "toilets" and access not in EXCLUDED_ACCESS:
                self.toilets.append(item)
            if tags.get("amenity") == "drinking_water":
                self.water.append(item)
            if "highway" in tags and tags.get("name") and not is_area(geom):
                self.streets.append(item)

        self.shade = ShadeModel(self.casters)
        self.cover_tree = STRtree([c["geom"] for c in self.covers]) if self.covers else None
        self.tree_tree = STRtree(self.trees_xy) if self.trees_xy else None

    # ---------------------------------------------------------------- helpers
    def _nearest(self, items: list[dict], zone, radius: float) -> list[tuple[float, dict]]:
        out = []
        for it in items:
            d = it["xy"].distance(zone)
            if d <= radius:
                out.append((d, it))
        out.sort(key=lambda t: (t[0], t[1]["el"]["id"]))
        return out

    def _latlng(self, geom) -> dict:
        p = geom if isinstance(geom, Point) else geom.representative_point()
        return {"lat": round(p.y, 6), "lng": round(p.x, 6)}

    def _containing_park(self, pt) -> dict | None:
        for p in self.parks:
            if p["geom"].contains(pt):
                return p
        return None

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
        all_cover = 0.0
        if items:
            geoms = [self.covers[i]["geom"] for i in self.cover_tree.query(zone)]
            all_cover = round(unary_union(geoms).intersection(zone).area / zone.area, 2)
        tagged = tags.get("covered")
        if tagged == "yes":
            all_cover = max(all_cover, 1.0)
            ratios["roof"] = max(ratios.get("roof", 0), 1.0)
        elif tagged == "partial":
            all_cover = max(all_cover, config.COVERED_PARTIAL_RATIO)
        return {"ratio": all_cover, "by_kind": ratios, "refs": items, "tagged": tagged}

    def build_one(self, item: dict) -> dict | None:
        tags, el = item["tags"], item["el"]
        if tags.get("access", "") in EXCLUDED_ACCESS:
            return None
        center = item["geom"] if isinstance(item["geom"], Point) else item["geom"].representative_point()
        if not self.boundary.contains(center):
            return None
        estimated = not is_area(item["xy"])
        zone = item["xy"].centroid.buffer(config.PLAYGROUND_NODE_RADIUS_M) if estimated else item["xy"]
        if zone.area < 4:
            return None

        park = self._containing_park(center)
        park_name = park["tags"].get("name") if park else None
        if tags.get("name"):
            name, name_source = tags["name"], "osm_name"
        elif park_name:
            name, name_source = f"{park_name} 遊戲場", "park_name"
        else:
            street = self._nearest_street(zone)
            name, name_source = (f"遊戲場（近{street}）", "nearest_street") if street else ("未命名遊戲場", "none")

        src = osm_ref(el)["url"]
        d = self.osm_date

        # --- rain / roof cover
        cover = self._cover(zone, tags)
        if cover["ratio"] >= config.COVERED_FULL_RATIO:
            rain_value = True
        elif cover["ratio"] >= config.COVERED_PARTIAL_RATIO:
            rain_value = "partial"
        else:
            rain_value = False
        rain = fact(
            rain_value, "computed" if cover["refs"] else "osm", d,
            "medium" if rain_value is not False else "low", src,
            covered_ratio=cover["ratio"],
            note=(
                "由 OSM 高架/屋頂幾何與遊戲場範圍交集推算，尚未實地驗證"
                if rain_value is not False else "OSM 未標示覆蓋此遊戲場的高架或屋頂；未實地驗證"
            ),
        )

        # --- computed shade timetable
        casters = self.shade.nearby(zone, config.SHADOW_SEARCH_RADIUS_M)
        buildings = [c for c in casters if c.kind == "building"]
        known_share = (sum(c.height_known for c in buildings) / len(buildings)) if buildings else 1.0
        table = timetable(zone, casters, center.y, center.x)
        share = round(daytime_shaded_share(table), 2)
        tt_conf = "medium" if known_share >= 0.7 else "low"

        trees_in_zone = len([i for i in self.tree_tree.query(zone) if self.trees_xy[i].intersects(zone)]) if self.tree_tree else 0

        # --- shade types
        shade_types = []
        for kind, ratio in sorted(cover["by_kind"].items()):
            shade_types.append(fact(True, "computed", d, "medium", src, type=kind,
                                    level="A" if ratio >= config.COVERED_FULL_RATIO else "B",
                                    rain_proof=kind in ("under_viaduct", "roof", "pavilion"),
                                    covered_ratio=ratio, osm=cover["refs"].get(kind, [])))
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
                "capacity": num(t.get("capacity")) and int(num(t.get("capacity"))),
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
        for dist, c in self._nearest(self.chargers, zone, config.CHARGER_RADIUS_M)[: config.CHARGER_MAX * 3]:
            t = c["tags"]
            info = classify(t)
            chargers.append({
                "name": t.get("name") or t.get("brand") or t.get("operator") or "充電站",
                "operator": t.get("operator"),
                "brand": t.get("brand") or t.get("network"),
                **info,
                "capacity": num(t.get("capacity")) and int(num(t.get("capacity"))),
                "fee": t.get("fee"),
                "opening_hours": t.get("opening_hours"),
                "access": t.get("access"),
                "distance_m": int(round(dist)),
                "distance_method": "straight_line",
                "location": self._latlng(c["geom"]),
                "osm": osm_ref(c["el"]),
                "verified_at": d,
                "method": "osm",
            })
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
            "id": f"{config.REGION['id_prefix']}-{el['type'][0]}{el['id']}",
            "name": name,
            "name_source": name_source,
            "park_name": park_name,
            "region": {"city": config.REGION["city"], "district": config.REGION["name"]},
            "location": loc,
            "address": tags.get("addr:full") or (" ".join(filter(None, [tags.get("addr:street"), tags.get("addr:housenumber")])) or None),
            "osm": osm_ref(el),
            "geometry_estimated": estimated,
            "area_m2": int(round(zone.area)),
            "level": level,
            "level_label": LEVEL_LABELS[level],
            "rain_cover": rain,
            "shade_types": shade_types,
            "daytime_shaded_share": share,
            "best_shade_windows": best_windows(table),
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
                "equipment": sorted(k.split(":", 1)[1] for k, v in tags.items() if k.startswith("playground:") and v not in ("no", "0")),
            },
            "amenities": amenities,
            "parking": parking,
            "chargers": shown,
            "charger_summary": charger_summary,
            "updated_at": d,
            "sources": [
                {"name": "OpenStreetMap", "license": "ODbL 1.0", "url": "https://www.openstreetmap.org/copyright", "as_of": self.raw.get("osm_base")},
            ],
        }

    def build(self) -> list[dict]:
        records = [r for r in (self.build_one(p) for p in self.playgrounds) if r]
        # Drop duplicate playgrounds (node mapped inside an already-mapped area).
        areas = [self.proj.to_xy(Point(r["location"]["lng"], r["location"]["lat"])) for r in records]
        keep = []
        for i, r in enumerate(records):
            if r["geometry_estimated"]:
                dup = any(
                    not o["geometry_estimated"] and areas[i].distance(areas[j]) < 25
                    for j, o in enumerate(records) if j != i
                )
                if dup:
                    continue
            keep.append(r)
        keep.sort(key=lambda r: r["id"])
        return keep

    def casters_geojson(self, parks: list[dict]) -> dict:
        """Shade casters near any park, for drawing live shadows on the map."""
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
                        "geometry": {"type": "Polygon", "coordinates": [[[round(x, 6), round(y, 6)] for x, y in poly.exterior.coords]]},
                        "properties": {"k": c.kind, "z0": round(c.z0, 1), "z1": round(c.z1, 1), "h": int(c.height_known)},
                    })
        return {"type": "FeatureCollection", "features": feats}

    def meta(self, parks: list[dict]) -> dict:
        levels = {k: sum(1 for p in parks if p["level"] == k) for k in LEVEL_LABELS}
        return {
            "region": config.REGION,
            "generated_from_osm_base": self.raw.get("osm_base"),
            "fetched_at": self.raw.get("fetched_at"),
            "counts": {
                "parks": len(parks),
                "by_level": levels,
                "parking_lots_in_bbox": len(self.parking),
                "chargers_in_bbox": len(self.chargers),
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
                )
            },
            "level_labels": LEVEL_LABELS,
        }


def summary(p: dict) -> dict:
    """Flat properties for the map/GeoJSON."""
    return {
        "id": p["id"],
        "name": p["name"],
        "level": p["level"],
        "rain": p["rain_cover"]["value"],
        "covered_ratio": p["rain_cover"]["covered_ratio"],
        "shaded_share": p["daytime_shaded_share"],
        "parking_nearest_m": p["parking"][0]["distance_m"] if p["parking"] else None,
        "parking_name": p["parking"][0]["name"] if p["parking"] else None,
        "fast_nearest_m": p["charger_summary"]["nearest_fast_m"],
        "slow_nearest_m": p["charger_summary"]["nearest_slow_m"],
        "toilet": p["amenities"]["toilet"]["value"],
        "timetable": p["shade_timetable"]["slots"],
        "best": p["best_shade_windows"],
    }


def write_outputs(parks: list[dict], meta: dict, out: Path = DATA, casters: dict | None = None) -> None:
    (out / "parks").mkdir(parents=True, exist_ok=True)
    for old in (out / "parks").glob("*.json"):
        old.unlink()
    for p in parks:
        (out / "parks" / f"{p['id']}.json").write_text(json.dumps(p, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    (out / "parks.json").write_text(json.dumps({"meta": meta, "parks": parks}, ensure_ascii=False, sort_keys=True) + "\n")
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    gj = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "id": p["id"], "geometry": {"type": "Point", "coordinates": [p["location"]["lng"], p["location"]["lat"]]}, "properties": summary(p)}
            for p in parks
        ],
    }
    (out / "parks.geojson").write_text(json.dumps(gj, ensure_ascii=False, sort_keys=True) + "\n")
    if casters is not None:
        (out / "casters.geojson").write_text(json.dumps(casters, separators=(",", ":"), sort_keys=True) + "\n")
    buf = io.StringIO()
    cols = ["id", "name", "lat", "lng", "level", "rain_cover", "covered_ratio", "daytime_shaded_share",
            "nearest_parking", "nearest_parking_m", "nearest_fast_charger_m", "nearest_slow_charger_m",
            "toilet_within_200m", "osm_url", "updated_at"]
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(cols)
    for p in parks:
        w.writerow([
            p["id"], p["name"], p["location"]["lat"], p["location"]["lng"], p["level"],
            p["rain_cover"]["value"], p["rain_cover"]["covered_ratio"], p["daytime_shaded_share"],
            p["parking"][0]["name"] if p["parking"] else "", p["parking"][0]["distance_m"] if p["parking"] else "",
            p["charger_summary"]["nearest_fast_m"] or "", p["charger_summary"]["nearest_slow_m"] or "",
            p["amenities"]["toilet"]["value"] or "", p["osm"]["url"], p["updated_at"],
        ])
    (out / "parks.csv").write_text(buf.getvalue())


def load_raw(path: Path | None = None) -> dict:
    path = path or DATA / "raw" / f"{config.REGION['id']}.osm.json.gz"
    with gzip.open(path, "rt") as fh:
        return json.load(fh)


def main() -> None:
    b = Builder(load_raw())
    parks = b.build()
    meta = b.meta(parks)
    write_outputs(parks, meta, casters=b.casters_geojson(parks))
    print(json.dumps(meta["counts"], ensure_ascii=False))


if __name__ == "__main__":
    main()
