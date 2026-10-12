# ShadeHop Park 遮陽公園地圖（林口區）

幫帶小孩的爸媽找到「**現在去不會曬、下雨也能玩**」的遊戲場，並附上附近停車場與電動車充電站（**快充 / 慢充**）。

- **A 級 全天候遮蔽**：高架道路/軌道下方、有屋頂 —— 下雨也能玩
- **B 級 部分遮陽**：涼亭、遮雨棚、樹蔭
- **C 級 建物陰影**：依周邊大樓高度 + 太陽位置，逐月逐半小時推算遮陰
- **時間滑桿**：拖動時間，地圖上的公園顏色和**大樓/高架/樹木的陰影**會即時變化；每座公園都標出「最遮陰時段」，可一鍵跳過去
- **停車**：附近停車場、車位數、收費、限高；可選 TDX 即時剩餘車位（MCP）
- **充電**：2 km 內快充（DC：CCS/CHAdeMO/Supercharger）與慢充（AC：Type 1/Type 2）

設計理念見 [docs/DESIGN.md](docs/DESIGN.md)。

## 架構

```
pipeline/fetch_osm.py   Overpass API → data/raw/linkou.osm.json.gz
pipeline/build_data.py  遮蔽判定、陰影時刻表、停車/充電配對 → data/parks/*.json, parks.json, parks.geojson, parks.csv, casters.geojson
sitegen/build_site.py   靜態網站 → public/（地圖、每座公園一頁 + JSON-LD、llms.txt、sitemap、OpenAPI）
mcp_server/server.py    MCP Server，讓 AI Agent 直接查詢
```

## 讓 AI Agent 找得到

| 管道 | 內容 |
|---|---|
| 網頁 | 每座公園一個靜態頁，含 schema.org `Playground` JSON-LD 與純文字摘要 |
| `llms.txt` / `llms-full.txt` | 欄位意義、引用規則、全部公園摘要 |
| `robots.txt` | 明確允許 GPTBot、ClaudeBot、PerplexityBot 等 |
| `openapi.json` + `api/*.json` | 靜態 JSON API |
| MCP Server | `search_parks`、`get_park`、`get_shade_timeline`、`get_nearby_parking`、`get_nearby_chargers` |

每一筆事實都帶 `method`、`verified_at`、`confidence`、`source`；沒有資料就回 `null`，不猜測。

## 本機執行

```bash
pip install -r requirements.txt
python -m pipeline.fetch_osm      # 需要能連 Overpass API
python -m pipeline.build_data
python -m sitegen.build_site && python -m http.server -d public 8000
python -m pytest -q
```

MCP Server（Claude Desktop / Claude Code 設定）：

```json
{ "mcpServers": { "shadehop": { "command": "python", "args": ["-m", "mcp_server.server"], "cwd": "/path/to/shadehop-park" } } }
```

可選環境變數：`SHADEHOP_DATA_URL`（改讀線上 `api/parks.json`）、`TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`（即時車位）、`SITE_URL`。

## 自動化

- `Refresh data`：每週一與 `pipeline/` 有變更時，從 OSM 重新抓資料、重算並提交回分支。
- `Deploy site`：設定 repository variable `PAGES_ENABLED=true`，並在 Settings → Pages 選 GitHub Actions 後部署。

## 資料正確性與限制

- 來源：OpenStreetMap（ODbL）。遮陰為模型推估；建物無高度時以 9m 估計，每頁都會揭露有高度資料的比例。
- 未計入地形與雲量；距離是直線距離。
- **資料有誤請直接修正 OSM**（每頁都有編輯連結），例如補 `covered=yes`、`building:levels`、充電站 `socket:*`，下次更新自動反映。
