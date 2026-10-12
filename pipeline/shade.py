"""Shadow casting: extrude objects to a height range and project them along the sun vector."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from shapely import STRtree
from shapely.affinity import translate
from shapely.geometry import MultiPoint, MultiPolygon, Polygon
from shapely.ops import unary_union

from . import config
from .sun import sun_position


@dataclass
class Caster:
    """A shade-casting object in local metres: occupies `geom` between heights z0 and z1."""

    geom: Polygon | MultiPolygon
    z0: float
    z1: float
    kind: str  # building | viaduct | roof | tree
    height_known: bool = True


def _sweep(poly: Polygon, dx: float, dy: float):
    """Area swept by moving `poly` along (dx, dy)."""
    moved = translate(poly, dx, dy)
    hull = poly.convex_hull
    if hull.area <= 0 or poly.area / hull.area > 0.95:
        pts = list(poly.exterior.coords) + list(moved.exterior.coords)
        return MultiPoint(pts).convex_hull
    parts = [poly, moved]
    ring = list(poly.exterior.coords)
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        quad = Polygon([(x1, y1), (x2, y2), (x2 + dx, y2 + dy), (x1 + dx, y1 + dy)])
        if quad.is_valid and quad.area > 0:
            parts.append(quad)
    return unary_union(parts)


def shadow(c: Caster, alt_deg: float, az_deg: float):
    """Ground shadow polygon of a caster for a given sun position, or None if sun is down."""
    if alt_deg <= 0:
        return None
    k = 1.0 / math.tan(math.radians(alt_deg))
    ux, uy = -math.sin(math.radians(az_deg)) * k, -math.cos(math.radians(az_deg)) * k
    polys = c.geom.geoms if isinstance(c.geom, MultiPolygon) else [c.geom]
    out = []
    for p in polys:
        base = translate(p, ux * c.z0, uy * c.z0) if c.z0 else p
        dz = c.z1 - c.z0
        out.append(_sweep(base, ux * dz, uy * dz))
    return unary_union(out)


class ShadeModel:
    def __init__(self, casters: list[Caster]):
        self.casters = casters
        self.tree = STRtree([c.geom for c in casters]) if casters else None

    def nearby(self, zone, radius: float) -> list[Caster]:
        if not self.tree:
            return []
        return [self.casters[i] for i in self.tree.query(zone.buffer(radius))]

    @staticmethod
    def ratio(zone, casters: list[Caster], alt: float, az: float) -> float:
        if zone.area <= 0:
            return 0.0
        k = 1.0 / math.tan(math.radians(alt))
        shadows = []
        for c in casters:
            # Cheap reject: the shadow cannot reach further than z1 * cot(alt).
            if c.geom.distance(zone) > c.z1 * k:
                continue
            s = shadow(c, alt, az)
            if s is not None and s.intersects(zone):
                shadows.append(s.intersection(zone))
        if not shadows:
            return 0.0
        return min(1.0, unary_union(shadows).area / zone.area)


def slot_times(month: int, year: int = 2026):
    tz = timezone(timedelta(hours=config.TZ_OFFSET_H))
    base = datetime(year, month, 15, tzinfo=tz)
    for i in range(config.TIMETABLE_SLOTS):
        # Sample the middle of each slot.
        yield i, base + timedelta(minutes=config.TIMETABLE_START_MIN + i * config.TIMETABLE_SLOT_MIN + config.TIMETABLE_SLOT_MIN / 2)


def timetable(zone, casters: list[Caster], lat: float, lng: float) -> dict[str, list[float | None]]:
    """{"1": [ratio|None x 24], ..., "12": [...]}; None = sun below MIN_SUN_ALTITUDE_DEG."""
    out = {}
    for month in range(1, 13):
        row = []
        for _, t in slot_times(month):
            alt, az = sun_position(t, lat, lng)
            if alt < config.MIN_SUN_ALTITUDE_DEG:
                row.append(None)
            else:
                row.append(round(ShadeModel.ratio(zone, casters, alt, az), 2))
        out[str(month)] = row
    return out


def daytime_shaded_share(table: dict[str, list[float | None]]) -> float:
    """Share of 09:00-16:00 slots with >= SHADED_SLOT_RATIO coverage, averaged over months."""
    first = (9 * 60 - config.TIMETABLE_START_MIN) // config.TIMETABLE_SLOT_MIN
    last = (16 * 60 - config.TIMETABLE_START_MIN) // config.TIMETABLE_SLOT_MIN
    vals = [v for row in table.values() for v in row[first:last] if v is not None]
    if not vals:
        return 0.0
    return sum(1 for v in vals if v >= config.SHADED_SLOT_RATIO) / len(vals)


def slot_label(i: int) -> str:
    m = config.TIMETABLE_START_MIN + i * config.TIMETABLE_SLOT_MIN
    return f"{m // 60:02d}:{m % 60:02d}"


def best_windows(table: dict[str, list[float | None]]) -> dict[str, dict | None]:
    """Per month, the longest run of slots with >= SHADED_SLOT_RATIO shade (ties -> higher mean).

    Returns {"1": {"start": "15:00", "end": "17:30", "mean": 0.82}, ...}; None if never shaded.
    """
    out: dict[str, dict | None] = {}
    for month, row in table.items():
        best = None
        i = 0
        while i < len(row):
            if row[i] is not None and row[i] >= config.SHADED_SLOT_RATIO:
                j = i
                while j < len(row) and row[j] is not None and row[j] >= config.SHADED_SLOT_RATIO:
                    j += 1
                vals = row[i:j]
                cand = (j - i, sum(vals) / len(vals), i, j)
                if best is None or cand[:2] > best[:2]:
                    best = cand
                i = j
            else:
                i += 1
        out[month] = None if best is None else {
            "start": slot_label(best[2]), "end": slot_label(best[3]), "start_slot": best[2], "end_slot": best[3],
            "mean": round(best[1], 2),
        }
    return out
