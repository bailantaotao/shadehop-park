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
    ({"name": "恰吉先生快充站", "brand": "Mr.Charger恰吉先生"}, "fast"),
    ({"brand": "Power Express 全國特急電充電站(港墘路站)"}, "fast"),
    ({"brand": "EVALUE充電站"}, "unknown"),
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
    assert not is_car_charger({"name": "BES電池交換站", "operator": "台灣城市動力", "scooter": "yes"})
    assert not is_car_charger({"name": "板橋後站", "network": "BES 電池交換站"})
    assert not is_car_charger({"scooter": "yes"})
    assert not is_car_charger({"name": "機場捷運手機充電站/無線上網站"})
    assert is_car_charger({"scooter": "yes", "motorcar": "yes"})
    assert is_car_charger({})


@pytest.mark.parametrize("name,key", [
    ("扶輪公園(公13)", "扶輪公園"),
    ("林口扶輪公園", "扶輪公園"),
    ("足夢運動公園 遊戲場", "足夢公園"),
    ("足夢公園(文小18)", "足夢公園"),
    ("林口運動公園", None),  # nothing distinctive left
    (None, None),
])
def test_park_key(name, key):
    assert park_key(name, ("林口",)) == key


def test_city_aliases_include_bracketed_names():
    assert city_aliases("林口社區運動公園(小熊公園，公鄰23)", ("林口",)) == {"社區公園", "小熊公園"}


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
    data["elements"].append(node(82, 555, -15, leisure="playground", name="牆邊遊戲場"))  # 5 m east of tower 21's wall
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


def test_official_tdx_chargers_merge_with_osm():
    def st(sid, x, y, *currents):
        lng, lat = P.lnglat(x, y)
        return {"id": sid, "name": f"官方站{sid}", "operator": "測試電能", "lat": lat, "lng": lng, "spaces": 4,
                "connectors": [{"type": "type2" if c == "AC" else "type2_combo", "label": c, "current": c, "count": 2} for c in currents],
                "service_time": "每日/00:00-24:00", "charging_rate": "計度/5元每度", "parking_rate": None, "floors": None,
                "restriction": None, "operation_type": "公辦民營"}
    tdx = {"fetched_at": "2026-10-13T00:00:00+00:00", "src_update_time": "2026-10-13T03:55:36+08:00",
           "source": "https://data.gov.tw/dataset/170220", "publisher": "交通部", "title": "充電站之基本資料",
           "license": "政府資料開放授權條款第1版", "attribution": "資料介接「交通部TDX平臺」",
           "stations": [st("A", 105, 0, "AC"),      # same spot as OSM slow charger 50 -> replaces it
                        st("B", 310, 0, "AC"),      # next to OSM fast charger 51, but AC only -> both kept
                        st("C", 450, 0, "DC")]}
    b = Builder(raw(), tdx=tdx)
    parks = {p["osm"]["id"]: p for p in b.build()}
    p = parks[10]
    names = [c["name"] for c in p["chargers"]]
    assert "官方站A" in names and "官方站B" in names and "官方站C" in names
    assert not any(c["source"] == "osm" and c["speed"] == "slow" for c in p["chargers"])  # OSM 50 merged away
    assert any(c["source"] == "osm" and c["speed"] == "fast" for c in p["chargers"])       # OSM 51 kept
    a = next(c for c in p["chargers"] if c["name"] == "官方站A")
    assert a["speed"] == "slow" and a["speed_source"] == "official" and a["osm"] is None and a["charging_rate"] == "計度/5元每度"
    cs = p["charger_summary"]
    assert cs["total"] == 4 and cs["fast"] == 2 and cs["slow"] == 2
    assert any("交通部TDX平臺" in s["name"] for s in p["sources"])
    feats = b.chargers_geojson()
    assert {f["properties"]["source"] for f in feats} == {"osm", "tdx"} and len(feats) == 4
    assert b.meta(list(parks.values()))["counts"]["chargers_official"] == 3
    jsonschema = pytest.importorskip("jsonschema")
    import json
    from pathlib import Path

    schema = json.loads((Path(__file__).resolve().parent.parent / "schema" / "park.schema.json").read_text())
    jsonschema.validate(p, schema)


def test_name_match_uses_district_and_confirms_playgrounds():
    from .fixture import ring

    data = raw()
    data["districts"] = [  # west and east halves of the test region
        {"type": "relation", "id": 801, "tags": {"name": "西區"}, "members": [{"type": "way", "role": "outer", "geometry": ring(-2000, -2000, 0, 2000)}]},
        {"type": "relation", "id": 802, "tags": {"name": "東區"}, "members": [{"type": "way", "role": "outer", "geometry": ring(0, -2000, 2000, 2000)}]},
    ]
    city = registry("parks", [
        entry("e", "測試公園", district="東區"),
        entry("w", "測試公園", district="西區", playground=True, facilities="鞦韆、溜滑梯"),
    ])
    parks = {p["osm"]["id"]: p for p in Builder(data, city).build()}
    p = parks[70]  # 測試公園 lies in the west half
    assert p["region"]["district"] == "西區"
    assert p["official"]["facilities"] == "鞦韆、溜滑梯"
    assert p["kind"] == "playground"  # confirmed by the city's playground list


def test_big_park_with_a_strip_under_a_bridge_is_only_partial():
    # 300x300 m riverside park crossed by a 30 m wide bridge: ~10% (9000 m²) covered. The equipment could
    # be anywhere, so it is partial cover, not "全天候遮蔽".
    from .fixture import ll, ring, way
    data = raw()
    data["elements"] += [
        way(80, ring(1000, 1000, 1300, 1300), leisure="park", name="河濱公園"),
        way(81, [ll(950, 1150), ll(1350, 1150)], highway="primary", bridge="yes", layer="1", width="30"),
    ]
    p = next(x for x in Builder(data).build() if x["name"] == "河濱公園")
    assert p["rain_cover"]["value"] == "partial" and p["level"] != "A"


def test_same_name_points_in_one_park_are_merged():
    # Three unnamed playground points in one park all become "社區公園 遊戲場": one marker, not three.
    from .fixture import node, ring, way
    data = raw()
    data["elements"] += [
        way(90, ring(-1500, 1000, -1400, 1100), leisure="park", name="社區公園"),
        node(91, -1480, 1050, leisure="playground"), node(92, -1460, 1050, leisure="playground"),
        node(93, -1450, 1030, leisure="playground"),
    ]
    found = [p for p in Builder(data).build() if p["name"].startswith("社區公園")]
    assert len(found) == 1



def test_shade_cache_reuses_identical_timetables(monkeypatch, tmp_path):
    from pipeline import build_data, shade_cache

    first = Builder(raw())
    cold = first.build()
    shade_cache.save("t", first.tt_used, tmp_path)

    calls = []
    monkeypatch.setattr(build_data, "timetable", lambda *a, **k: calls.append(1))
    second = Builder(raw())
    second.tt_cache = shade_cache.load("t", tmp_path)
    warm = second.build()
    assert calls == [] and warm == cold  # nothing recomputed, same output
    assert "_tt_key" not in warm[0]


def test_shade_cache_key_changes_with_buildings():
    from shapely.geometry import box

    from pipeline import shade_cache
    zone = box(0, 0, 10, 10)
    tower = Caster(box(20, 0, 30, 10), 0, 30, "building")
    taller = Caster(box(20, 0, 30, 10), 0, 45, "building")
    assert shade_cache.key(zone, [tower], 25.0, 121.0) != shade_cache.key(zone, [taller], 25.0, 121.0)
    assert shade_cache.key(zone, [tower], 25.0, 121.0) == shade_cache.key(box(0, 0, 10, 10), [tower], 25.0, 121.0)


def test_nearby_toilets_shops_and_stations():
    # Playground 10 is at the origin; OSM already has a toilet node 30 m east (fixture node 60).
    from .fixture import node
    data = raw()
    data["elements"] += [
        node(95, 150, 0, shop="convenience", brand="7-ELEVEN", name="測試門市"),
        node(96, 900, 0, railway="station", station="subway", name="測試"),
    ]
    lat0, lng0 = P.lnglat(32, 0)[1], P.lnglat(32, 0)[0]  # same spot as the OSM toilet: one place
    lat1, lng1 = P.lnglat(250, 0)[1], P.lnglat(250, 0)[0]
    toilets = {"source": "https://data.gov.tw/dataset/30794", "sites": [
        {"name": "高架公園", "lat": lat0, "lng": lng0, "types": ["男廁所", "女廁所"], "diaper": 0, "category": "公園", "address": None, "grade": "特優級"},
        {"name": "測試百貨", "lat": lat1, "lng": lng1, "types": ["親子廁所"], "diaper": 2, "category": "商業營業場所", "address": None, "grade": "特優級"},
    ]}
    p = {x["osm"]["id"]: x for x in Builder(data, toilets=toilets).build()}[10]
    a = p["amenities"]
    assert a["toilet"]["method"] == "official_data" and a["toilet"]["name"] == "高架公園"
    assert a["toilet"]["family"]["name"] == "測試百貨" and a["toilet"]["family"]["family_room"] is True
    assert a["convenience_store"]["name"] == "7-ELEVEN 測試門市" and 130 < a["convenience_store"]["distance_m"] < 150
    assert a["station"]["name"] == "捷運測試站"
