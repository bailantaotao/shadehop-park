/* Weather for one district from 中央氣象署 (CWA) open data, for the map and park pages.

   GET /api/weather?city=臺北市&district=文山區
   -> {"pop": 20, "uv": 7, "weather": "多雲短暫陣雨", "feels_like": 31, "issued": "...", "source": "中央氣象署"}

   A Cloudflare Pages Function, so the CWA key (env CWA_API_KEY, a Pages secret) never reaches
   browsers. Pages only send a district name, not coordinates. Upstream answers are cached for
   30 minutes per district (CWA issues these forecasts 4 times a day).

   Data: 鄉鎮天氣預報 F-D0047 (3-day: 3-hourly rain chance, feels-like temperature, weather;
   weekly: UV index). 政府資料開放授權條款第1版; credit 「中央氣象署」.
*/

// [3-day dataset, weekly dataset] per city.
const DATASETS = {
  "臺北市": ["F-D0047-061", "F-D0047-063"],
  "新北市": ["F-D0047-069", "F-D0047-071"],
  "桃園市": ["F-D0047-005", "F-D0047-007"],
  "新竹縣": ["F-D0047-009", "F-D0047-011"],
  "新竹市": ["F-D0047-053", "F-D0047-055"],
};
const API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/";
const CACHE_S = 1800;

const json = (body, status = 200, maxAge = 600) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
});

async function cwa(dataset, district, elements, key, ctx) {
  const url = `${API}${dataset}?LocationName=${encodeURIComponent(district)}&ElementName=${encodeURIComponent(elements.join(","))}`;
  const cache = caches.default;
  const cacheKey = new Request(url);  // the key is a header, so it is not part of the cache key
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(url, { headers: { Authorization: key, Accept: "application/json" } });
    if (!res.ok) throw new Error(`CWA ${dataset} HTTP ${res.status}`);
    res = new Response(res.body, res);
    res.headers.set("cache-control", `public, max-age=${CACHE_S}`);
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res.json();
}

// The location's weather elements as {name: [{start, end, value: {...}}]}, tolerating the field-name
// casing differences between CWA's old and new formats.
function elements(data) {
  const r = data.records || {};
  const locs = r.Locations || r.locations || [];
  const loc = ((locs[0] || {}).Location || (locs[0] || {}).location || [])[0] || {};
  const out = {};
  for (const e of loc.WeatherElement || loc.weatherElement || []) {
    const name = e.ElementName || e.elementName;
    out[name] = (e.Time || e.time || []).map((t) => ({
      start: new Date(t.StartTime || t.startTime || t.DataTime || t.dataTime),
      end: new Date(t.EndTime || t.endTime || t.DataTime || t.dataTime),
      value: (t.ElementValue || t.elementValue || [])[0] || {},
    }));
  }
  return out;
}

const firstNumber = (v) => {
  for (const x of Object.values(v)) {
    const n = Number(x);
    if (x !== "" && x !== null && Number.isFinite(n)) return n;
  }
  return null;
};

export async function onRequestGet({ request, env, waitUntil }) {
  const q = new URL(request.url).searchParams;
  const city = q.get("city"), district = q.get("district");
  const ds = DATASETS[city];
  if (!ds || !district || district.length > 10) return json({ error: "unknown city or district" }, 400, 3600);
  if (!env.CWA_API_KEY) return json({ error: "weather not configured" }, 503, 300);
  const ctx = { waitUntil };
  try {
    const [short, week] = await Promise.all([
      cwa(ds[0], district, ["3小時降雨機率", "體感溫度", "天氣現象"], env.CWA_API_KEY, ctx),
      cwa(ds[1], district, ["紫外線指數"], env.CWA_API_KEY, ctx),
    ]);
    const now = Date.now(), soon = now + 3 * 3600 * 1000;
    const s = elements(short), w = elements(week);
    // Next 3 hours: the slots that overlap [now, now + 3h].
    const next = (rows) => (rows || []).filter((t) => t.end > now && t.start < soon);
    const pops = next(s["3小時降雨機率"]).map((t) => firstNumber(t.value)).filter((n) => n !== null);
    const feels = next(s["體感溫度"]).map((t) => firstNumber(t.value)).filter((n) => n !== null);
    const wx = next(s["天氣現象"])[0];
    // UV is a daytime value in the weekly forecast: today's daytime slot, or the next one.
    const uvRow = (w["紫外線指數"] || []).find((t) => t.end > now);
    return json({
      pop: pops.length ? Math.max(...pops) : null,
      feels_like: feels.length ? Math.max(...feels) : null,
      weather: wx ? (wx.value.Weather || wx.value.weather || null) : null,
      uv: uvRow ? firstNumber(uvRow.value) : null,
      source: "中央氣象署",
    });
  } catch (e) {
    return json({ error: "weather unavailable" }, 502, 120);
  }
}
