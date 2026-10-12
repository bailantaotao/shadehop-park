(function () {
  "use strict";

  var SLOT_START = 6 * 60, SLOT_MIN = 30, SLOTS = 24, TZ = 8;
  var SHADOW_MIN_ZOOM = 16, MAX_SHADOW_M = 600;
  var filters = { rain: false, shade: false, parking: false, fast: false, slow: false, toilet: false };
  var state = { date: null, slot: 8, user: null, features: [], casters: null, playTimer: null };

  var $ = function (s) { return document.querySelector(s); };
  var css = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };

  function slotLabel(i) {
    var m = SLOT_START + i * SLOT_MIN;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  function taipeiNow() {
    var d = new Date(Date.now() + TZ * 3600000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  function month() { return Number(state.date.slice(5, 7)); }
  function slotDate() {
    // Middle of the selected slot, Asia/Taipei.
    var p = state.date.split("-").map(Number);
    var mins = SLOT_START + state.slot * SLOT_MIN + SLOT_MIN / 2;
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 0, mins) - TZ * 3600000);
  }
  function shadeAt(f) {
    var row = f.properties.timetable[String(month())];
    return row ? row[state.slot] : null;
  }
  function shadeClass(v) { return v === null || v === undefined ? "night" : v >= 0.6 ? "hi" : v >= 0.3 ? "mid" : "lo"; }
  function distM(a, b) {
    var r = Math.PI / 180, dl = (b[0] - a[0]) * r, dp = (b[1] - a[1]) * r;
    var h = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dl / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  }

  // ------------------------------------------------------------------ map
  var map = L.map("map", { zoomControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  var shadowLayer = L.layerGroup().addTo(map);
  var markerLayer = L.layerGroup().addTo(map);
  var markers = {};

  function passes(f) {
    var p = f.properties;
    if (filters.rain && p.rain !== true) return false;
    if (filters.shade && !(p.rain === true || (shadeAt(f) || 0) >= 0.6)) return false;
    if (filters.parking && !(p.parking_nearest_m !== null && p.parking_nearest_m <= 300)) return false;
    if (filters.fast && p.fast_nearest_m === null) return false;
    if (filters.slow && p.slow_nearest_m === null) return false;
    if (filters.toilet && !p.toilet) return false;
    return true;
  }

  function popupHtml(f) {
    var p = f.properties, v = shadeAt(f);
    return "<strong>" + esc(p.name) + "</strong><br>" +
      (p.rain === true ? "☔ 下雨可玩<br>" : "") +
      slotLabel(state.slot) + " 遮陰：" + (v === null ? "無日照" : Math.round(v * 100) + "%") +
      '<br><a href="parks/' + encodeURIComponent(p.id) + '/">詳細資料 →</a>';
  }

  function drawMarkers() {
    markerLayer.clearLayers();
    markers = {};
    state.features.forEach(function (f) {
      if (!passes(f)) return;
      var p = f.properties, cls = shadeClass(shadeAt(f));
      var m = L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        radius: p.rain === true ? 10 : 8,
        color: p.rain === true ? css("--a") : css("--surface"),
        weight: p.rain === true ? 4 : 2,
        fillColor: css("--" + cls),
        fillOpacity: cls === "night" ? 0.5 : 0.95,
      });
      m.bindPopup(function () { return popupHtml(f); });
      m.addTo(markerLayer);
      markers[p.id] = m;
    });
  }

  // ---------------------------------------------------------- live shadows
  function hull(pts) {
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cross = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    var lo = [], up = [];
    pts.forEach(function (p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); });
    for (var i = pts.length - 1; i >= 0; i--) { var p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  function drawShadows() {
    shadowLayer.clearLayers();
    if (!state.casters || map.getZoom() < SHADOW_MIN_ZOOM) return;
    var c = map.getCenter();
    var sun = sunPosition(slotDate(), c.lat, c.lng);
    if (sun.altitude <= 0) return;
    var k = 1 / Math.tan(sun.altitude * Math.PI / 180);
    var ux = -Math.sin(sun.azimuth * Math.PI / 180) * k, uy = -Math.cos(sun.azimuth * Math.PI / 180) * k;
    var mPerLng = 111320 * Math.cos(c.lat * Math.PI / 180), mPerLat = 110574;
    var view = map.getBounds().pad(0.3);
    var polys = [];
    state.casters.features.forEach(function (f) {
      var ring = f.geometry.coordinates[0];
      var first = ring[0];
      if (!view.contains([first[1], first[0]])) return;
      var z0 = f.properties.z0, z1 = f.properties.z1;
      var l0 = Math.min(z0 * k, MAX_SHADOW_M), l1 = Math.min(z1 * k, MAX_SHADOW_M);
      var pts = [];
      ring.forEach(function (q) {
        pts.push([q[0] + ux / k * l0 / mPerLng, q[1] + uy / k * l0 / mPerLat]);
        pts.push([q[0] + ux / k * l1 / mPerLng, q[1] + uy / k * l1 / mPerLat]);
      });
      polys.push(hull(pts).map(function (q) { return [q[1], q[0]]; }));
    });
    if (polys.length) {
      L.polygon(polys, { stroke: false, fillColor: "#1e283c", fillOpacity: 0.32, interactive: false }).addTo(shadowLayer);
    }
  }

  function loadCasters() {
    if (state.casters !== null || map.getZoom() < SHADOW_MIN_ZOOM) return drawShadows();
    state.casters = { features: [] };
    fetch("api/casters.geojson").then(function (r) { return r.ok ? r.json() : { features: [] }; })
      .then(function (gj) { state.casters = gj; drawShadows(); })
      .catch(function () { state.casters = { features: [] }; });
  }

  // ------------------------------------------------------------------ list
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function card(f) {
    var p = f.properties, v = shadeAt(f), row = p.timetable[String(month())] || [];
    var best = p.best && p.best[String(month())];
    var cells = row.map(function (x, i) {
      return '<span class="' + shadeClass(x) + (i === state.slot ? " cur" : "") + '" title="' + slotLabel(i) + " " + (x === null ? "無日照" : Math.round(x * 100) + "%") + '"></span>';
    }).join("");
    var dist = state.user ? " · 距離你 " + (distM(state.user, f.geometry.coordinates) / 1000).toFixed(1) + " km" : "";
    var levelBadge = { A: '<span class="badge A">☔ 下雨可玩</span>', B: '<span class="badge">部分遮陽/樹蔭</span>', C: '<span class="badge">大樓陰影</span>', none: '<span class="badge">大多曝曬</span>' }[p.level];
    return '<article class="card"><h3><a href="parks/' + encodeURIComponent(p.id) + '/">' + esc(p.name) + "</a></h3>" +
      '<div class="badges">' + levelBadge + (p.kind === "park" ? '<span class="badge">遊戲設施待確認</span>' : "") + '<span class="badge">' + slotLabel(state.slot) + " 遮陰 " + (v === null ? "—" : Math.round(v * 100) + "%") + "</span></div>" +
      '<div class="timeline" aria-label="' + month() + ' 月遮陰時間軸">' + cells + '</div><div class="tl-axis"><span>06</span><span>12</span><span>18</span></div>' +
      '<div class="facts">' +
      (best ? '<span>最遮陰：' + best.start + "–" + best.end + ' <button class="link" data-jump="' + best.start_slot + '">跳到這個時間</button></span>' : "<span>本月沒有明顯遮陰時段</span>") +
      "<span>🅿️ " + (p.parking_name ? esc(p.parking_name) + " " + p.parking_nearest_m + "m" : "800m 內未標示停車場") + "</span>" +
      "<span>⚡ 快充 " + (p.fast_nearest_m !== null ? p.fast_nearest_m + "m" : "2km 內無") + " · 🔌 慢充 " + (p.slow_nearest_m !== null ? p.slow_nearest_m + "m" : "2km 內無") + "</span>" +
      '<span class="small">' + dist.replace(/^ · /, "") + "</span>" +
      '</div><button class="link" data-focus="' + esc(p.id) + '">在地圖上看</button></article>';
  }

  function drawList() {
    var fs = state.features.filter(passes);
    fs.sort(function (a, b) {
      if (state.user) return distM(state.user, a.geometry.coordinates) - distM(state.user, b.geometry.coordinates);
      var ra = a.properties.rain === true ? 1 : 0, rb = b.properties.rain === true ? 1 : 0;
      return rb - ra || (shadeAt(b) || 0) - (shadeAt(a) || 0);
    });
    $("#count").textContent = "公園（" + fs.length + " / " + state.features.length + "）· " + month() + " 月 " + slotLabel(state.slot);
    $("#list").innerHTML = fs.map(card).join("") || '<p class="muted">沒有符合條件的公園，試著取消一些篩選。</p>';
  }

  function render() {
    $("#slotOut").textContent = slotLabel(state.slot);
    drawMarkers();
    drawShadows();
    drawList();
  }

  // -------------------------------------------------------------- controls
  function setNow() {
    var t = taipeiNow();
    state.date = t.y + "-" + String(t.m).padStart(2, "0") + "-" + String(t.d).padStart(2, "0");
    state.slot = Math.max(0, Math.min(SLOTS - 1, Math.floor((t.min - SLOT_START) / SLOT_MIN)));
    $("#date").value = state.date;
    $("#slot").value = state.slot;
  }

  $("#slot").addEventListener("input", function (e) { state.slot = Number(e.target.value); render(); });
  $("#date").addEventListener("change", function (e) { if (e.target.value) { state.date = e.target.value; render(); } });
  $("#nowBtn").addEventListener("click", function () { setNow(); render(); });
  $("#playBtn").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; btn.setAttribute("aria-pressed", "false"); btn.textContent = "▶ 播放一天"; return; }
    btn.setAttribute("aria-pressed", "true"); btn.textContent = "⏸ 暫停";
    state.playTimer = setInterval(function () {
      state.slot = (state.slot + 1) % SLOTS; $("#slot").value = state.slot; render();
    }, 700);
  });
  document.querySelectorAll("[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.dataset.filter; filters[k] = !filters[k];
      b.setAttribute("aria-pressed", String(filters[k])); render();
    });
  });
  $("#locBtn").addEventListener("click", function () {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.user = [pos.coords.longitude, pos.coords.latitude];
      L.circleMarker([pos.coords.latitude, pos.coords.longitude], { radius: 6, color: css("--text"), fillOpacity: 1 }).addTo(map);
      drawList();
    });
  });
  $("#list").addEventListener("click", function (e) {
    var j = e.target.closest("[data-jump]"), f = e.target.closest("[data-focus]");
    if (j) { state.slot = Number(j.dataset.jump); $("#slot").value = state.slot; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    if (f && markers[f.dataset.focus]) {
      var m = markers[f.dataset.focus];
      map.setView(m.getLatLng(), 17); m.openPopup();
      document.getElementById("map").scrollIntoView({ behavior: "smooth" });
    }
  });
  map.on("moveend zoomend", loadCasters);

  // ---------------------------------------------------------------- weather
  function weather() {
    var url = "https://api.open-meteo.com/v1/forecast?latitude=25.08&longitude=121.38&current=precipitation&hourly=precipitation_probability,uv_index&forecast_hours=3&timezone=Asia%2FTaipei";
    fetch(url).then(function (r) { return r.json(); }).then(function (w) {
      var rainNow = w.current && w.current.precipitation > 0;
      var prob = Math.max.apply(null, (w.hourly && w.hourly.precipitation_probability) || [0]);
      var uv = Math.max.apply(null, (w.hourly && w.hourly.uv_index) || [0]);
      var msg = "";
      if (rainNow || prob >= 60) {
        msg = "☔ 林口" + (rainNow ? "現在正在下雨" : "未來 3 小時降雨機率 " + prob + "%") + "，已幫你開啟「下雨可玩」。";
        filters.rain = true; document.querySelector('[data-filter="rain"]').setAttribute("aria-pressed", "true");
      } else if (uv >= 6) {
        msg = "☀️ 未來 3 小時紫外線指數最高 " + uv.toFixed(0) + "，建議選擇此時段遮陰 ≥ 60% 的公園。";
      }
      $("#weather").textContent = msg ? msg + "（天氣：Open-Meteo）" : "";
      render();
    }).catch(function () {});
  }

  // ------------------------------------------------------------------ init
  setNow();
  fetch("api/parks.geojson").then(function (r) { return r.json(); }).then(function (gj) {
    state.features = gj.features;
    if (gj.features.length) {
      map.fitBounds(L.geoJSON(gj).getBounds().pad(0.05));
    } else {
      map.setView([25.08, 121.38], 13);
    }
    render();
    weather();
  });
})();
