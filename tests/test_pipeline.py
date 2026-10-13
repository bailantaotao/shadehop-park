from datetime import datetime, timedelta, timezone

import pytest
from shapely.geometry import Polygon

from pipeline.build_data import Builder, building_height, city_aliases, park_key, summary
from pipeline import config
from pipeline.chargers import classify, is_car_charger
from pipeline.shade import Caster, ShadeModel, best_windows, shadow
from pipeline.sun import sun_position

from .fixture import P, raw

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
    ({"socket:type": "type1_combo;type2_combo"}, "fast"),
    ({"capacity": "7kw"}, "slow"),
    ({"capacity": "360kw"}, "fast"),
    ({"capacity": "8"}, "unknown"),
    ({"brand": "U-Power 新北林口站"}, "fast"),
    ({"brand": "EVOASIS"}, "unknown"),
])
def test_charger_classification(tags, speed):
    assert classify(tags)["speed"] == speed


def test_building_height_typo_falls_back_to_levels():
    assert building_height({"building": "apartments", "building:levels": "8", "height": "290"}) == (0.0, 24.0, True)
    assert building_height({"building": "office", "building:levels": "30", "height": "128.9"})[1] == 128.9
    assert building_height({"building": "apartments"}, default=24.0) == (0.0, 24.0, False)


def test_untagged_buildings_use_local_type_height():
    tall = [{"type": "way", "id": 900 + i, "tags": {"building": "apartments", "building:levels": str(10 + i)}} for i in range(20)]
    data = raw()
    data["elements"] += tall
    assert Builder(data).default_heights == {"apartments": 45.0}  # lower quartile of 30..87 m
    assert Builder(raw()).default_heights == {}  # too few samples -> global default


def test_charger_max_kw():
    info = classify({"socket:type2": "2", "socket:type2:output": "7 kW", "socket:type2_combo": "1", "socket:type2_combo:output": "120 kW"})
    assert info["max_kw"] == 120


@pytest.fixture(scope="module")
def parks():
    return {p["osm"]["id"]: p for p in Builder(raw()).build()}


def test_filters_private_and_outside(parks):
    assert set(parks) == {10, 20, 30, 70}


def test_park_candidate_and_footbridge(parks):
    p = parks[70]
    assert p["kind"] == "park" and p["playground_mapped"] is False and p["name"] == "測試公園"
    assert p["rain_cover"]["value"] is False  # a footbridge is not shelter
    assert parks[10]["kind"] == "playground" and parks[10]["park_name"] == "高架公園"


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


def test_brand_inference_is_labelled():
    info = classify({"brand": "U-Power"})
    assert info["speed_source"] == "brand" and "營運商" in info["speed_label"]
    assert classify({"socket:type2": "1"})["speed_source"] == "sockets"


def test_scooter_swap_is_not_a_car_charger():
    assert not is_car_charger({"name": "GoStation"})
    assert not is_car_charger({"brand": "Gogoro"})
    assert is_car_charger({"brand": "EVOASIS"})


@pytest.mark.parametrize("name,key", [
    ("扶輪公園(公13)", "扶輪公園"),
    ("林口扶輪公園", "扶輪公園"),
    ("足夢運動公園 遊戲場", "足夢公園"),
    ("足夢公園(文小18)", "足夢公園"),
    ("林口運動公園", None),  # nothing distinctive left
    (None, None),
])
def test_park_key(name, key):
    assert park_key(name) == key


def test_city_aliases_include_bracketed_names():
    assert city_aliases("林口社區運動公園(小熊公園，公鄰23)") == {"社區公園", "小熊公園"}


def registry(kind, entries):
    return {"kind": kind, "fetched_at": "2026-10-13T00:00:00+00:00", "source": "https://data.example/x",
            "publisher": "測試市政府", "title": "測試名冊", "license": "政府資料開放授權條款第1版", "entries": entries}


def entry(ref, name, x=None, y=None, **kw):
    lat = lng = None
    if x is not None:
        lng, lat = P.lnglat(x, y)
    return {"ref": ref, "name": name, "district": None, "address": None, "management": None, "phone": None,
            "lat": lat, "lng": lng, "equipment": None, **kw}


def test_city_registry_match():
    city = registry("parks", [
        entry("1", "測試公園(公鄰1)", address="測試路1號", management="測試區公所"),
        entry("2", "高架公園(公5)", management="測試區公所"),
        entry("3", "不存在公園", address="某路"),
    ])
    b = Builder(raw(), city)
    parks = {p["osm"]["id"]: p for p in b.build()}
    assert parks[70]["official"]["name"] == "測試公園(公鄰1)" and parks[70]["official"]["address"] == "測試路1號"
    assert parks[70]["official"]["method"] == "name_match"
    assert parks[10]["official"]["name"] == "高架公園(公5)"  # via the containing park's name
    assert parks[20]["official"] is None
    assert any(src["url"] == city["source"] for src in parks[70]["sources"])
    assert b.meta(list(parks.values()))["city_registry_not_in_osm"] == [{"name": "不存在公園", "address": "某路"}]


def test_official_points_match_by_location_and_fill_gaps():
    city = registry("playgrounds", [
        entry("510050", "塔北遊戲場", 510, 50, equipment={"鞦韆": 2}),  # 20 m north of playground C
        entry("1500900", "官方小公園", 1500, 900, district="測試區"),   # no OSM playground nearby
        entry("9000900", "區外遊戲場", 9000, 900),                        # outside the boundary
    ])
    b = Builder(raw(), city, config.REGIONS["taipei"])
    parks = {p["id"]: p for p in b.build()}
    c = parks["tp-w20"]
    assert c["official"]["method"] == "location_match" and c["official"]["distance_m"] == 20
    assert c["official"]["equipment"] == {"鞦韆": 2} and c["official"]["name"] == "塔北遊戲場"
    o = parks["tp-o1500900"]
    assert o["official"]["method"] == "official_record" and o["osm"] is None
    assert o["kind"] == "playground" and o["playground_mapped"] is False and o["name"] == "官方小公園"
    assert o["geometry_estimated"] is True and o["region"]["id"] == "taipei"
    assert "tp-o9000900" not in parks
    assert "tp-w70" not in parks  # Taipei does not list park candidates
    counts = b.meta(list(parks.values()))["counts"]
    assert counts["matched_city_registry"] == 1 and counts["official_only"] == 1


def test_official_records_match_schema():
    import json
    from pathlib import Path

    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((Path(__file__).resolve().parent.parent / "schema" / "park.schema.json").read_text())
    city = registry("playgrounds", [entry("510050", "塔北遊戲場", 510, 50), entry("1500900", "官方小公園", 1500, 900)])
    for p in Builder(raw(), city, config.REGIONS["taipei"]).build():
        jsonschema.validate(p, schema)


def test_nearby_official_points_merge_instead_of_duplicating():
    city = registry("playgrounds", [
        entry("505020", "塔北遊戲場", 505, 20, equipment={"鞦韆": 2}),     # inside playground C
        entry("515025", "塔北遊戲場", 515, 25, equipment={"鞦韆": 1, "沙坑": 1}),  # also inside C
        entry("1500900", "官方小公園", 1500, 900, equipment={"搖搖樂": 1}),
        entry("1520910", "官方小公園", 1520, 910, equipment={"搖搖樂": 2}),  # 22 m away, same name
        entry("1800900", "官方小公園", 1800, 900),                          # 300 m away: separate play area
    ])
    parks = {p["id"]: p for p in Builder(raw(), city, config.REGIONS["taipei"]).build()}
    c = parks["tp-w20"]["official"]
    assert c["registry_points"] == 2 and c["equipment"] == {"鞦韆": 3, "沙坑": 1}
    o = parks["tp-o1500900"]["official"]
    assert o["registry_points"] == 2 and o["equipment"] == {"搖搖樂": 3}
    assert "tp-o1520910" not in parks and "tp-o1800900" in parks


def test_playground_inside_a_building():
    from .fixture import node

    data = raw()
    data["elements"] += [
        node(80, 480, -25, leisure="playground", name="室內親子館", indoor="yes", fee="yes"),  # inside tower 21
        node(81, 545, -25, leisure="playground"),  # inside tower 21, untagged: indoor venue or courtyard?
    ]
    parks = {p["osm"]["id"]: p for p in Builder(data).build()}
    tagged, untagged = parks[80], parks[81]
    assert tagged["indoor"] is True and tagged["level"] == "A" and tagged["rain_cover"]["value"] is True
    assert any(s["type"] == "indoor" for s in tagged["shade_types"]) and tagged["playground"]["fee"] == "yes"
    assert untagged["indoor"] == "possible" and untagged["rain_cover"]["value"] is False
    # The enclosing outline is not treated as casting shade on its own interior.
    assert untagged["shade_timetable"]["slots"]["6"][12] == 0.0
    assert parks[20]["indoor"] is False
    jsonschema = pytest.importorskip("jsonschema")
    import json
    from pathlib import Path

    schema = json.loads((Path(__file__).resolve().parent.parent / "schema" / "park.schema.json").read_text())
    jsonschema.validate(tagged, schema)
    jsonschema.validate(untagged, schema)


def test_point_playground_zone_excludes_buildings():
    from .fixture import node

    data = raw()
    data["elements"].append(node(82, 555, -15, leisure="playground"))  # 5 m east of tower 21's wall
    p = {p["osm"]["id"]: p for p in Builder(data).build()}[82]
    circle = 3.14159 * 12 ** 2
    assert p["geometry_estimated"] and p["area_m2"] < circle * 0.85  # the part inside the tower is cut off
    # June 12:15: the near-vertical sun is just west of south, so the 60 m tower casts only a ~5 m strip
    # on the playground beside its east wall (the untrimmed circle would also count the tower itself).
    assert p["shade_timetable"]["slots"]["6"][12] < 0.4


def test_stale_overpass_data_is_rejected():
    from pipeline.fetch_osm import stale

    now = datetime(2026, 10, 13, tzinfo=timezone.utc)
    assert stale("2026-05-06T03:25:00Z", now)
    assert not stale("2026-10-12T20:21:35Z", now)
    assert not stale(None, now)
