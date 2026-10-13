import json

import pytest

import mcp_server.server as srv
import sitegen.build_site as bs
from pipeline import config
from pipeline.build_data import Builder, combine_meta, write_outputs

from .fixture import P, raw


def taipei_registry():
    lng, lat = P.lnglat(1500, 900)
    return {"kind": "playgrounds", "fetched_at": "2026-10-13T00:00:00+00:00", "source": "https://data.gov.tw/dataset/136476",
            "publisher": "臺北市政府工務局公園路燈工程管理處", "title": "臺北市公園設施資料（兒童遊戲場）", "license": "政府資料開放授權條款第1版",
            "entries": [{"ref": "1500900", "name": "官方小公園", "district": "測試區", "address": None, "management": "測試所",
                         "phone": None, "lat": lat, "lng": lng, "equipment": {"鞦韆": 2}}]}


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    """Two regions built from the same synthetic map: newtaipei (nt-*) and taipei (tp-*)."""
    d = tmp_path_factory.mktemp("data")
    parks, metas, casters = [], [], []
    for b in (Builder(raw()), Builder(raw(), taipei_registry(), config.REGIONS["taipei"])):
        mine = b.build()
        parks += mine
        metas.append(b.meta(mine))
        casters += b.casters_geojson(mine)["features"]
    write_outputs(parks, combine_meta(metas), d, casters=casters)
    return d


@pytest.fixture
def loaded(dataset, monkeypatch):
    payload = json.loads((dataset / "parks.json").read_text())
    monkeypatch.setattr(srv, "load", lambda: payload)
    return payload


def test_search_rain_cover(loaded):
    r = srv.search_parks(need_rain_cover=True)
    assert sorted(x["id"] for x in r["results"]) == ["nt-w10", "tp-w10"]
    r = srv.search_parks(region="newtaipei", need_rain_cover=True)
    assert [x["id"] for x in r["results"]] == ["nt-w10"]
    assert r["as_of"] and r["disclaimer"]


def test_search_min_shade_uses_time(loaded):
    noon = srv.search_parks(min_shade=0.6, when="2026-12-15T12:10")
    assert "nt-w20" in [x["id"] for x in noon["results"]]
    night = srv.search_parks(min_shade=0.6, when="2026-12-15T20:00")
    assert night["slot_note"] and all(x["rain_cover"] is True for x in night["results"])


def test_search_by_distance_and_chargers(loaded):
    lat, lng = 25.07, 121.36
    r = srv.search_parks(region="newtaipei", lat=lat, lng=lng, radius_km=0.2, need_fast_charger=True)
    assert [x["id"] for x in r["results"]] == ["nt-w10"]
    assert r["results"][0]["distance_km"] < 0.05


def test_get_tools(loaded):
    assert srv.get_park("nope")["error"] == "not_found"
    t = srv.get_shade_timeline("nt-w20", 12)
    assert len(t["slots"]) == 24 and t["slots"][12]["start"] == "12:00"
    assert all(c["speed"] in ("fast", "both") for c in srv.get_nearby_chargers("nt-w10", "fast")["chargers"])
    p = srv.get_nearby_parking("nt-w10")
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
    page = (out / "parks" / "nt-w10" / "index.html").read_text()
    assert "application/ld+json" in page and "下雨可以玩嗎" in page
    ld = json.loads(page.split('<script type="application/ld+json">')[1].split("</script>")[0])
    assert ld["@type"] == "Playground" and ld["geo"]["latitude"]
    assert "GPTBot" in (out / "robots.txt").read_text()
    assert "/parks/nt-w20/" in (out / "sitemap.xml").read_text()
    assert "快充" in (out / "llms-full.txt").read_text()
    tiles = json.loads((out / "api" / "casters" / "index.json").read_text())
    assert tiles["tiles"] and all((out / "api" / "casters" / f"{k}.geojson").exists() for k in tiles["tiles"])
    regions = json.loads((out / "api" / "regions" / "index.json").read_text())
    assert [r["id"] for r in regions] == ["newtaipei", "taipei"]
    tp = json.loads((out / "api" / "regions" / "taipei.geojson").read_text())
    assert tp["features"] and all(f["id"].startswith("tp-") for f in tp["features"])
    official = (out / "parks" / "tp-o1500900" / "index.html").read_text()
    assert "官方小公園" in official and "鞦韆 2" in official and "OpenStreetMap 尚未標示" in official
    assert "臺北市" in (out / "llms.txt").read_text() and "新北市" in (out / "llms.txt").read_text()
    assert "Access-Control-Allow-Origin" in (out / "_headers").read_text()
    assert json.loads((out / "openapi.json").read_text())["openapi"].startswith("3.1")
