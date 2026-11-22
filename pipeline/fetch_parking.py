"""Download official off-street car parks, to give the OpenStreetMap lots their real names, fees and hours.

    python -m pipeline.fetch_parking            # all regions -> data/raw/<region>.official_parking.json

OSM often tags a lot only as 平面停車場, or with a description instead of the name on its sign. The
cities publish their registered lots:
  - 臺北市: 停車管理工程處「臺北市停車場資訊」(public and private lots), no key
  - 新北市: 交通局「新北市路外公共停車場資訊」(lots holding a parking licence), no key
  - 桃園市、新竹市、新竹縣: 交通部 TDX OffStreet CarPark (TDX key, see fetch_chargers)
TDX returns nothing for Taipei and New Taipei, hence their own feeds. A failed source keeps the
previous file, so a refresh is never blocked. All under 政府資料開放授權條款第1版.
"""

from __future__ import annotations

import csv
import io
import json
import sys
from datetime import datetime, timezone

import requests
from pyproj import Transformer

from . import config
from .fetch_chargers import _get, _text, credentials, token
from .fetch_osm import RAW_DIR, UA

TAIPEI = "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json"
NEWTAIPEI = "https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/csv/file?size=10000"
SOURCES = {
    "taipei": {"name": "臺北市停車管理工程處 臺北市停車場資訊", "url": "https://data.taipei/"},
    "newtaipei": {"name": "新北市政府交通局 新北市路外公共停車場資訊", "url": "https://data.gov.tw/dataset/122955"},
    "tdx": {"name": "交通部 TDX 路外停車場基本資料", "url": "https://tdx.transportdata.tw/"},
}
LICENSE = "政府資料開放授權條款第1版（相容 CC BY 4.0）"
_TWD97 = Transformer.from_crs(3826, 4326, always_xy=True)


def _lot(name, lng, lat, **kw) -> dict | None:
    name = (name or "").strip()
    try:
        lng, lat = float(lng), float(lat)
    except (TypeError, ValueError):
        return None
    # Northern Taiwan only: some rows carry blank or garbage coordinates (projected to infinity).
    if not name or not (24.0 < lat < 25.6 and 120.5 < lng < 122.2):
        return None
    out = {"name": name, "lat": round(float(lat), 6), "lng": round(float(lng), 6)}
    out.update({k: (v.strip() if isinstance(v, str) else v) for k, v in kw.items() if v not in (None, "", 0)})
    return out


def _twd97(x, y):
    try:
        return _TWD97.transform(float(x), float(y))
    except (TypeError, ValueError):
        return None, None


def fetch_taipei() -> list[dict]:
    r = requests.get(TAIPEI, headers={"User-Agent": UA}, timeout=120)
    r.raise_for_status()
    lots = []
    for p in json.loads(r.content.decode("utf-8-sig"))["data"]["park"]:
        lng, lat = _twd97(p.get("tw97x"), p.get("tw97y"))
        lots.append(_lot(p.get("name"), lng, lat, address=p.get("address"), fare=p.get("payex"),
                         hours=p.get("serviceTime"), cars=_int(p.get("totalcar")), kind=p.get("type2"), source="taipei"))
    return [x for x in lots if x]


def fetch_newtaipei() -> list[dict]:
    r = requests.get(NEWTAIPEI, headers={"User-Agent": UA}, timeout=120)
    r.raise_for_status()
    lots = []
    for p in csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))):
        lng, lat = _twd97(p.get("TW97X"), p.get("TW97Y"))
        lots.append(_lot(p.get("NAME"), lng, lat, address=p.get("ADDRESS"), fare=p.get("PAYEX"),
                         hours=p.get("SERVICETIME"), cars=_int(p.get("TOTALCAR")), source="newtaipei"))
    return [x for x in lots if x]


def fetch_tdx(city: str, tok: str) -> list[dict]:
    data = _get_parking(f"CarPark/City/{city}", tok)
    lots = []
    for c in data.get("CarParks") or []:
        pos = c.get("CarParkPosition") or {}
        lots.append(_lot(_text(c.get("CarParkName")), pos.get("PositionLon"), pos.get("PositionLat"),
                         address=_text(c.get("Address")), fare=_text(c.get("FareDescription")),
                         note=_text(c.get("Description")), source="tdx"))
    return [x for x in lots if x]


def _get_parking(path: str, tok: str) -> dict:
    import pipeline.fetch_chargers as fc
    saved = fc.API
    fc.API = "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet"
    try:
        return _get(path, tok)
    finally:
        fc.API = saved


def _int(v):
    try:
        return int(float(v)) or None
    except (TypeError, ValueError):
        return None


def main(argv: list[str]) -> None:
    region_ids = argv or list(config.REGIONS)
    creds, tok = credentials(), None
    for rid in region_ids:
        try:
            if rid == "taipei":
                lots, src = fetch_taipei(), ["taipei"]
            elif rid == "newtaipei":
                lots, src = fetch_newtaipei(), ["newtaipei"]
            else:
                if not creds:
                    print(f"{rid}: no TDX key, keeping the previous file", file=sys.stderr)
                    continue
                tok = tok or token(*creds)
                lots, src = fetch_tdx(config.REGIONS[rid]["tdx_city"], tok), ["tdx"]
        except (requests.RequestException, KeyError, ValueError) as e:
            print(f"{rid}: official parking unavailable ({e}), keeping the previous file", file=sys.stderr)
            continue
        out = RAW_DIR / f"{rid}.official_parking.json"
        out.write_text(json.dumps({
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sources": [SOURCES[s] for s in src], "license": LICENSE, "lots": lots,
        }, ensure_ascii=False, separators=(",", ":")))
        print(f"{rid}: {len(lots)} official car parks -> {out.name}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
