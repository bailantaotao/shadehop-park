# ShadeHop Park 遮陽公園地圖

幫帶小孩的爸媽找到「**現在去不會曬、下雨也能玩**」的公園，並附上附近停車資訊。

- **A 級 全天候遮蔽**：高架道路下方、有屋頂的遊戲場 —— 下雨也能玩
- **B 級 固定遮陽**：遮陽帆、涼亭、樹冠
- **C 級 建物陰影**：依日期與時間，由周邊大樓 3D 模型 + 太陽角度計算出的遮陰時刻表

資料每個欄位都附出處、驗證方式與驗證日期，並透過 schema.org JSON-LD、`llms.txt`、OpenAPI 與 MCP Server 提供給 AI Agent。

- 設計文件：[docs/DESIGN.md](docs/DESIGN.md)
- 資料格式：[schema/park.schema.json](schema/park.schema.json)
