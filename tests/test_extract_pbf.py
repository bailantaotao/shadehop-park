import gzip
import json

import pytest

osmium = pytest.importorskip("osmium")
from osmium.osm.mutable import Node, Relation, Way  # noqa: E402

import pipeline.extract_pbf as ex  # noqa: E402
from pipeline.build_data import Builder  # noqa: E402

from .fixture import P  # noqa: E402


def write_pbf(path):
    """A tiny map: the 林口區 boundary (4 km square), features inside, one building far outside."""
    nodes, ways, rels = [], [], []
    nid = iter(range(1, 10_000))

    def pt(x, y, **tags):
        lng, lat = P.lnglat(x, y)
        n = Node(id=next(nid), location=(lng, lat), tags=tags)
        nodes.append(n)
        return n.id

    def square(x0, y0, x1, y1):
        a, b, c, d = pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)
        return [a, b, c, d, a]

    ways.append(Way(id=1, nodes=square(-2000, -2000, 2000, 2000), tags={}))  # untagged boundary ring
    rels.append(Relation(id=1, members=[("w", 1, "outer")],
                         tags={"type": "boundary", "boundary": "administrative", "admin_level": "7", "name": "林口區"}))
    ways.append(Way(id=10, nodes=square(-10, -10, 10, 10), tags={"leisure": "playground", "name": "測試遊戲場"}))
    ways.append(Way(id=20, nodes=square(30, -10, 60, 20), tags={}))  # untagged multipolygon outer
    rels.append(Relation(id=20, members=[("w", 20, "outer")], tags={"type": "multipolygon", "building": "yes", "height": "30"}))
    ways.append(Way(id=30, nodes=[pt(-300, 0), pt(300, 0)], tags={"highway": "primary", "bridge": "yes", "width": "30"}))
    ways.append(Way(id=40, nodes=[pt(-300, 50), pt(300, 50)], tags={"highway": "residential"}))  # unnamed: not wanted
    ways.append(Way(id=50, nodes=square(9000, 9000, 9020, 9020), tags={"building": "yes"}))  # outside bbox
    pt(100, 100, natural="tree")
    pt(20, 0, amenity="toilets")
    pt(9000, 0, amenity="toilets")  # outside bbox
    w = osmium.SimpleWriter(str(path))
    for n in nodes:
        w.add_node(n)
    for way in ways:
        w.add_way(way)
    for r in rels:
        w.add_relation(r)
    w.close()


def test_extract_matches_overpass_shape(tmp_path, monkeypatch):
    pbf = tmp_path / "taiwan.osm.pbf"
    write_pbf(pbf)
    monkeypatch.setattr(ex, "RAW_DIR", tmp_path)
    ex.extract(pbf, ["linkou"])
    raw = json.load(gzip.open(tmp_path / "linkou.osm.json.gz", "rt"))

    assert raw["region"] == "linkou" and raw["boundary"]["tags"]["name"] == "林口區"
    keys = {(e["type"], e["id"]) for e in raw["elements"]}
    assert ("way", 10) in keys and ("relation", 20) in keys and ("way", 30) in keys
    assert ("way", 40) not in keys and ("way", 50) not in keys
    nodes = [e for e in raw["elements"] if e["type"] == "node"]
    assert sorted(e["tags"].get("natural") or e["tags"].get("amenity") for e in nodes) == ["toilets", "tree"]
    # The untagged outer ring of the building relation still gets its geometry.
    rel = next(e for e in raw["elements"] if e["type"] == "relation")
    assert rel["members"][0]["geometry"] and rel["members"][0]["role"] == "outer"

    # And the pipeline builds from it like from an Overpass download.
    parks = Builder(raw).build()
    assert [p["name"] for p in parks] == ["測試遊戲場"]
    assert parks[0]["level"] == "A"  # under the 30 m wide bridge
    assert parks[0]["amenities"]["toilet"]["value"] is True
