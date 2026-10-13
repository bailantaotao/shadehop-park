"""Generate the static site (HTML + machine-readable endpoints) from data/parks.json.

    SITE_URL=https://example.org python -m sitegen.build_site   # writes public/
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import date
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "public"
SITE_URL = (os.environ.get("SITE_URL") or "https://shadehop-park.pages.dev").rstrip("/")

SPEED_LABEL = {"fast": "快充", "slow": "慢充", "both": "快充+慢充", "unknown": "未標示"}
RAIN_LABEL = {True: "可以（有遮蔽）", "partial": "部分區域有遮蔽", False: "不行（未發現遮蔽）"}
CONF_LABEL = {"high": "高", "medium": "中", "low": "低"}
METHOD_LABEL = {
    "site_visit": "實地驗證", "user_report": "使用者回報", "computed": "幾何計算推估",
    "official_data": "政府資料", "satellite": "衛星影像", "osm": "OpenStreetMap 標記",
}
SHADE_TYPE_LABEL = {
    "under_viaduct": "高架道路/軌道下方", "roof": "屋頂/遮雨棚", "pavilion": "涼亭",
    "shade_sail": "遮陽帆", "indoor": "室內場所", "tree_canopy": "樹蔭", "building_shadow": "周邊建物陰影",
}
OFFICIAL_METHOD_LABEL = {"name_match": "依名稱比對", "location_match": "依位置比對", "official_record": "OSM 尚未標示"}
SITE_NAME = "遮陽公園地圖"
SLOT_LABELS = [f"{6 + i // 2:02d}:{'30' if i % 2 else '00'}" for i in range(24)]


def shade_class(v) -> str:
    if v is None:
        return "night"
    if v >= 0.6:
        return "hi"
    if v >= 0.3:
        return "mid"
    return "lo"


def park_jsonld(p: dict, meta: dict) -> dict:
    url = f"{SITE_URL}/parks/{p['id']}/"
    feats = [
        {"@type": "LocationFeatureSpecification", "name": "下雨可玩 (rain cover)", "value": p["rain_cover"]["value"] is True},
        {"@type": "LocationFeatureSpecification", "name": "遮蔽等級 (shade level)", "value": p["level"]},
        {"@type": "LocationFeatureSpecification", "name": "09-16 時遮陰時段比例 (daytime shaded share)", "value": p["daytime_shaded_share"]},
    ]
    if p["amenities"]["toilet"]["value"]:
        feats.append({"@type": "LocationFeatureSpecification", "name": "公廁 200m 內 (public toilet)", "value": True})
    if p["charger_summary"]["nearest_fast_m"] is not None:
        feats.append({"@type": "LocationFeatureSpecification", "name": "最近快充距離 m (nearest DC fast charger)", "value": p["charger_summary"]["nearest_fast_m"]})
    if p["charger_summary"]["nearest_slow_m"] is not None:
        feats.append({"@type": "LocationFeatureSpecification", "name": "最近慢充距離 m (nearest AC charger)", "value": p["charger_summary"]["nearest_slow_m"]})
    ld = {
        "@context": "https://schema.org",
        "@type": "Playground",
        "@id": url,
        "url": url,
        "name": p["name"],
        "identifier": p["id"],
        "description": describe(p),
        "geo": {"@type": "GeoCoordinates", "latitude": p["location"]["lat"], "longitude": p["location"]["lng"]},
        "address": {"@type": "PostalAddress", "addressRegion": p["region"]["city"], "addressLocality": p["region"]["district"], "addressCountry": "TW",
                    **({"streetAddress": addr} if (addr := p["address"] or (p.get("official") or {}).get("address")) else {})},
        "amenityFeature": feats,
        "sameAs": (p["osm"] or {}).get("url") or p["official"]["source"],
        "dateModified": p["updated_at"],
        "isPartOf": {"@type": "Dataset", "name": "ShadeHop 遮陽公園資料集", "url": f"{SITE_URL}/about/"},
    }
    if p["park_name"]:
        ld["containedInPlace"] = {"@type": "Park", "name": p["park_name"]}
    if p["parking"]:
        q = p["parking"][0]
        ld["containsPlace"] = [{"@type": "ParkingFacility", "name": q["name"],
                                "geo": {"@type": "GeoCoordinates", "latitude": q["location"]["lat"], "longitude": q["location"]["lng"]}}]
    return ld


def describe(p: dict) -> str:
    """One-paragraph factual description, used in pages, JSON-LD and llms-full.txt."""
    parts = [f"{p['name']}位於{p['region']['city']}{p['region']['district']}。"]
    r = p["rain_cover"]
    if r["value"] is True:
        parts.append(f"約 {int(r['covered_ratio'] * 100)}% 範圍在高架或屋頂下方，下雨也能玩（{METHOD_LABEL[r['method']]}，{r['verified_at']}）。")
    elif r["value"] == "partial":
        parts.append(f"約 {int(r['covered_ratio'] * 100)}% 範圍有遮蔽，下雨時僅部分可玩。")
    else:
        parts.append("未發現高架或屋頂遮蔽，下雨不適合。")
    parts.append(f"推估 09–16 時約 {int(p['daytime_shaded_share'] * 100)}% 時段有遮陰（全年平均，模型推估）。")
    if p["parking"]:
        q = p["parking"][0]
        parts.append(f"最近停車場：{q['name']}，直線約 {q['distance_m']} 公尺。")
    cs = p["charger_summary"]
    if cs["nearest_fast_m"] is not None:
        parts.append(f"最近快充（DC）充電站直線約 {cs['nearest_fast_m']} 公尺。")
    if cs["nearest_slow_m"] is not None:
        parts.append(f"最近慢充（AC）充電站直線約 {cs['nearest_slow_m']} 公尺。")
    if cs["total"] == 0:
        parts.append(f"{cs['radius_m']} 公尺內 OSM 未標示充電站。")
    parts.append(f"資料更新：{p['updated_at']}。")
    return "".join(parts)


def openapi(meta: dict) -> dict:
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "ShadeHop Park API",
            "version": "1.0.0",
            "description": f"{meta['coverage']}遮陽/避雨公園、附近停車場與電動車充電站（快充/慢充）。靜態 JSON，每筆事實都附 method/verified_at/confidence/source。",
            "license": {"name": "ODbL-1.0", "url": "https://opendatacommons.org/licenses/odbl/1-0/"},
        },
        "servers": [{"url": SITE_URL}],
        "paths": {
            "/api/parks.json": {"get": {"operationId": "listParks", "summary": "全部公園（完整資料）",
                                        "responses": {"200": {"description": "{meta, parks[]}", "content": {"application/json": {}}}}}},
            "/api/parks.geojson": {"get": {"operationId": "listParksGeoJSON", "summary": "全部公園（GeoJSON 摘要，含遮陰時刻表）",
                                           "responses": {"200": {"description": "FeatureCollection", "content": {"application/geo+json": {}}}}}},
            "/api/parks/{id}.json": {"get": {
                "operationId": "getPark", "summary": "單一公園完整資料",
                "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "string", "example": "lk-w123456"}}],
                "responses": {"200": {"description": "Park", "content": {"application/json": {"schema": {"$ref": f"{SITE_URL}/schema/park.schema.json"}}}},
                              "404": {"description": "Not found"}}}},
            "/api/regions/index.json": {"get": {"operationId": "listRegions", "summary": "地區清單（id、名稱、範圍、公園數）",
                                                "responses": {"200": {"description": "regions[]", "content": {"application/json": {}}}}}},
            "/api/regions/{region}.geojson": {"get": {
                "operationId": "listRegionParksGeoJSON", "summary": "單一地區的公園（GeoJSON 摘要）",
                "parameters": [{"name": "region", "in": "path", "required": True, "schema": {"type": "string", "enum": meta["region_ids"]}}],
                "responses": {"200": {"description": "FeatureCollection", "content": {"application/geo+json": {}}}}}},
            "/api/meta.json": {"get": {"operationId": "getMeta", "summary": "資料集版本、計數與模型假設",
                                       "responses": {"200": {"description": "meta", "content": {"application/json": {}}}}}},
        },
    }


def build(out: Path = OUT) -> None:
    payload = json.loads((DATA / "parks.json").read_text())
    meta, parks = payload["meta"], payload["parks"]
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    env = Environment(loader=FileSystemLoader(ROOT / "sitegen" / "templates"), autoescape=select_autoescape(["html"]))
    env.filters["shade_class"] = shade_class
    # Fingerprint static files (?v=<content hash>) so browsers never pair a new page with an old
    # cached script or stylesheet - some mobile and in-app browsers keep stale copies.
    def asset(path: str) -> str:
        digest = hashlib.sha256((ROOT / "sitegen" / path).read_bytes()).hexdigest()[:10]
        return f"{path}?v={digest}"
    env.globals["asset"] = asset
    env.filters["tojson_ld"] = lambda d: json.dumps(d, ensure_ascii=False, indent=1).replace("</", "<\\/")
    regions = [meta["regions"][rid]["region"] for rid in meta["region_ids"]]
    publishers = [r["city_registry"]["publisher"] for r in meta["regions"].values() if r.get("city_registry")]
    ctx = {
        "site_url": SITE_URL, "meta": meta, "today": date.today().isoformat(), "regions": regions,
        "SITE_NAME": SITE_NAME, "COVERAGE_SHORT": "・".join(r["label"] for r in regions),
        "REGISTRY_PUBLISHERS": "、".join(dict.fromkeys(publishers)) or "政府", "OFFICIAL_METHOD_LABEL": OFFICIAL_METHOD_LABEL,
        "SPEED_LABEL": SPEED_LABEL, "RAIN_LABEL": RAIN_LABEL, "CONF_LABEL": CONF_LABEL,
        "METHOD_LABEL": METHOD_LABEL, "SHADE_TYPE_LABEL": SHADE_TYPE_LABEL, "SLOT_LABELS": SLOT_LABELS,
    }

    shutil.copytree(ROOT / "sitegen" / "static", out / "static")
    (out / "api" / "parks").mkdir(parents=True)
    (out / "schema").mkdir()
    shutil.copy(ROOT / "schema" / "park.schema.json", out / "schema" / "park.schema.json")
    shutil.copy(DATA / "parks.json", out / "api" / "parks.json")
    shutil.copy(DATA / "parks.geojson", out / "api" / "parks.geojson")
    shutil.copy(DATA / "meta.json", out / "api" / "meta.json")
    shutil.copy(DATA / "parks.csv", out / "api" / "parks.csv")
    shutil.copytree(DATA / "regions", out / "api" / "regions")
    if (DATA / "chargers.geojson").exists():
        shutil.copy(DATA / "chargers.geojson", out / "api" / "chargers.geojson")
    if (DATA / "casters").exists():
        shutil.copytree(DATA / "casters", out / "api" / "casters")
    for p in parks:
        shutil.copy(DATA / "parks" / f"{p['id']}.json", out / "api" / "parks" / f"{p['id']}.json")

    dataset_ld = {
        "@context": "https://schema.org",
        "@type": "Dataset",
        "name": f"ShadeHop 遮陽公園資料集（{meta['coverage']}）",
        "description": f"{meta['coverage']}兒童遊戲場的遮陽/避雨分級、逐月逐半小時遮陰推估、附近停車場與電動車充電站（快充/慢充）。",
        "url": f"{SITE_URL}/about/",
        "license": "https://opendatacommons.org/licenses/odbl/1-0/",
        "isAccessibleForFree": True,
        "dateModified": (meta.get("generated_from_osm_base") or "")[:10],
        "spatialCoverage": [{"@type": "Place", "name": r["city"] + (r["name"] if r["name"] != r["city"] else "")} for r in regions],
        "creditText": "© OpenStreetMap contributors; " + "、".join(dict.fromkeys(publishers)) + "（政府資料開放授權條款）",
        "distribution": [
            {"@type": "DataDownload", "encodingFormat": "application/geo+json", "contentUrl": f"{SITE_URL}/api/parks.geojson"},
            {"@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": f"{SITE_URL}/api/parks.json"},
            {"@type": "DataDownload", "encodingFormat": "text/csv", "contentUrl": f"{SITE_URL}/api/parks.csv"},
        ],
    }

    def render(tpl: str, path: str, **kw) -> None:
        dest = out / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        depth = path.count("/")
        dest.write_text(env.get_template(tpl).render(**ctx, root="../" * depth or "./", **kw))

    render("index.html", "index.html", parks=parks, dataset_ld=dataset_ld)
    render("about.html", "about/index.html", dataset_ld=dataset_ld)
    for p in parks:
        render("park.html", f"parks/{p['id']}/index.html", p=p, ld=park_jsonld(p, meta), description=describe(p))

    (out / "llms.txt").write_text(env.get_template("llms.txt").render(**ctx, parks=parks))
    (out / "llms-full.txt").write_text(env.get_template("llms-full.txt").render(**ctx, parks=parks, describe=describe))
    (out / "openapi.json").write_text(json.dumps(openapi(meta), ensure_ascii=False, indent=1))
    (out / "robots.txt").write_text(
        "User-agent: *\nAllow: /\n\n"
        + "".join(f"User-agent: {a}\nAllow: /\n\n" for a in ("GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"))
        + f"Sitemap: {SITE_URL}/sitemap.xml\n"
    )
    urls = ["/", "/about/", "/llms.txt", "/llms-full.txt"] + [f"/parks/{p['id']}/" for p in parks]
    lastmod = (meta.get("generated_from_osm_base") or date.today().isoformat())[:10]
    (out / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{SITE_URL}{u}</loc><lastmod>{lastmod}</lastmod></url>\n" for u in urls)
        + "</urlset>\n"
    )
    (out / ".nojekyll").write_text("")
    # Cloudflare Pages headers: let browser-based agents fetch the JSON, and serve
    # GeoJSON / llms.txt with explicit types.
    (out / "_headers").write_text(
        "/api/*\n  Access-Control-Allow-Origin: *\n\n"
        "/openapi.json\n  Access-Control-Allow-Origin: *\n\n"
        "/api/*.geojson\n  Content-Type: application/geo+json; charset=utf-8\n\n"
        "/llms.txt\n  Content-Type: text/plain; charset=utf-8\n\n"
        "/llms-full.txt\n  Content-Type: text/plain; charset=utf-8\n"
    )
    print(f"built {len(parks)} park pages into {out}")


if __name__ == "__main__":
    build()
