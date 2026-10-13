(function () {
  "use strict";

  var SLOT_START = 6 * 60, SLOT_MIN = 30, SLOTS = 24, TZ = 8;
  var SHADOW_MIN_ZOOM = 16, MAX_SHADOW_M = 600;
  var PARK_HREF = window.SHADEHOP_PARK_HREF || "parks/{id}/";
  function parkHref(id) { return PARK_HREF.replace("{id}", encodeURIComponent(id)); }
  var filters = { rain: false, shade: false, parking: false, fast: false, slow: false, toilet: false, fav: false };
  var Favs = window.ShadeHopFavs;
  var LIST_MAX = 60;
  var CHARGER_R = window.SHADEHOP_CHARGER_RADIUS_M || 500;
  // Parks load per region as the map view reaches it; nobody has to pick a region first.
  var state = { date: null, slot: 8, user: null, features: [], playTimer: null, regions: [], loaded: {} };
  var chargersOn = true;  // one on-map toggle for all chargers
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
  // ------------------------------------------------------------ base map
  // OSM vector map (OpenFreeMap "Liberty") drawn by MapLibre inside Leaflet, simplified for this
  // map: no shop/bank/restaurant icons, no 3D buildings, Chinese-only labels. MapLibre needs
  // WebGL; without it (or if anything fails to load) we fall back to OSM image tiles. Those come from
  // the volunteer-run tile.openstreetmap.org, whose usage policy rules out busy sites relying on them,
  // so phones that can draw the vector map never request them.
  var VECTOR_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  var MAPLIBRE = "static/vendor/maplibre-gl-5.24.0/", BRIDGE = "static/vendor/maplibre-gl-leaflet-0.1.4/leaflet-maplibre-gl.js";
  var DROP_LAYERS = /^(poi_r\d+|building-3d|natural_earth)$/;  // keep poi_transit (MRT/rail stations)
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  var rasterLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM_ATTR });
  function rasterBase() { if (!map.hasLayer(rasterLayer)) rasterLayer.addTo(map); }
  function baseNote(on) {
    var el = map.getContainer().querySelector(".map-loading");
    if (on && !el) { el = L.DomUtil.create("div", "map-loading", map.getContainer()); el.textContent = "地圖載入中…"; }
    if (el) el.hidden = !on;
  }
  function hasWebGL() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  }
  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var el = document.createElement("script");
      el.src = src; el.onload = ok; el.onerror = fail;
      document.head.appendChild(el);
    });
  }
  function simplifyStyle(style) {
    style.layers = style.layers.filter(function (l) { return !DROP_LAYERS.test(l.id); });
    style.layers.forEach(function (l) {
      // Transit icons: rail/MRT stations and airports only - bus stops are clutter here.
      if (l.id === "poi_transit") {
        l.filter = ["match", ["get", "class"], ["airport", "rail", "railway"], true, false];
        l.layout["icon-image"] = ["match", ["get", "subclass"], "subway", "railway_metro", ["to-string", ["get", "class"]]];
      }
      var tf = l.layout && l.layout["text-field"];
      // Labels default to "pinyin + 漢字"; show the local (Chinese) name only.
      if (tf && JSON.stringify(tf).indexOf("name:latin") >= 0) {
        l.layout["text-field"] = ["coalesce", ["get", "name:nonlatin"], ["get", "name"]];
      }
    });
    // Symbols in layers higher in the stack are placed first, so stations win over street names.
    var i = style.layers.findIndex(function (l) { return l.id === "poi_transit"; });
    if (i >= 0) style.layers.push(style.layers.splice(i, 1)[0]);
    return style;
  }
  function vectorBase() {
    var css = document.createElement("link");
    css.rel = "stylesheet"; css.href = MAPLIBRE + "maplibre-gl.css";
    document.head.appendChild(css);
    Promise.all([
      fetch(VECTOR_STYLE).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }),
      loadScript(MAPLIBRE + "maplibre-gl.js").then(function () { return loadScript(BRIDGE); }),
    ]).then(function (res) {
      // With preloading the files can arrive before the map has its first view; the MapLibre map is
      // only created once Leaflet has one.
      return new Promise(function (ok) { map.whenReady(function () { ok(res); }); });
    }).then(function (res) {
      var gl = L.maplibreGL({
        style: simplifyStyle(res[0]),
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> ' + OSM_ATTR,
      }).addTo(map);
      var glMap = gl.getMaplibreMap();
      var drawn = false;
      // "idle" = style, tiles and labels for the current view are drawn.
      glMap.once("idle", function () {
        drawn = true;
        baseNote(false);
        if (map.hasLayer(rasterLayer)) map.removeLayer(rasterLayer);
      });
      // Still blank after 15 s (very slow network or tile server down): show the image map meanwhile.
      setTimeout(function () { if (!drawn) { rasterBase(); baseNote(false); } }, 15000);
    }).catch(function () { rasterBase(); baseNote(false); });
  }
  if (hasWebGL()) { baseNote(true); vectorBase(); } else rasterBase();
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
      '<br><a href="' + parkHref(p.id) + '">詳細資料 →</a>' +
      (p.gmaps ? '　<a href="' + esc(p.gmaps) + '" target="_blank" rel="noopener">Google 評論 ↗</a>' : "");
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

  // Before sunrise / after sunset there are no shadows to draw; without a cue the map would look
  // sunny everywhere. Tint it and say when the sun rises or sets on that date at that place.
  map.createPane("night").style.zIndex = 390;  // above base map, below shadows/markers
  map.getPane("night").style.pointerEvents = "none";
  var nightLayer = L.rectangle([[-85, -180], [85, 180]], { pane: "night", stroke: false, fillColor: "#0b1a33", fillOpacity: 0.28, interactive: false });

  function sunTimes(c) {
    // Minutes after local midnight when the sun crosses the horizon (refined to 1 minute).
    var p = state.date.split("-").map(Number), up = null, down = null, prev = null;
    function alt(min) { return sunPosition(new Date(Date.UTC(p[0], p[1] - 1, p[2], 0, min) - TZ * 3600000), c.lat, c.lng).altitude; }
    for (var m = 3 * 60; m <= 21 * 60; m += 1) {
      var a = alt(m);
      // Published sunrise/sunset: upper limb on the horizon incl. refraction (centre at -0.833 deg).
      if (prev !== null && prev <= -0.833 && a > -0.833 && up === null) up = m;
      if (prev !== null && prev > -0.833 && a <= -0.833) down = m;
      prev = a;
    }
    return { up: up, down: down };
  }
  function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

  function drawNight(sun, c) {
    var label = map.getContainer().querySelector(".map-night");
    if (sun.altitude > 0) {
      if (map.hasLayer(nightLayer)) map.removeLayer(nightLayer);
      if (label) label.hidden = true;
      return;
    }
    if (!map.hasLayer(nightLayer)) nightLayer.addTo(map);
    if (!label) { label = L.DomUtil.create("div", "map-night", map.getContainer()); label.setAttribute("role", "status"); }
    var t = sunTimes(c), evening = SLOT_START + state.slot * SLOT_MIN >= 12 * 60;
    label.textContent = evening
      ? "🌙 日落後，沒有直射陽光" + (t.down !== null ? "（這天日落約 " + hhmm(t.down) + "）" : "")
      : "🌅 日出前，還沒有直射陽光" + (t.up !== null ? "（這天日出約 " + hhmm(t.up) + "）" : "");
    label.hidden = false;
  }

  function drawShadows() {
    shadowLayer.clearLayers();
    var c = map.getCenter();
    var sun = sunPosition(slotDate(), c.lat, c.lng);
    drawNight(sun, c);
    if (!tiles.index || map.getZoom() < SHADOW_MIN_ZOOM) return;
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
      // One multipolygon (each shadow its own polygon, not a hole of the first) filled with the
      // non-zero rule: hulls all wind the same way, so overlapping shadows render as their union
      // with one even shade instead of punching holes (even-odd) or stacking opacity.
      L.polygon(polys.map(function (ring) { return [ring]; }), {
        stroke: false, fillColor: "#1e283c", fillOpacity: 0.32, fillRule: "nonzero", interactive: false,
      }).addTo(shadowLayer);
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
      "<span>⚡ 快充 " + (p.fast_nearest_m !== null ? p.fast_nearest_m + "m" : CHARGER_R + "m 內無") + " · 🔌 慢充 " + (p.slow_nearest_m !== null ? p.slow_nearest_m + "m" : CHARGER_R + "m 內無") + "</span>" +
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
  // Charger markers match the on-map toggle: fast = orange circle with a white bolt (also for
  // sites with both), slow = a blue plug, unknown = small grey "?" circle.
  var BOLT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 1.5 4 13.5h6.5L9 22.5l10-12.5h-6.6z"/></svg>';
  var PLUG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="#fff" stroke-width="2.4" paint-order="stroke" stroke-linejoin="round" d="M16 7V3h-2v4h-4V3H8v4H6v7.5L9.5 18v3h5v-3l3.5-3.5V7z"/></svg>';
  var CHG = {
    fast: { cls: "fast", html: BOLT_SVG, size: 26 },
    both: { cls: "fast", html: BOLT_SVG, size: 26 },
    slow: { cls: "slow", html: PLUG_SVG, size: 26 },
    unknown: { cls: "unknown", html: "?", size: 18 },
  };

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

  // Show how many stations are in view, so the toggle never looks dead when the area has none.
  function countChargers() {
    var b = map.getBounds(), n = 0;
    chargers.forEach(function (f) {
      var c = f.geometry.coordinates;
      if (b.contains([c[1], c[0]])) n++;
    });
    var btn = document.querySelector(".chg-btn");
    if (!btn) return;
    btn.querySelector(".n").textContent = chargersLoaded ? n : "…";
    btn.title = (chargersOn ? "隱藏充電站" : "顯示充電站") + (chargersLoaded ? "（畫面中 " + n + " 座）" : "");
  }

  // Zoomed out, hundreds of icons would bury the parks: draw small dots, icons from this zoom up.
  var CHARGER_ICON_ZOOM = 14;
  var DOT_COLOR = { fast: "#d9480f", both: "#d9480f", slow: "#1971c2", unknown: "#868e96" };
  var chargerMode = null;

  function drawChargers() {
    countChargers();
    chargerLayer.clearLayers();
    chargerMode = map.getZoom() >= CHARGER_ICON_ZOOM ? "icon" : "dot";
    if (!chargersOn) return;
    chargers.forEach(function (f) {
      var p = f.properties, k = CHG[p.speed] || CHG.unknown, ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
      var title = p.name + "（" + (p.speed === "unknown" ? "未標示" : p.speed_label) + "）";
      var m = chargerMode === "icon"
        ? L.marker(ll, { pane: "chargers", title: title,
            icon: L.divIcon({ className: "chg " + k.cls, html: k.html, iconSize: [k.size, k.size], iconAnchor: [k.size / 2, k.size / 2] }) })
        // Dots share the parks' canvas: a canvas in its own pane would cover the whole map and
        // swallow every click meant for the parks underneath.
        : L.circleMarker(ll, { radius: 3.5, weight: 1, color: "#fff",
            fillColor: DOT_COLOR[p.speed] || DOT_COLOR.unknown, fillOpacity: 0.9 });
      m.bindPopup(function () { return chargerPopup(f); }).addTo(chargerLayer);
    });
  }
  map.on("zoomend", function () {
    var mode = map.getZoom() >= CHARGER_ICON_ZOOM ? "icon" : "dot";
    if (mode !== chargerMode) drawChargers();
  });

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

  // One charger toggle on the map (like an EV map app), with the number of stations in view.
  var BOLT = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M13.5 1.5 4 13.5h6.5L9 22.5l10-12.5h-6.6z"/></svg>';
  var ChargerControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "map-ctl chg-ctl");
      var b = L.DomUtil.create("button", "chg-btn", box);
      b.type = "button"; b.setAttribute("aria-label", "地圖上顯示充電站");
      b.setAttribute("aria-pressed", String(chargersOn));
      b.innerHTML = BOLT + '<span class="n"></span>';
      L.DomEvent.on(b, "click", function () {
        chargersOn = !chargersOn;
        b.setAttribute("aria-pressed", String(chargersOn));
        drawChargers();
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
  fetch("api/chargers.geojson").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (gj) {
    chargers = gj.features; chargersLoaded = true;
    // The file can arrive before the regions list has given the map its first view; Leaflet
    // cannot place markers until then.
    map.whenReady(drawChargers);
  }, function () {
    // Only a failed download is reported as such (not a drawing error after it loaded).
    document.querySelectorAll("[data-layer] .n").forEach(function (o) { o.textContent = "!"; });
    mapToast("充電站資料暫時無法載入");
  });
})();
