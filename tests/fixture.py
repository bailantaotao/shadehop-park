"""Synthetic OSM data for tests. Not real places."""

from pipeline.geo import LocalProjection

LAT0, LNG0 = 25.07, 121.36
P = LocalProjection(LAT0, LNG0)


def ll(x, y):
    lng, lat = P.lnglat(x, y)
    return {"lat": lat, "lon": lng}


def ring(x0, y0, x1, y1):
    return [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]


def way(id_, geometry, **tags):
    return {"type": "way", "id": id_, "geometry": geometry, "tags": tags}


def node(id_, x, y, **tags):
    p = ll(x, y)
    return {"type": "node", "id": id_, "lat": p["lat"], "lon": p["lon"], "tags": tags}


def raw():
    boundary = {
        "type": "relation", "id": 1, "tags": {"name": "測試區", "boundary": "administrative"},
        "members": [{"type": "way", "role": "outer", "geometry": ring(-2000, -2000, 2000, 2000)}],
    }
    elements = [
        # Playground A: 20x20 m fully under a 30 m-wide viaduct running east-west.
        way(10, ring(-10, -10, 10, 10), leisure="playground", name="高架下測試遊戲場", surface="rubber"),
        way(11, [ll(-300, 0), ll(300, 0)], highway="primary", bridge="yes", layer="1", width="30"),
        # Playground C: 20x20 m directly north of a 60 m tall, 80 m wide tower (sun is to the south).
        way(20, ring(500, 10, 520, 30), leisure="playground"),
        way(21, ring(470, -30, 550, 0), building="yes", height="60"),
        # Equipment patch mapped as its own playground inside playground C: duplicate, dropped.
        way(22, ring(505, 15, 515, 25), leisure="playground", surface="wood"),
        # Playground exposed: nothing around.
        node(30, -1000, -1000, leisure="playground"),
        # Private playground: excluded.
        # A proposed (not built) viaduct over it must not count as cover.
        way(33, [ll(-1300, -1000), ll(-700, -1000)], highway="proposed", proposed="primary", bridge="yes", width="30"),
        node(31, -1200, -1000, leisure="playground", access="private"),
        # Outside boundary: excluded.
        node(32, 5000, 5000, leisure="playground"),
        # Park without a mapped playground, crossed by a footbridge (not rain cover).
        way(70, ring(-1000, 500, -900, 600), leisure="park", name="測試公園"),
        way(71, [ll(-1010, 550), ll(-890, 550)], highway="footway", bridge="yes", layer="1"),
        # Park that contains playground A: must not be listed separately.
        way(72, ring(-50, -50, 50, 50), leisure="park", name="高架公園"),
        # Parking and chargers near playground A.
        node(40, 50, 50, amenity="parking", name="測試停車場", capacity="120", fee="yes", parking="surface"),
        node(41, 900, 900, amenity="parking", access="private"),
        node(50, 100, 0, amenity="charging_station", **{"socket:type2": "4", "socket:type2:output": "7 kW"}),
        node(51, 300, 0, amenity="charging_station", **{"socket:type2_combo": "2", "socket:type2_combo:output": "120 kW"}),
        node(60, 30, 0, amenity="toilets", changing_table="yes"),
    ]
    return {"fetched_at": "2026-10-01T00:00:00+00:00", "osm_base": "2026-10-01T00:00:00Z",
            "boundary": boundary, "elements": elements}
