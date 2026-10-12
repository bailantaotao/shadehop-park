from datetime import datetime, timedelta, timezone

import pytest
from shapely.geometry import Polygon

from pipeline.build_data import Builder, summary
from pipeline.chargers import classify
from pipeline.shade import Caster, ShadeModel, best_windows, shadow
from pipeline.sun import sun_position

from .fixture import raw

TPE = timezone(timedelta(hours=8))


def test_sun_summer_solstice_noon_is_nearly_overhead():
    # Solar noon in Linkou (121.36E) is ~11:53 local; altitude ~ 90 - 25.07 + 23.44.
    alt, az = sun_position(datetime(2026, 6, 21, 11, 53, tzinfo=TPE), 25.07, 121.36)
    assert alt == pytest.approx(88.4, abs=0.5)


def test_sun_winter_noon_is_due_south():
    alt, az = sun_position(datetime(2026, 12, 21, 11, 52, tzinfo=TPE), 25.07, 121.36)
    assert alt == pytest.approx(90 - 25.07 - 23.44, abs=0.5)
    assert az == pytest.approx(180, abs=2)


def test_sun_morning_is_east_and_evening_west():
    _, am = sun_position(datetime(2026, 3, 20, 8, 0, tzinfo=TPE), 25.07, 121.36)
    _, pm = sun_position(datetime(2026, 3, 20, 16, 0, tzinfo=TPE), 25.07, 121.36)
    assert 60 < am < 130
    assert 230 < pm < 300


def test_shadow_points_away_from_sun():
    box = Caster(Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]), 0, 10, "building")
    s = shadow(box, 45, 180)  # sun due south at 45 deg -> 10 m shadow to the north
    minx, miny, maxx, maxy = s.bounds
    assert maxy == pytest.approx(20, abs=0.01) and miny == pytest.approx(0, abs=0.01)


def test_floating_deck_shadow_moves_off_the_ground_beneath():
    deck = Caster(Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]), 8, 10, "viaduct")
    zone = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    assert ShadeModel.ratio(zone, [deck], 89.9, 180) == pytest.approx(1.0, abs=0.02)
    assert ShadeModel.ratio(zone, [deck], 20, 270) == 0.0  # low western sun reaches under the deck


@pytest.mark.parametrize("tags,speed", [
    ({"socket:type2": "2"}, "slow"),
    ({"socket:type2_combo": "1"}, "fast"),
    ({"socket:chademo": "1", "socket:type2": "1"}, "both"),
    ({"socket:nacs": "2", "socket:nacs:output": "250 kW"}, "fast"),
    ({"socket:nacs": "2", "socket:nacs:output": "11 kW"}, "slow"),
    ({"socket:nacs": "2"}, "unknown"),
    ({"charging_station:output": "50 kW"}, "fast"),
    ({}, "unknown"),
])
def test_charger_classification(tags, speed):
    assert classify(tags)["speed"] == speed


def test_charger_max_kw():
    info = classify({"socket:type2": "2", "socket:type2:output": "7 kW", "socket:type2_combo": "1", "socket:type2_combo:output": "120 kW"})
    assert info["max_kw"] == 120


@pytest.fixture(scope="module")
def parks():
    return {p["osm"]["id"]: p for p in Builder(raw()).build()}


def test_filters_private_and_outside(parks):
    assert set(parks) == {10, 20, 30}


def test_under_viaduct_is_level_a(parks):
    p = parks[10]
    assert p["level"] == "A"
    assert p["rain_cover"]["value"] is True
    assert p["rain_cover"]["covered_ratio"] >= 0.95
    assert any(s["type"] == "under_viaduct" for s in p["shade_types"])


def test_north_of_tower_is_level_c(parks):
    p = parks[20]
    assert p["level"] == "C"
    assert p["rain_cover"]["value"] is False
    dec = p["shade_timetable"]["slots"]["12"]
    assert dec[12] == pytest.approx(1.0)  # 12:00-12:30 in December: fully shaded


def test_exposed_has_no_shade(parks):
    p = parks[30]
    assert p["level"] == "none"
    assert p["geometry_estimated"] is True
    assert all(v in (0.0, None) for row in p["shade_timetable"]["slots"].values() for v in row)


def test_sun_down_slots_are_null(parks):
    assert parks[30]["shade_timetable"]["slots"]["12"][0] is None  # 06:00 in December


def test_parking_and_chargers(parks):
    p = parks[10]
    assert [x["name"] for x in p["parking"]] == ["測試停車場"]  # private lot excluded
    assert p["parking"][0]["capacity"] == 120
    cs = p["charger_summary"]
    assert cs["fast"] == 1 and cs["slow"] == 1
    assert cs["nearest_slow_m"] < cs["nearest_fast_m"]
    assert p["amenities"]["toilet"]["value"] is True
    assert p["amenities"]["toilet"]["changing_table"] is True


def test_every_fact_has_provenance(parks):
    for p in parks.values():
        for f in [p["rain_cover"], p["shade_timetable"], *p["shade_types"], *p["amenities"].values()]:
            assert f["method"] and f["verified_at"] and f["confidence"] and f["source"]


def test_summary_is_flat(parks):
    s = summary(parks[10])
    assert s["level"] == "A" and s["fast_nearest_m"] == parks[10]["charger_summary"]["nearest_fast_m"]


def test_best_windows_picks_longest_run():
    row = [None, 0.1, 0.7, 0.8, 0.2, 0.9, 0.9, 0.9] + [0.0] * 16
    w = best_windows({"6": row, "7": [0.0] * 24})
    assert w["6"]["start"] == "08:30" and w["6"]["end"] == "10:00"
    assert w["7"] is None


def test_north_of_tower_best_window_includes_noon(parks):
    w = parks[20]["best_shade_windows"]["12"]
    assert w["start_slot"] <= 12 < w["end_slot"]


def test_casters_export():
    b = Builder(raw())
    gj = b.casters_geojson(b.build())
    kinds = {f["properties"]["k"] for f in gj["features"]}
    assert {"building", "viaduct"} <= kinds


def test_records_match_schema(parks):
    import json
    from pathlib import Path

    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((Path(__file__).resolve().parent.parent / "schema" / "park.schema.json").read_text())
    for p in parks.values():
        jsonschema.validate(p, schema)
