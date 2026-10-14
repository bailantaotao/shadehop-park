/* Parents' reports: "is there a playground here?" (a Cloudflare Pages Function with a D1 database).

   GET  /api/reports  -> {"nt-w123": {"yes": 2, "no": 0, "equipment": {"溜滑梯": 2}}, ...}
   POST /api/reports  {"park_id", "verdict": "yes"|"no", "equipment": [...], "token": <Turnstile>}

   Bindings: REPORTS (D1), TURNSTILE_SECRET and REPORT_SALT (secrets). Abuse limits: a Turnstile
   check per report; one report per person per park (the latest counts); at most DAILY_MAX a day.
   People are told apart only by SHA-256(salt + IP) - no IP is stored - and rows older than
   KEEP_DAYS are deleted. Wrong reports can be removed in the Cloudflare D1 console
   (UPDATE reports SET hidden = 1 WHERE ...).
*/

const EQUIPMENT = ["溜滑梯", "鞦韆", "攀爬架", "沙坑", "搖搖馬", "翹翹板", "戲水區", "體健設施", "其他"];
const DAILY_MAX = 20;
const KEEP_DAYS = 180;
const SUMMARY_CACHE_S = 300;
const ID = /^[a-z]{2,4}-[nwro][0-9]{1,20}$/;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
});

let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS reports (
      park_id TEXT NOT NULL, voter TEXT NOT NULL, verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'no')),
      equipment TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (park_id, voter))`),
    db.prepare("CREATE INDEX IF NOT EXISTS reports_voter_time ON reports (voter, created_at)"),
  ]);
  ready = true;
}

function summaryKey(request) { return new Request(new URL("/api/reports?summary", request.url).toString()); }

export async function onRequestGet({ request, env }) {
  if (!env.REPORTS) return json({}, 200, { "cache-control": "public, max-age=60" });
  const cache = caches.default, key = summaryKey(request);
  const hit = await cache.match(key);
  if (hit) return hit;
  await init(env.REPORTS);
  const { results } = await env.REPORTS.prepare(
    "SELECT park_id, verdict, equipment FROM reports WHERE hidden = 0").all();
  const out = {};
  for (const r of results) {
    const s = out[r.park_id] || (out[r.park_id] = { yes: 0, no: 0, equipment: {} });
    s[r.verdict] += 1;
    if (r.verdict === "yes") {
      for (const e of JSON.parse(r.equipment || "[]")) s.equipment[e] = (s.equipment[e] || 0) + 1;
    }
  }
  const res = json(out, 200, { "cache-control": `public, max-age=${SUMMARY_CACHE_S}` });
  await cache.put(key, res.clone());
  return res;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  if (!env.REPORTS || !env.TURNSTILE_SECRET || !env.REPORT_SALT) return json({ error: "回報功能尚未開放" }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "格式錯誤" }, 400); }
  const parkId = String(body.park_id || ""), verdict = body.verdict;
  if (!ID.test(parkId) || !["yes", "no"].includes(verdict)) return json({ error: "格式錯誤" }, 400);
  const equipment = verdict === "yes" && Array.isArray(body.equipment)
    ? [...new Set(body.equipment.filter((e) => EQUIPMENT.includes(e)))] : [];

  // A real park on this site?
  // (Pages answers unknown paths with the home page, so check that a park record really came back.)
  const park = await env.ASSETS.fetch(new URL(`/api/parks/${parkId}.json`, request.url));
  const record = park.ok && (park.headers.get("content-type") || "").includes("json") ? await park.json().catch(() => null) : null;
  if (!record || record.id !== parkId) return json({ error: "找不到這座公園" }, 404);

  // Turnstile: is this a person?
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", String(body.token || ""));
  if (ip) form.append("remoteip", ip);
  const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
    .then((r) => r.json()).catch(() => ({ success: false }));
  if (!check.success) return json({ error: "人機驗證沒有通過，請重新整理後再試一次" }, 403);

  const db = env.REPORTS;
  await init(db);
  const voter = await sha256(env.REPORT_SALT + "|" + ip);
  const now = new Date();
  const dayAgo = new Date(now - 86400000).toISOString();
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE voter = ? AND created_at > ?").bind(voter, dayAgo).first();
  if (n >= DAILY_MAX) return json({ error: "今天回報的次數已達上限，謝謝你的幫忙！明天再來" }, 429);

  const cutoff = new Date(now - KEEP_DAYS * 86400000).toISOString();
  await db.batch([
    // One report per person per park: the latest replaces the earlier one.
    db.prepare(`INSERT INTO reports (park_id, voter, verdict, equipment, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (park_id, voter) DO UPDATE SET verdict = excluded.verdict, equipment = excluded.equipment,
                created_at = excluded.created_at`).bind(parkId, voter, verdict, JSON.stringify(equipment), now.toISOString()),
    db.prepare("DELETE FROM reports WHERE created_at < ?").bind(cutoff),
  ]);
  await caches.default.delete(summaryKey(request));
  const s = await db.prepare(
    "SELECT SUM(verdict = 'yes') AS yes, SUM(verdict = 'no') AS no FROM reports WHERE park_id = ? AND hidden = 0").bind(parkId).first();
  return json({ ok: true, yes: s.yes || 0, no: s.no || 0 });
}
