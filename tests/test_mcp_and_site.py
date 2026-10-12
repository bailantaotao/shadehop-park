import json

import pytest

import mcp_server.server as srv
import sitegen.build_site as bs
from pipeline.build_data import Builder, write_outputs

from .fixture import raw


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    d = tmp_path_factory.mktemp("data")
    b = Builder(raw())
    parks = b.build()
    write_outputs(parks, b.meta(parks), d, casters=b.casters_geojson(parks))
    return d


@pytest.fixture
def loaded(dataset, monkeypatch):
    payload = json.loads((dataset / "parks.json").read_text())
    monkeypatch.setattr(srv, "load", lambda: payload)
    return payload


def test_search_rain_cover(loaded):
    r = srv.search_parks(need_rain_cover=True)
    assert [x["id"] for x in r["results"]] == ["lk-w10"]
    assert r["as_of"] and r["disclaimer"]


def test_search_min_shade_uses_time(loaded):
    noon = srv.search_parks(min_shade=0.6, when="2026-12-15T12:10")
    assert "lk-w20" in [x["id"] for x in noon["results"]]
    night = srv.search_parks(min_shade=0.6, when="2026-12-15T20:00")
    assert night["slot_note"] and all(x["rain_cover"] is True for x in night["results"])


def test_search_by_distance_and_chargers(loaded):
    lat, lng = 25.07, 121.36
    r = srv.search_parks(lat=lat, lng=lng, radius_km=0.2, need_fast_charger=True)
    assert [x["id"] for x in r["results"]] == ["lk-w10"]
    assert r["results"][0]["distance_km"] < 0.05


def test_get_tools(loaded):
    assert srv.get_park("nope")["error"] == "not_found"
    t = srv.get_shade_timeline("lk-w20", 12)
    assert len(t["slots"]) == 24 and t["slots"][12]["start"] == "12:00"
    assert all(c["speed"] in ("fast", "both") for c in srv.get_nearby_chargers("lk-w10", "fast")["chargers"])
    p = srv.get_nearby_parking("lk-w10")
    assert p["parking"][0]["name"] == "測試停車場"
    assert p["realtime"]["available"] is False  # no TDX credentials in tests


def test_mcp_server_registers_tools(loaded):
    pytest.importorskip("mcp.server.mcpserver")
    import asyncio

    tools = asyncio.run(srv.build_server().list_tools())
    assert {t.name for t in tools} == {f.__name__ for f in srv.TOOLS}


def test_site_build(dataset, tmp_path, monkeypatch):
    monkeypatch.setattr(bs, "DATA", dataset)
    out = tmp_path / "public"
    bs.build(out)
    page = (out / "parks" / "lk-w10" / "index.html").read_text()
    assert "application/ld+json" in page and "下雨可以玩嗎" in page
    ld = json.loads(page.split('<script type="application/ld+json">')[1].split("</script>")[0])
    assert ld["@type"] == "Playground" and ld["geo"]["latitude"]
    assert "GPTBot" in (out / "robots.txt").read_text()
    assert "/parks/lk-w20/" in (out / "sitemap.xml").read_text()
    assert "快充" in (out / "llms-full.txt").read_text()
    assert (out / "api" / "casters.geojson").exists()
    assert "Access-Control-Allow-Origin" in (out / "_headers").read_text()
    assert json.loads((out / "openapi.json").read_text())["openapi"].startswith("3.1")
