"""Geometry helpers: a local metric projection and Overpass element -> shapely."""

from __future__ import annotations

import math

import shapely
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

EARTH_R = 6371008.8


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


class LocalProjection:
    """Equirectangular projection around a reference point (metres, x=east, y=north).

    Error is well below 0.1% across a ~20 km district, which is far smaller
    than the uncertainty of the building heights it is used with.
    """

    def __init__(self, lat0: float, lng0: float):
        self.lat0, self.lng0 = lat0, lng0
        self.kx = math.radians(1) * EARTH_R * math.cos(math.radians(lat0))
        self.ky = math.radians(1) * EARTH_R

    def xy(self, lng: float, lat: float) -> tuple[float, float]:
        return (lng - self.lng0) * self.kx, (lat - self.lat0) * self.ky

    def lnglat(self, x: float, y: float) -> tuple[float, float]:
        return self.lng0 + x / self.kx, self.lat0 + y / self.ky

    def to_xy(self, geom):
        return shapely.transform(geom, lambda c: (c - (self.lng0, self.lat0)) * (self.kx, self.ky))

    def to_lnglat(self, geom):
        return shapely.transform(geom, lambda c: c / (self.kx, self.ky) + (self.lng0, self.lat0))


def _coords(geometry: list[dict]) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in geometry if p]


def element_geometry(el: dict):
    """Shapely geometry (lng/lat) for an Overpass `out geom` element, or None."""
    t = el["type"]
    if t == "node":
        return Point(el["lon"], el["lat"])
    if t == "way":
        pts = _coords(el.get("geometry", []))
        if len(pts) < 2:
            return None
        if len(pts) >= 4 and pts[0] == pts[-1]:
            poly = Polygon(pts)
            return poly if poly.is_valid else poly.buffer(0)
        return LineString(pts)
    if t == "relation":
        outers, inners = [], []
        for m in el.get("members", []):
            if m.get("type") != "way" or not m.get("geometry"):
                continue
            pts = _coords(m["geometry"])
            if len(pts) < 2:
                continue
            (inners if m.get("role") == "inner" else outers).append(LineString(pts))
        if not outers:
            return None
        outer = unary_union(list(polygonize(unary_union(outers))))
        if inners:
            outer = outer.difference(unary_union(list(polygonize(unary_union(inners)))))
        if outer.is_empty:
            return None
        return outer if isinstance(outer, (Polygon, MultiPolygon)) else None
    return None


def is_area(geom) -> bool:
    return isinstance(geom, (Polygon, MultiPolygon))
