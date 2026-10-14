/* Park page: favourite star, share, and the "is now a good time?" card (shade now and today,
   rain chance and UV from 中央氣象署 via our /api/weather, which only gets the district). */
(function () {
  "use strict";
  document.dispatchEvent(new CustomEvent("shadehop:favs"));  // show the saved star state

  // ------------------------------------------------------------- share
  var status = document.getElementById("copyStatus");
  var shareBtn = document.getElementById("shareLink");
  var timer = null;
  function say(msg) {
    status.textContent = msg;
    clearTimeout(timer);
    timer = setTimeout(function () { status.textContent = ""; }, 3000);
  }
  function fallbackCopy(url) {
    // Older browsers / non-https: copy through a temporary text field.
    var t = document.createElement("textarea");
    t.value = url; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(t);
    return ok;
  }
  function copy(url) {
    var done = function (ok) { say(ok ? "已複製連結，可以貼給朋友" : "無法自動複製，請手動複製：" + url); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(fallbackCopy(url)); });
    } else {
      done(fallbackCopy(url));
    }
  }
  if (shareBtn) {
    shareBtn.addEventListener("click", function () {
      var url = shareBtn.dataset.url;
      // Phones: the system share sheet (LINE, Messages...); elsewhere copy the link.
      if (navigator.share) {
        navigator.share({ title: document.title, text: shareBtn.dataset.text, url: url }).catch(function () { /* cancelled */ });
      } else {
        copy(url);
      }
    });
  }

  // ------------------------------------------------- is now a good time?
  var dataEl = document.getElementById("parkData");
  if (!dataEl) return;
  var park = JSON.parse(dataEl.textContent);
  var SLOT_START = 6 * 60, SLOT_MIN = 30;

  // Taipei time regardless of the phone's time zone.
  var now = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
  var month = String(now.getMonth() + 1);
  var row = park.slots[month] || [];
  var idx = Math.floor((now.getHours() * 60 + now.getMinutes() - SLOT_START) / SLOT_MIN);

  // Longest run of >= 60% shade between 08:00 and 17:00 (early-morning shade is not worth planning around).
  function bestDaytime(row) {
    var best = null, start = null, FIRST = 4, LAST = 22;  // slot 4 = 08:00, slot 22 = 17:00
    for (var i = FIRST; i <= LAST; i++) {
      var ok = i < LAST && row[i] !== null && row[i] !== undefined && row[i] >= 0.6;
      if (ok && start === null) start = i;
      if (!ok && start !== null) {
        if (!best || i - start > best.n) best = { from: start, n: i - start };
        start = null;
      }
    }
    if (!best) return null;
    var lab = function (k) { var m = 360 + k * 30; return Math.floor(m / 60) + ":" + (m % 60 ? "30" : "00"); };
    var vals = row.slice(best.from, best.from + best.n);
    return { start: lab(best.from), end: lab(best.from + best.n), mean: vals.reduce(function (a, b) { return a + b; }, 0) / vals.length };
  }

  function cls(v) { return v === null || v === undefined ? "night" : v >= 0.6 ? "hi" : v >= 0.3 ? "mid" : "lo"; }
  function setStat(id, value, kind) {
    var el = document.getElementById(id);
    el.querySelector("b").textContent = value;
    el.className = "pstat" + (kind ? " " + kind : "");
  }

  var v = idx >= 0 && idx < row.length ? row[idx] : null;
  if (v === null) {
    setStat("nowShade", idx < 0 ? "日出前" : "已日落", "night");
    document.getElementById("nowNote").textContent = "現在沒有直射陽光，不用擔心曬。遮陰是依建物、高架與太陽位置推算的估計值。";
  } else {
    setStat("nowShade", Math.round(v * 100) + "%", cls(v));
  }

  document.getElementById("todayBar").innerHTML = row.map(function (x, i) {
    var label = (6 + Math.floor(i / 2)) + ":" + (i % 2 ? "30" : "00") + " " + (x === null ? "無日照" : Math.round(x * 100) + "%");
    return '<span class="' + cls(x) + (i === idx ? " cur" : "") + '" title="' + label + '"></span>';
  }).join("");

  var best = bestDaytime(row);
  document.getElementById("bestToday").innerHTML = best
    ? "白天最陰涼：<b>" + best.start + "–" + best.end + "</b>（平均遮陰 " + Math.round(best.mean * 100) + "%）"
    : "白天最陰涼：<span class=\"muted\">8–17 點沒有明顯的遮陰時段，建議避開中午、多帶帽子</span>";

  // Rain chance (next 3 hours) and today's UV for this park's district, from 中央氣象署.
  var ctl = window.AbortController ? new AbortController() : null;
  if (ctl) setTimeout(function () { ctl.abort(); }, 8000);  // a slow weather service must not leave dashes forever
  fetch(park.weather, ctl ? { signal: ctl.signal } : {}).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (w) {
    if (w.pop !== null) setStat("nowRain", w.pop + "%", w.pop >= 60 ? "lo" : w.pop >= 30 ? "mid" : "");
    else setStat("nowRain", "暫無", "");
    if (w.uv !== null) setStat("nowUv", String(w.uv), w.uv >= 8 ? "lo" : w.uv >= 6 ? "mid" : "");
    else setStat("nowUv", "暫無", "");
  }).catch(function () {
    setStat("nowRain", "暫無", ""); setStat("nowUv", "暫無", "");
  });
})();

/* "Is there a playground here?" - parents' reports. Saved by our /api/reports (counts show at once)
   and, if the parent agrees, sent to OpenStreetMap as a public note so volunteers can map it. */
(function () {
  "use strict";
  var box = document.getElementById("report");
  if (!box) return;
  var parkId = box.dataset.park, tally = document.getElementById("reportTally");
  var root = (document.querySelector('link[rel="manifest"]') || {}).getAttribute
    ? document.querySelector('link[rel="manifest"]').getAttribute("href").replace("manifest.webmanifest", "") : "/";

  function showTally(s) {
    if (!s || (!s.yes && !s.no)) return;
    var parts = [];
    if (s.yes) {
      var eq = Object.keys(s.equipment || {}).sort(function (a, b) { return s.equipment[b] - s.equipment[a]; })
        .map(function (k) { return k + " " + s.equipment[k]; });
      parts.push("👍 " + s.yes + " 位家長回報有遊戲場" + (eq.length ? "（" + eq.join("、") + "）" : ""));
    }
    if (s.no) parts.push("👎 " + s.no + " 位回報沒有");
    tally.textContent = parts.join("；");
  }
  // Same rule as the map: two or more parents, and more of them say yes than no (or the reverse).
  var MIN_REPORTS = 2;
  function showConsensus(s) {
    if (!s) return;
    var note = document.getElementById("parkNote"), item = document.getElementById("reportedEquip");
    if (s.yes >= MIN_REPORTS && s.yes > s.no) {
      if (note) note.textContent = s.yes + " 位家長回報這裡有遊戲場（地圖資料還沒標示，請以現場為準）。";
      var eq = Object.keys(s.equipment || {}).filter(function (k) { return k !== "其他"; })
        .sort(function (a, b) { return s.equipment[b] - s.equipment[a]; });
      if (item && eq.length) {
        var box = item.lastElementChild;
        box.textContent = "家長回報的遊具：";
        eq.forEach(function (k) {
          var tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = k + (s.equipment[k] > 1 ? " " + s.equipment[k] : "");
          box.appendChild(tag);
        });
        item.hidden = false;
        var empty = document.getElementById("infoEmpty");
        if (empty) empty.hidden = true;
      }
    } else if (s.no >= MIN_REPORTS && s.no > s.yes && note) {
      note.textContent = s.no + " 位家長回報這裡沒有遊戲場。";
    }
  }
  fetch(root + "api/reports").then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (all) { showTally(all[parkId]); showConsensus(all[parkId]); }).catch(function () {});

  var form = document.getElementById("reportForm");
  if (!form) return;
  var verdict = null, token = null, sending = false;
  var equip = document.getElementById("reportEquip"), send = document.getElementById("reportSend");
  var status = document.getElementById("reportStatus"), osm = document.getElementById("reportOsm");
  function update() { send.disabled = sending || !verdict || !token; }

  form.querySelectorAll("[data-verdict]").forEach(function (b) {
    b.addEventListener("click", function () {
      verdict = b.dataset.verdict;
      form.querySelectorAll("[data-verdict]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      equip.hidden = verdict !== "yes";
      if (!token) status.textContent = "正在確認你不是機器人…";
      update();
    });
  });

  // Cloudflare Turnstile (loaded with render=explicit; calls this when ready).
  window.shadehopTurnstile = function () {
    window.turnstile.render("#turnstile", {
      sitekey: box.dataset.sitekey, language: "zh-tw", appearance: "interaction-only",
      callback: function (t) { token = t; if (status.textContent.indexOf("機器人") >= 0) status.textContent = ""; update(); },
      "expired-callback": function () { token = null; update(); },
      "error-callback": function () { status.textContent = "人機驗證載入失敗，請重新整理頁面"; },
    });
  };

  function osmNote(items) {
    var text = "ShadeHop 家長回報：這裡有兒童遊戲場" + (items.length ? "（遊具：" + items.join("、") + "）" : "") + "。\n" +
      "公園：" + box.dataset.name + "\n" + box.dataset.url + "\n" +
      "（使用者在 ShadeHop 遮陽公園地圖送出；請志工確認後以 leisure=playground 標示。）";
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {  // never leave test notes on the real map
      console.info("[dev] OSM note not sent:", text);
      return Promise.resolve(null);
    }
    var body = new URLSearchParams({ lat: box.dataset.lat, lon: box.dataset.lng, text: text });
    return fetch("https://api.openstreetmap.org/api/0.6/notes.json", { method: "POST", body: body })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (n) { return n && n.properties ? n.properties.id : null; })
      .catch(function () { return null; });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (send.disabled) return;
    var items = [].map.call(equip.querySelectorAll("input[type=checkbox][value]:checked"), function (c) { return c.value; });
    sending = true; update(); status.textContent = "送出中…";
    fetch(root + "api/reports", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ park_id: parkId, verdict: verdict, equipment: items, token: token }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      if (!res.ok) throw new Error(res.j.error || "送出失敗");
      showTally({ yes: res.j.yes, no: res.j.no, equipment: {} });
      var done = "謝謝你！回報已經送出，其他家長馬上就看得到。";
      if (verdict === "yes" && osm && osm.checked) {
        status.textContent = done + " 正在通知 OpenStreetMap 志工…";
        return osmNote(items).then(function (id) {
          status.innerHTML = done + (id ? ' 已在 OpenStreetMap 留下<a href="https://www.openstreetmap.org/note/' + id + '" target="_blank" rel="noopener">附註 #' + id + "</a>，志工確認後會畫上地圖。" : "");
        });
      }
      status.textContent = done;
    }).catch(function (err) {
      status.textContent = err.message || "送出失敗，請稍後再試";
      sending = false;
      if (window.turnstile) { window.turnstile.reset("#turnstile"); token = null; }
      update();
      return;
    }).then(function () {
      if (status.textContent.indexOf("謝謝") === 0 || status.innerHTML.indexOf("謝謝") === 0) {
        form.querySelectorAll("button, input").forEach(function (x) { x.disabled = true; });
      }
    });
  });
})();
