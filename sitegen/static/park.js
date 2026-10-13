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
