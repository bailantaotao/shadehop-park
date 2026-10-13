/* Park page: favourite star, share, and the "is now a good time?" card (shade now and today,
   rain chance and UV from Open-Meteo). */
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

  var best = park.best[month];
  document.getElementById("bestToday").innerHTML = best
    ? "最陰涼：<b>" + best.start + "–" + best.end + "</b>（平均遮陰 " + Math.round(best.mean * 100) + "%）"
    : "最陰涼：<span class=\"muted\">這個月沒有明顯的遮陰時段，建議避開中午</span>";

  // Rain chance and UV for the next 3 hours at this park (Open-Meteo, free, no key).
  var url = "https://api.open-meteo.com/v1/forecast?latitude=" + park.lat.toFixed(3) + "&longitude=" + park.lng.toFixed(3) +
    "&hourly=precipitation_probability,uv_index&forecast_hours=3&timezone=Asia%2FTaipei";
  var ctl = window.AbortController ? new AbortController() : null;
  if (ctl) setTimeout(function () { ctl.abort(); }, 8000);  // a slow weather service must not leave dashes forever
  fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { return r.json(); }).then(function (w) {
    var h = w.hourly || {};
    var rain = Math.max.apply(null, h.precipitation_probability || [NaN]);
    var uv = Math.max.apply(null, h.uv_index || [NaN]);
    if (isFinite(rain)) setStat("nowRain", Math.round(rain) + "%", rain >= 60 ? "lo" : rain >= 30 ? "mid" : "");
    if (isFinite(uv)) setStat("nowUv", String(Math.round(uv)), uv >= 8 ? "lo" : uv >= 6 ? "mid" : "");
  }).catch(function () {
    setStat("nowRain", "暫無", ""); setStat("nowUv", "暫無", "");
  });
})();
