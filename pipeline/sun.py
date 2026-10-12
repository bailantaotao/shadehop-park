"""Solar position (low-precision NOAA/Astronomical Almanac formulas, ~0.1° accuracy)."""

from __future__ import annotations

import math
from datetime import datetime, timezone


def sun_position(dt: datetime, lat: float, lng: float) -> tuple[float, float]:
    """Return (altitude_deg, azimuth_deg) for an aware datetime.

    Azimuth is measured clockwise from north (90 = east, 180 = south).
    """
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    n = dt.astimezone(timezone.utc).timestamp() / 86400.0 + 2440587.5 - 2451545.0

    mean_lng = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    ecl_lng = math.radians(mean_lng + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)

    ra = math.atan2(math.cos(eps) * math.sin(ecl_lng), math.cos(ecl_lng))
    dec = math.asin(math.sin(eps) * math.sin(ecl_lng))

    gmst_h = (18.697374558 + 24.06570982441908 * n) % 24
    ha = math.radians(gmst_h * 15 + lng) - ra

    phi = math.radians(lat)
    alt = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(ha))
    az = math.degrees(math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(dec) * math.cos(phi))) + 180
    return math.degrees(alt), az % 360
