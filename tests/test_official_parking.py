from pipeline.official_parking import Matcher, apply

OFFICIAL = {"fetched_at": "2026-11-22T00:00:00+00:00", "license": "政府資料開放授權條款第1版",
            "sources": [{"name": "臺北市停車場資訊", "url": "https://data.taipei/"}],
            "lots": [{"name": "新新公園平面停車場", "lat": 25.0520, "lng": 121.5904, "fare": "20元/時", "hours": "9-17", "cars": 10, "source": "taipei"},
                     {"name": "壞座標", "lat": float("inf"), "lng": 121.5}]}


def lot(lat, lng, name="平面停車場"):
    return {"name": name, "kind_label": "平面停車場", "location": {"lat": lat, "lng": lng}, "capacity": None, "opening_hours": None}


def test_nearby_lot_takes_the_official_name_and_facts():
    q = Matcher(OFFICIAL).enrich(lot(25.05202, 121.59042))
    assert q["name"] == "新新公園平面停車場"
    assert q["osm_name"] is None  # OSM only had the kind
    assert q["official"]["fare"] == "20元/時" and q["capacity"] == 10 and q["opening_hours"] == "9-17"


def test_far_lot_is_left_alone():
    q = lot(25.0540, 121.5904, "某停車場")  # ~220 m away
    assert Matcher(OFFICIAL).enrich(q) == q


def test_apply_adds_the_source_once():
    p = {"parking": [lot(25.05202, 121.59042)], "sources": [{"name": "OpenStreetMap"}]}
    m = Matcher(OFFICIAL)
    assert apply(p, m) is True
    apply(p, m)
    assert [s["name"] for s in p["sources"]] == ["OpenStreetMap", "臺北市停車場資訊"]
