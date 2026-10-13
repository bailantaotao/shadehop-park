(function () {
  "use strict";

  var SLOT_START = 6 * 60, SLOT_MIN = 30, SLOTS = 24, TZ = 8;
  var SHADOW_MIN_ZOOM = 16, MAX_SHADOW_M = 600;
  var PARK_HREF = window.SHADEHOP_PARK_HREF || "parks/{id}/";
  function parkHref(id) { return PARK_HREF.replace("{id}", encodeURIComponent(id)); }
  var filters = { rain: false, shade: false, parking: false, fast: false, slow: false, toilet: false, fav: false };
  var Favs = window.ShadeHopFavs;
  var LIST_MAX = 60;
  // Parks load per region as the map view reaches it; nobody has to pick a region first.
  var state = { date: null, slot: 8, user: null, features: [], playTimer: null, regions: [], loaded: {} };
  var layers = { fast: true, slow: true, unknown: false };
  // Shadow casters are split into ~1 km tiles; only tiles in view are downloaded.
  var tiles = { index: null, deg: 0.01, data: {} };

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
  // Canvas draws hundreds of markers much faster than SVG on old phones.
  var map = L.map("map", { zoomControl: true, preferCanvas: true });
  map.createPane("chargers").style.zIndex = 650;
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
    if (filters.fav && !Favs.has(p.id)) return false;
    return true;
  }

  function popupHtml(f) {
    var p = f.properties, v = shadeAt(f);
    return Favs.button(p.id) + " <strong>" + esc(p.name) + "</strong><br>" +
      (p.rain === true ? "☔ 下雨可玩<br>" : "") +
      slotLabel(state.slot) + " 遮陰：" + (v === null ? "無日照" : Math.round(v * 100) + "%") +
      '<br><a href="' + parkHref(p.id) + '">詳細資料 →</a>';
  }

  function drawMarkers() {
    // Redrawing replaces every marker, which would close an open popup; reopen it afterwards.
    var open = null;
    Object.keys(markers).forEach(function (id) { if (markers[id].isPopupOpen()) open = id; });
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
    if (open && markers[open]) markers[open].openPopup();
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

  function visibleTiles() {
    var b = map.getBounds().pad(0.3), d = tiles.deg, keys = [];
    for (var x = Math.floor(b.getWest() / d); x <= Math.floor(b.getEast() / d); x++) {
      for (var y = Math.floor(b.getSouth() / d); y <= Math.floor(b.getNorth() / d); y++) {
        var k = x + "_" + y;
        if (tiles.index && tiles.index[k]) keys.push(k);
      }
    }
    return keys;
  }

  function drawShadows() {
    shadowLayer.clearLayers();
    if (!tiles.index || map.getZoom() < SHADOW_MIN_ZOOM) return;
    var c = map.getCenter();
    var sun = sunPosition(slotDate(), c.lat, c.lng);
    if (sun.altitude <= 0) return;
    var k = 1 / Math.tan(sun.altitude * Math.PI / 180);
    var ux = -Math.sin(sun.azimuth * Math.PI / 180) * k, uy = -Math.cos(sun.azimuth * Math.PI / 180) * k;
    var mPerLng = 111320 * Math.cos(c.lat * Math.PI / 180), mPerLat = 110574;
    var view = map.getBounds().pad(0.3);
    var polys = [];
    var features = [];
    visibleTiles().forEach(function (k) { if (Array.isArray(tiles.data[k])) features = features.concat(tiles.data[k]); });
    features.forEach(function (f) {
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
    if (map.getZoom() < SHADOW_MIN_ZOOM) return drawShadows();
    if (tiles.index === null) {
      tiles.index = false;  // loading
      fetch("api/casters/index.json").then(function (r) { return r.json(); }).then(function (ix) {
        tiles.deg = ix.tile_deg; tiles.index = {};
        ix.tiles.forEach(function (k) { tiles.index[k] = true; });
        loadCasters();
      }).catch(function () { tiles.index = null; });
      return;
    }
    if (!tiles.index) return;
    visibleTiles().forEach(function (k) {
      if (tiles.data[k] !== undefined) return;
      tiles.data[k] = "loading";
      fetch("api/casters/" + k + ".geojson").then(function (r) { return r.json(); })
        .then(function (gj) { tiles.data[k] = gj.features; drawShadows(); })
        .catch(function () { delete tiles.data[k]; });
    });
    drawShadows();
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
    return '<article class="card' + (state.selected === p.id ? " selected" : "") + '" data-park="' + esc(p.id) + '"><h3>' + Favs.button(p.id) + ' <a href="' + parkHref(p.id) + '">' + esc(p.name) + "</a></h3>" +
      '<div class="badges">' + levelBadge + (p.kind === "park" ? '<span class="badge">遊戲設施待確認</span>' : "") + (p.indoor === true ? '<span class="badge">室內</span>' : p.indoor === "possible" ? '<span class="badge">可能室內/中庭</span>' : "") + '<span class="badge">' + slotLabel(state.slot) + " 遮陰 " + (v === null ? "—" : Math.round(v * 100) + "%") + "</span></div>" +
      '<div class="timeline" aria-label="' + month() + ' 月遮陰時間軸">' + cells + '</div><div class="tl-axis"><span>06</span><span>12</span><span>18</span></div>' +
      '<div class="facts">' +
      (best ? '<span>最遮陰：' + best.start + "–" + best.end + ' <button class="link" data-jump="' + best.start_slot + '">跳到這個時間</button></span>' : "<span>本月沒有明顯遮陰時段</span>") +
      "<span>🅿️ " + (p.parking_name ? esc(p.parking_name) + " " + p.parking_nearest_m + "m" : "800m 內未標示停車場") + "</span>" +
      "<span>⚡ 快充 " + (p.fast_nearest_m !== null ? p.fast_nearest_m + "m" : "2km 內無") + " · 🔌 慢充 " + (p.slow_nearest_m !== null ? p.slow_nearest_m + "m" : "2km 內無") + "</span>" +
      '<span class="small">' + dist.replace(/^ · /, "") + "</span>" +
      '</div><button class="link" data-focus="' + esc(p.id) + '">在地圖上看</button></article>';
  }

  function inView(f) {
    var c = f.geometry.coordinates;
    return map.getBounds().contains([c[1], c[0]]);
  }

  function drawList() {
    // "My favourites" lists every favourite, wherever it is; otherwise only parks in view.
    var fs = state.features.filter(function (f) { return passes(f) && (filters.fav || inView(f)); });
    fs.sort(function (a, b) {
      if (state.user) return distM(state.user, a.geometry.coordinates) - distM(state.user, b.geometry.coordinates);
      var ra = a.properties.rain === true ? 1 : 0, rb = b.properties.rain === true ? 1 : 0;
      return rb - ra || (shadeAt(b) || 0) - (shadeAt(a) || 0);
    });
    $("#count").textContent = (filters.fav ? "我的最愛（" : "地圖範圍內的公園（") + fs.length + "）· " + month() + " 月 " + slotLabel(state.slot);
    var html = fs.slice(0, LIST_MAX).map(card).join("");
    if (fs.length > LIST_MAX) html += '<p class="muted">還有 ' + (fs.length - LIST_MAX) + " 處，放大地圖可以縮小範圍。</p>";
    if (!fs.length && filters.fav) {
      html = '<p class="muted">還沒有收藏的公園。點公園名稱旁的 ☆ 就能加入；收藏只存在這個瀏覽器裡，不需要登入。</p>';
    } else if (!fs.length) {
      var covered = state.regions.some(function (r) { return regionInView(r); });
      html = '<p class="muted">' + (covered ? "這個範圍沒有符合條件的公園，試著移動地圖或取消一些篩選。"
        : "這個範圍還沒有資料。目前收錄：" + state.regions.map(function (r) { return r.city + (r.name !== r.city ? r.name : ""); }).join("、") + "。") + "</p>";
    }
    $("#list").innerHTML = html;
  }

  // Coalesce redraws to one per animation frame, so dragging the time slider stays smooth on slow phones.
  // Moving the map only changes the list and shadows (markers do not depend on the view).
  var pending = null;
  function render(viewOnly) {
    $("#slotOut").textContent = slotLabel(state.slot);
    var full = !viewOnly || pending === "full";
    if (pending) { pending = full ? "full" : "view"; return; }
    pending = full ? "full" : "view";
    requestAnimationFrame(function () {
      if (pending === "full") drawMarkers();
      pending = null;
      drawShadows();
      drawList();
    });
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
      b.setAttribute("aria-pressed", String(filters[k]));
      if (k === "fav" && filters[k]) loadAllRegions();  // favourites can be in any region
      render();
    });
  });
  // Show a park on the map: centre it, open its popup, mark its card, and bring the map into view.
  function focusPark(id) {
    var m = markers[id];
    if (!m) return;
    state.selected = id;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 17));
    m.openPopup();
    var box = document.getElementById("map").getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) document.getElementById("map").scrollIntoView({ behavior: "smooth" });
    render(true);
  }

  $("#list").addEventListener("click", function (e) {
    var j = e.target.closest("[data-jump]"), f = e.target.closest("[data-focus]");
    if (j) { state.slot = Number(j.dataset.jump); $("#slot").value = state.slot; render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (f) { focusPark(f.dataset.focus); return; }
    // Anywhere else on a card (not its name link, star or other buttons) also shows it on the map.
    var card = e.target.closest("[data-park]");
    if (card && !e.target.closest("a, button, input")) focusPark(card.dataset.park);
  });
  map.on("moveend", function () {
    loadRegionsInView();
    loadCasters();
    saveView();
    countChargers();
    render(true);
    weatherIfMoved();
  });

  // ---------------------------------------------------------------- weather
  var weatherAt = null;
  function weatherIfMoved() {
    var c = map.getCenter();
    if (!weatherAt || distM([weatherAt.lng, weatherAt.lat], [c.lng, c.lat]) > 8000) weather();
  }

  function weather() {
    var c = map.getCenter();
    weatherAt = c;
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + c.lat.toFixed(3) + "&longitude=" + c.lng.toFixed(3) +
      "&current=precipitation&hourly=precipitation_probability,uv_index&forecast_hours=3&timezone=Asia%2FTaipei";
    fetch(url).then(function (r) { return r.json(); }).then(function (w) {
      var rainNow = w.current && w.current.precipitation > 0;
      var prob = Math.max.apply(null, (w.hourly && w.hourly.precipitation_probability) || [0]);
      var uv = Math.max.apply(null, (w.hourly && w.hourly.uv_index) || [0]);
      var msg = "";
      if (rainNow || prob >= 60) {
        msg = "☔ 地圖這一帶" + (rainNow ? "現在正在下雨" : "未來 3 小時降雨機率 " + prob + "%") + "，已幫你開啟「下雨可玩」。";
        filters.rain = true; document.querySelector('[data-filter="rain"]').setAttribute("aria-pressed", "true");
      } else if (uv >= 6) {
        msg = "☀️ 未來 3 小時紫外線指數最高 " + uv.toFixed(0) + "，建議選擇此時段遮陰 ≥ 60% 的公園。";
      }
      $("#weather").textContent = msg ? msg + "（天氣：Open-Meteo）" : "";
      render();
    }).catch(function () {});
  }

  // ------------------------------------------------------- regions & view
  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function regionBounds(r) { return L.latLngBounds([r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]); }
  function regionInView(r) { return map.getBounds().intersects(regionBounds(r)); }

  function loadRegionsInView() {
    state.regions.forEach(function (r) {
      if (state.loaded[r.id] || !map.getBounds().pad(0.2).intersects(regionBounds(r))) return;
      state.loaded[r.id] = true;
      fetch("api/regions/" + r.id + ".geojson").then(function (res) { return res.json(); }).then(function (gj) {
        state.features = state.features.concat(gj.features);
        render();
      }).catch(function () { state.loaded[r.id] = false; });
    });
  }

  function loadAllRegions() {
    state.regions.forEach(function (r) {
      if (state.loaded[r.id]) return;
      state.loaded[r.id] = true;
      fetch("api/regions/" + r.id + ".geojson").then(function (res) { return res.json(); }).then(function (gj) {
        state.features = state.features.concat(gj.features);
        render();
      }).catch(function () { state.loaded[r.id] = false; });
    });
  }

  // Leaflet popups stop click propagation, so stars inside them need their own handler.
  map.on("popupopen", function (e) {
    e.popup.getElement().querySelectorAll("[data-fav]").forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.preventDefault(); Favs.toggle(b.dataset.fav); });
    });
  });

  // Re-filter when a star is toggled (the star buttons themselves update in favs.js).
  document.addEventListener("shadehop:favs", function () { if (filters.fav) render(); });

  function saveView() {
    var c = map.getCenter(), v = map.getZoom() + "/" + c.lat.toFixed(5) + "/" + c.lng.toFixed(5);
    history.replaceState(null, "", "#" + v);
    storeSet("shadehop.view", v);
  }

  function initialView() {
    // #zoom/lat/lng (shareable), an old #regionId link, the last view, or everything.
    var h = location.hash.slice(1), saved = storeGet("shadehop.view");
    var r = state.regions.find(function (x) { return x.id === h; });
    if (r) return map.fitBounds(regionBounds(r));
    var m = /^(\d+)\/(-?[\d.]+)\/(-?[\d.]+)$/.exec(h) || /^(\d+)\/(-?[\d.]+)\/(-?[\d.]+)$/.exec(saved || "");
    if (m) return map.setView([Number(m[2]), Number(m[3])], Number(m[1]));
    var all = state.regions.reduce(function (b, x) { return b ? b.extend(regionBounds(x)) : regionBounds(x); }, null);
    if (all) map.fitBounds(all); else map.setView([25.05, 121.5], 11);
  }

  // ------------------------------------------------------------- chargers
  var chargerLayer = L.layerGroup().addTo(map), chargers = [], chargersLoaded = false;
  var CHG = { fast: { icon: "⚡", cls: "fast" }, both: { icon: "⚡", cls: "both" }, slow: { icon: "🔌", cls: "slow" }, unknown: { icon: "?", cls: "unknown" } };

  function chargerShown(p) {
    if (p.speed === "both") return layers.fast || layers.slow;
    return layers[p.speed] || false;
  }

  function chargerPopup(f) {
    var p = f.properties;
    var note = p.speed_source === "brand" ? "（依營運商判斷）" : p.speed_source === "name" ? "（依站名判斷）" : "";
    return "<strong>" + esc(p.name) + "</strong><br>" +
      (p.speed === "unknown" ? "快慢充：OSM 未標示" : esc(p.speed_label.replace(/（.*）$/, "")) + note) +
      (p.max_kw ? "，最高 " + p.max_kw + " kW" : "") + "<br>" +
      (p.sockets.length ? "插頭：" + esc(p.sockets.join("、")) + "<br>" : "") +
      (p.capacity ? "充電車位：" + p.capacity + "<br>" : "") +
      (p.charging_rate ? "充電費率：" + esc(p.charging_rate) + "<br>" : "") +
      (p.parking_rate ? "停車費率：" + esc(p.parking_rate) + "<br>" : "") +
      (p.opening_hours ? "時間：" + esc(p.opening_hours) + "<br>" : "") +
      (p.floors ? "樓層：" + esc(p.floors) + "<br>" : "") +
      (p.restriction ? "限制：" + esc(p.restriction) + "<br>" : "") +
      (p.operator ? "營運：" + esc(p.operator) + "<br>" : "") +
      '<a href="https://www.google.com/maps/dir/?api=1&destination=' + f.geometry.coordinates[1] + "," + f.geometry.coordinates[0] + '" rel="noopener" target="_blank">導航</a> · ' +
      (p.source === "tdx" ? '<span class="small">資料介接「交通部TDX平臺」</span>'
        : '<a href="' + esc(p.osm) + '" rel="noopener" target="_blank">OpenStreetMap 資料</a>');
  }

  // Show how many stations of each kind are in view, so a toggle never looks dead
  // when the area simply has none.
  function countChargers() {
    var b = map.getBounds(), n = { fast: 0, slow: 0, unknown: 0 };
    chargers.forEach(function (f) {
      var p = f.properties, c = f.geometry.coordinates;
      if (!b.contains([c[1], c[0]])) return;
      if (p.speed === "both") { n.fast++; n.slow++; } else if (n[p.speed] !== undefined) n[p.speed]++;
    });
    document.querySelectorAll("[data-layer]").forEach(function (btn) {
      var out = btn.querySelector(".n");
      if (out) out.textContent = chargersLoaded ? n[btn.dataset.layer] : "…";
      btn.title = btn.getAttribute("aria-label") + (chargersLoaded ? "：畫面中 " + n[btn.dataset.layer] + " 座" : "");
    });
  }

  function drawChargers() {
    countChargers();
    chargerLayer.clearLayers();
    chargers.forEach(function (f) {
      var p = f.properties, k = CHG[p.speed] || CHG.unknown;
      if (!chargerShown(p)) return;
      L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        pane: "chargers",
        title: p.name + "（" + (p.speed === "unknown" ? "未標示" : p.speed_label) + "）",
        icon: L.divIcon({ className: "chg " + k.cls, html: k.icon, iconSize: [24, 24], iconAnchor: [12, 12] }),
      }).bindPopup(function () { return chargerPopup(f); }).addTo(chargerLayer);
    });
  }

  // ------------------------------------------------------- on-map controls
  // Small toast inside the map for locate errors etc.
  var toastTimer = null;
  function mapToast(msg) {
    var el = document.querySelector(".map-toast");
    if (!el) { el = L.DomUtil.create("div", "map-toast", map.getContainer()); el.setAttribute("role", "status"); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  // Locate me: centre on the user; the list then sorts by distance.
  var userLayer = L.layerGroup().addTo(map);
  var LocateControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "leaflet-bar map-ctl");
      var b = L.DomUtil.create("button", "locate", box);
      b.type = "button"; b.title = "回到我的位置"; b.setAttribute("aria-label", "回到我的位置");
      b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/>' +
        '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M12 1v3M12 20v3M1 12h3M20 12h3" stroke="currentColor" stroke-width="2"/></svg>';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(b, "click", function () { locate(b); });
      return box;
    },
  });
  function locate(b) {
    if (!navigator.geolocation) { mapToast("這個瀏覽器不支援定位"); return; }
    b.classList.add("busy");
    navigator.geolocation.getCurrentPosition(function (pos) {
      b.classList.remove("busy"); b.classList.add("on");
      var ll = [pos.coords.latitude, pos.coords.longitude];
      state.user = [ll[1], ll[0]];
      userLayer.clearLayers();
      L.circle(ll, { radius: pos.coords.accuracy, stroke: false, fillColor: "#2b7bff", fillOpacity: 0.12, interactive: false }).addTo(userLayer);
      L.circleMarker(ll, { radius: 7, color: "#fff", weight: 3, fillColor: "#2b7bff", fillOpacity: 1, interactive: false }).addTo(userLayer);
      map.setView(ll, Math.max(map.getZoom(), 16));
      render(true);
    }, function (err) {
      b.classList.remove("busy");
      mapToast(err.code === 1 ? "沒有定位權限：請在瀏覽器設定允許這個網站使用位置" : "暫時無法取得位置，請稍後再試");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }
  map.addControl(new LocateControl());

  // Charger layer toggles on the map (like an EV map app), each with the count in view.
  var ChargerControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "map-ctl chg-ctl");
      box.setAttribute("role", "group"); box.setAttribute("aria-label", "地圖上顯示的充電站");
      [["fast", "⚡", "快充站（DC）"], ["slow", "🔌", "慢充站（AC）"], ["unknown", "?", "未標示快慢的充電站"]].forEach(function (d) {
        var b = L.DomUtil.create("button", "chg-btn " + d[0], box);
        b.type = "button"; b.dataset.layer = d[0]; b.title = d[2];
        b.setAttribute("aria-pressed", String(layers[d[0]]));
        b.setAttribute("aria-label", d[2]);
        b.innerHTML = '<span class="ico" aria-hidden="true">' + d[1] + '</span><span class="n"></span>';
        L.DomEvent.on(b, "click", function () {
          layers[d[0]] = !layers[d[0]];
          b.setAttribute("aria-pressed", String(layers[d[0]]));
          drawChargers();
        });
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  map.addControl(new ChargerControl());

  // ------------------------------------------------------------------ init
  setNow();
  fetch("api/regions/index.json").then(function (r) { return r.json(); }).then(function (regions) {
    state.regions = regions;
    initialView();  // fires moveend -> loads the regions in view
    loadRegionsInView();
    weather();
  });
  fetch("api/chargers.geojson").then(function (r) { return r.json(); }).then(function (gj) {
    chargers = gj.features; chargersLoaded = true; drawChargers();
  }).catch(function () {
    document.querySelectorAll("[data-layer] .n").forEach(function (o) { o.textContent = "!"; });
    mapToast("充電站資料暫時無法載入");
  });
})();
