"""Download each region's official park / playground registry (government open data).

    python -m pipeline.fetch_city            # all regions -> data/raw/<region>.city_parks.json
    python -m pipeline.fetch_city taipei     # one region

Registries are normalised to a list of entries:
    {ref, name, district, address, management, phone, lat, lng, equipment}
with null where the source has no such field. New Taipei's park list has no
coordinates (matched to OSM by name); Taipei's playground list has coordinates
and equipment counts (matched to OSM by location). If a portal is unreachable
the previous file is kept, so an OSM refresh is never blocked.
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import requests

from . import config
from .fetch_osm import RAW_DIR, UA

LICENSE = "政府資料開放授權條款第1版（相容 CC BY 4.0）"
PAGE_SIZE = 1000

NTPC_DATASET_ID = "5FE3A136-29CC-4695-A17E-6636A32C3342"
TAIPEI_PLAYGROUNDS_URL = "https://tppkl.blob.core.windows.net/blobfs/TaipeiParkFacility_Arcade.json"
TAIPEI_EQUIPMENT = {
    "組合遊具數量": "組合遊具", "磨石滑梯數量": "磨石滑梯", "鞦韆數量": "鞦韆", "翹翹板數量": "翹翹板",
    "搖搖樂數量": "搖搖樂", "攀爬組數量": "攀爬組", "戲沙坑數量": "沙坑", "擺盪船索數量": "擺盪船/繩索", "其他數量": "其他",
}


def _get_json(url: str, **params):
    r = requests.get(url, params=params or None, headers={"User-Agent": UA}, timeout=60)
    r.raise_for_status()
    return json.loads(r.content.decode("utf-8-sig"))


def ntpc_parks(region: dict) -> dict:
    api = f"https://data.ntpc.gov.tw/api/datasets/{NTPC_DATASET_ID}/json"
    rows, page = [], 0
    while True:
        batch = _get_json(api, page=page, size=PAGE_SIZE)
        rows += batch
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    entries = [{
        "ref": r.get("seqno"),
        "name": (r.get("name") or "").strip(),
        "district": r.get("area"),
        "address": (r.get("address") or "").strip() or None,
        "management": r.get("management"),
        "phone": r.get("localcallservice"),
        "lat": None, "lng": None, "equipment": None,
    } for r in rows if not region.get("registry_district") or r.get("area") == region["registry_district"]]
    entries.sort(key=lambda e: int(e["ref"] or 0))
    return {
        "kind": "parks",
        "source": f"https://data.ntpc.gov.tw/datasets/{NTPC_DATASET_ID}",
        "publisher": "新北市政府農業局",
        "title": "新北市公園",
        "entries": entries,
    }


@lru_cache(maxsize=1)
def _twd97():
    from pyproj import Transformer

    return Transformer.from_crs(3826, 4326, always_xy=True)


def twd97_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """TWD97 / TM2 zone 121 (EPSG:3826) metres -> (lat, lng)."""
    lng, lat = _twd97().transform(x, y)
    return lat, lng


def taipei_playgrounds(region: dict) -> dict:
    entries: dict[str, dict] = {}
    for r in _get_json(TAIPEI_PLAYGROUNDS_URL):
        try:
            x, y = float(r["X坐標"]), float(r["Y坐標"])
        except (KeyError, TypeError, ValueError):
            continue
        # The file repeats rows; one playground = one name at one spot.
        ref = f"{round(x)}{round(y)}"
        if ref in entries:
            continue
        lat, lng = twd97_to_wgs84(x, y)
        # '文山(木柵)' -> 文山, '園(信義)' -> 信義
        district = (r.get("行政區") or "").strip()
        outer, inner = re.sub(r"[(（].*?[)）]", "", district), re.findall(r"[(（](.*?)[)）]", district)
        district = outer if len(outer) >= 2 or not inner else inner[0]
        equipment = {}
        for key, label in TAIPEI_EQUIPMENT.items():
            try:
                n = int(float(r.get(key) or 0))
            except ValueError:
                n = 0
            if n > 0:
                equipment[label] = n
        entries[ref] = {
            "ref": ref,
            "name": (r.get("公園名稱") or "").strip(),
            "district": district + ("區" if district and not district.endswith("區") else ""),
            "address": None,
            "management": r.get("管理單位"),
            "phone": None,
            "lat": round(lat, 6), "lng": round(lng, 6),
            "equipment": equipment,
        }
    return {
        "kind": "playgrounds",
        "source": "https://data.gov.tw/dataset/136476",
        "publisher": "臺北市政府工務局公園路燈工程管理處",
        "title": "臺北市公園設施資料（兒童遊戲場）",
        "entries": sorted(entries.values(), key=lambda e: e["ref"]),
    }


TAOYUAN_DATASET = "https://opendata.tycg.gov.tw/api/dataset/4e233760-cb9c-4bca-bef2-e14ac80b1667/resource/{}/download"
# (resource id, is a playground list)
TAOYUAN_RESOURCES = [("cc8663dc-51f4-4a4f-9da1-f3fc266dc0c2", True),   # 特色遊戲場
                     ("eff0b4d8-2ef3-49ec-b894-68b92dac23f0", False)]  # 埤塘公園


def _csv(url: str) -> list[dict]:
    r = requests.get(url, headers={"User-Agent": UA}, timeout=60)
    r.raise_for_status()
    for enc in ("utf-8-sig", "cp950"):
        try:
            text = r.content.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("undecodable CSV")
    return list(csv.DictReader(io.StringIO(text)))


def taoyuan_parks(region: dict) -> dict:
    entries: dict[str, dict] = {}
    for res, is_playground in TAOYUAN_RESOURCES:
        for r in _csv(TAOYUAN_DATASET.format(res)):
            name = (r.get("公園名稱") or "").strip()
            district = (r.get("區域") or "").strip()
            if not name:
                continue
            ref = f"{district}/{name}"
            e = entries.setdefault(ref, {
                "ref": ref, "name": name, "district": district or None,
                "address": (r.get("地址") or "").strip() or None,
                "management": None, "phone": None, "lat": None, "lng": None, "equipment": None,
                "facilities": None, "features": None, "playground": False,
            })
            e["playground"] = e["playground"] or is_playground
            e["facilities"] = e["facilities"] or ((r.get("設施") or "").strip() or None)
            e["features"] = e["features"] or ((r.get("特色") or "").strip() or None)
    return {
        "kind": "parks",
        "source": "https://data.gov.tw/dataset/148726",
        "publisher": "桃園市政府工務局",
        "title": "桃園市公園（特色遊戲場、埤塘公園）",
        "entries": sorted(entries.values(), key=lambda e: e["ref"]),
    }


HSINCHU_PLAYGROUNDS_URL = "https://odws.hccg.gov.tw/001/Upload/25/opendataback/9059/571/b02a5f4e-09d4-4b98-bdca-3b47f4ecf7ad.json"
# odws.hccg.gov.tw does not send its intermediate certificate; add it to certifi's roots (still verified).
TWCA_INTERMEDIATE = Path(__file__).parent / "certs" / "twca_ssl_2023.pem"


@lru_cache(maxsize=1)
def _ca_bundle_with_twca() -> str:
    import certifi

    path = Path(tempfile.gettempdir()) / "shadehop-ca-bundle.pem"
    path.write_text(Path(certifi.where()).read_text() + "\n" + TWCA_INTERMEDIATE.read_text())
    return str(path)


def hsinchu_playgrounds(region: dict) -> dict:
    r = requests.get(HSINCHU_PLAYGROUNDS_URL, headers={"User-Agent": UA}, timeout=60, verify=_ca_bundle_with_twca())
    r.raise_for_status()
    entries: dict[str, dict] = {}
    for row in json.loads(r.content.decode("utf-8-sig")):
        name = (row.get("公園") or "").strip()
        if not name:
            continue
        district = (row.get("行政區") or "").strip().removesuffix("公所") or None  # one row says 香山區公所
        facilities = (row.get("設施內容") or "").strip()
        has_equipment = bool(facilities) and facilities != "無"
        ref = f"{district}/{name}"
        e = entries.setdefault(ref, {
            "ref": ref, "name": name, "district": district, "address": None,
            "management": "新竹市政府養護工程處", "phone": None, "lat": None, "lng": None, "equipment": None,
            "facilities": None, "features": None, "playground": False,
        })
        if has_equipment:
            e["facilities"] = "、".join(x for x in (e["facilities"], facilities) if x)
            e["playground"] = True
    return {
        "kind": "parks",
        "source": "https://data.gov.tw/dataset/132713",
        "publisher": "新竹市政府養護工程處",
        "title": "新竹市兒童遊戲場清冊",
        "entries": sorted(entries.values(), key=lambda e: e["ref"]),
    }


FETCHERS = {"ntpc_parks": ntpc_parks, "taipei_playgrounds": taipei_playgrounds, "taoyuan_parks": taoyuan_parks,
            "hsinchu_playgrounds": hsinchu_playgrounds}


def fetch_region(region: dict) -> None:
    path = RAW_DIR / f"{region['id']}.city_parks.json"
    started = datetime.now(timezone.utc)
    try:
        out = FETCHERS[region["registry"]](region)
    except (requests.RequestException, ValueError, KeyError) as e:
        print(f"{region['id']}: city registry not refreshed ({e!r}); keeping {path}", file=sys.stderr)
        return
    if not out["entries"]:
        print(f"{region['id']}: city registry returned no rows; keeping {path}", file=sys.stderr)
        return
    out.update(fetched_at=started.isoformat(timespec="seconds"), license=LICENSE, region=region["id"])
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    print(f"wrote {path} ({len(out['entries'])} entries)")


def main(argv: list[str]) -> None:
    for rid in argv or list(config.REGIONS):
        if config.REGIONS[rid].get("registry"):
            fetch_region(config.REGIONS[rid])


if __name__ == "__main__":
    main(sys.argv[1:])
