(function () {
  "use strict";

  var SLOT_START = 6 * 60, SLOT_MIN = 30, SLOTS = 24, TZ = 8;
  var SHADOW_MIN_ZOOM = 16, MAX_SHADOW_M = 600;
  var PARK_HREF = window.SHADEHOP_PARK_HREF || "parks/{id}/";
  function parkHref(id) { return PARK_HREF.replace("{id}", encodeURIComponent(id)); }
  var filters = { rain: false, shade: false, parking: false, fast: false, slow: false, toilet: false, fav: false, confirmed: false };
  var Favs = window.ShadeHopFavs;
  var LIST_MAX = 60;
  var CHARGER_R = window.SHADEHOP_CHARGER_RADIUS_M || 500;
  // Parks load per region as the map view reaches it; nobody has to pick a region first.
  var state = { date: null, slot: 8, user: null, features: [], playTimer: null, regions: [], loaded: {}, sort: "shade" };
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

  // Parents' reports (/api/reports): a park counts as a playground once at least two report one and
  // they outnumber the "no"s; a playground counts as gone once two report none and outnumber the "yes"es.
  var reports = {};
  function unsure(p) {
    var r = reports[p.id];
    if (r && r.no >= 2 && r.no > r.yes) return true;
    if (p.kind !== "park") return false;
    return !(r && r.yes >= 2 && r.yes > r.no);
  }
  function reportNote(p) {
    var r = reports[p.id];
    if (!r) return "";
    if (r.yes >= 2 && r.yes > r.no) return "・" + r.yes + " 位家長回報有遊戲場";
    if (r.no >= 2 && r.no > r.yes) return "・" + r.no + " 位家長回報沒有遊戲場";
    return "";
  }

  function passes(f) {
    var p = f.properties;
    if (filters.rain && p.rain !== true) return false;
    if (filters.shade && !(p.rain === true || (shadeAt(f) || 0) >= 0.6)) return false;
    if (filters.parking && !(p.parking_nearest_m !== null && p.parking_nearest_m <= 300)) return false;
    if (filters.fast && p.fast_nearest_m === null) return false;
    if (filters.slow && p.slow_nearest_m === null) return false;
    if (filters.toilet && !p.toilet) return false;
    if (filters.fav && !Favs.has(p.id)) return false;
    if (filters.confirmed && unsure(p)) return false;  // play equipment unconfirmed (or reported gone)
    return true;
  }

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
    return { start: lab(best.from), end: lab(best.from + best.n), start_slot: best.from,
             mean: vals.reduce(function (a, b) { return a + b; }, 0) / vals.length };
  }

  function popupHtml(f) {
    // What a parent decides on at a glance: is it hot now, can we play in the rain, when is it
    // shadiest, are parking / toilets / chargers close. Everything else is on the park page.
    var p = f.properties, v = shadeAt(f), t = slotLabel(state.slot);
    var now = taipeiNow(), today = state.date === now.y + "-" + String(now.m).padStart(2, "0") + "-" + String(now.d).padStart(2, "0");
    var shade = v === null || v === undefined
      ? '<span class="pp-pill night">' + t + " 沒有直射陽光</span>"
      : '<span class="pp-pill ' + shadeClass(v) + '">' + t + " 遮陰 " + Math.round(v * 100) + "%</span>";
    var rain = p.rain === true ? '<span class="pp-pill a">下雨可玩</span>'
      : p.rain === "partial" ? '<span class="pp-pill">部分可躲雨</span>' : '<span class="pp-pill">下雨不適合</span>';
    var best = bestDaytime((p.timetable || {})[String(month())] || []);
    var tile = function (icon, label, m) {
      return '<div class="pp-tile"><span>' + icon + "</span>" + label + "<b>" + (m === null || m === undefined ? "—" : m + "m") + "</b></div>";
    };
    var charge = p.fast_nearest_m !== null && p.fast_nearest_m !== undefined ? tile("⚡", "快充", p.fast_nearest_m) : tile("🔌", "慢充", p.slow_nearest_m);
    return '<div class="pp">' +
      '<div class="pp-head"><div><div class="pp-name">' + esc(p.name) + '</div><div class="pp-sub">' + esc(p.district) +
      (reportNote(p) || (unsure(p) ? "・遊具待確認" : "")) + (p.indoor === true ? "・室內" : "") + "</div></div>" + Favs.button(p.id) + "</div>" +
      '<div class="pp-pills">' + shade + rain + "</div>" +
      '<div class="pp-best">' + (today ? "今天" : "這天") + "最陰涼：" +
      (best ? "<b>" + best.start + "–" + best.end + "</b>" : '<span class="muted">白天沒有明顯遮陰，避開中午</span>') + "</div>" +
      '<div class="pp-grid">' + tile("🅿️", "停車", p.parking_nearest_m) + tile("🚻", "廁所", p.toilet_m) +
      tile("🏪", "超商", p.shop_m) + charge + "</div>" +
      '<div class="pp-btns"><a class="pp-btn primary" href="' + parkHref(p.id) + '">查看詳情</a>' +
      (p.nav ? '<a class="pp-btn" href="' + esc(p.nav) + '" target="_blank" rel="noopener">導航</a>' : "") +
      (p.gmaps ? '<a class="pp-btn" href="' + esc(p.gmaps) + '" target="_blank" rel="noopener">評論</a>' : "") +
      "</div></div>";
  }

  function drawMarkers() {
    // Redrawing replaces every marker, which would close an open popup; reopen it afterwards.
    var open = null;
    Object.keys(markers).forEach(function (id) { if (markers[id].isPopupOpen()) open = id; });
    markerLayer.clearLayers();
    markers = {};
    // Parks with unconfirmed play equipment are small and faint, and drawn first so confirmed
    // playgrounds sit on top of them.
    var ordered = state.features.filter(passes).sort(function (a, b) {
      return (unsure(a.properties) ? 0 : 1) - (unsure(b.properties) ? 0 : 1);
    });
    ordered.forEach(function (f) {
      var p = f.properties, cls = shadeClass(shadeAt(f)), faint = unsure(p) && p.rain !== true;
      var m = L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        radius: p.rain === true ? 10 : faint ? 5.5 : 8,
        color: p.rain === true ? css("--a") : css("--surface"),
        weight: p.rain === true ? 4 : faint ? 1 : 2,
        fillColor: css("--" + cls),
        fillOpacity: faint ? 0.45 : cls === "night" ? 0.5 : 0.95,
      });
      // Keep the popup clear of the zoom buttons (top left) and the charger toggle (top right) when it opens.
      m.bindPopup(function () { return popupHtml(f); }, { className: "park-pop", minWidth: 240, maxWidth: 280,
        autoPanPaddingTopLeft: L.point(52, 70), autoPanPaddingBottomRight: L.point(12, 24) });
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
    var best = bestDaytime(row);
    var cells = row.map(function (x, i) {
      return '<span class="' + shadeClass(x) + (i === state.slot ? " cur" : "") + '" title="' + slotLabel(i) + " " + (x === null ? "無日照" : Math.round(x * 100) + "%") + '"></span>';
    }).join("");
    var dist = state.user ? " · 距離你 " + (distM(state.user, f.geometry.coordinates) / 1000).toFixed(1) + " km" : "";
    var levelBadge = { A: '<span class="badge A">☔ 下雨可玩</span>', B: '<span class="badge">部分遮陽/樹蔭</span>', C: '<span class="badge">大樓陰影</span>', none: '<span class="badge">大多曝曬</span>' }[p.level];
    return '<article class="card' + (state.selected === p.id ? " selected" : "") + '" data-park="' + esc(p.id) + '"><h3>' + Favs.button(p.id) + ' <a href="' + parkHref(p.id) + '">' + esc(p.name) + "</a></h3>" +
      '<div class="badges">' + levelBadge + (reportNote(p) ? '<span class="badge">' + reportNote(p).slice(1) + "</span>" : unsure(p) ? '<span class="badge">遊戲設施待確認</span>' : "") + (p.indoor === true ? '<span class="badge">室內</span>' : p.indoor === "possible" ? '<span class="badge">可能室內/中庭</span>' : "") + '<span class="badge">' + slotLabel(state.slot) + " 遮陰 " + (v === null ? "—" : Math.round(v * 100) + "%") + "</span></div>" +
      '<div class="timeline" aria-label="' + month() + ' 月遮陰時間軸">' + cells + '</div><div class="tl-axis"><span>06</span><span>12</span><span>18</span></div>' +
      '<div class="facts">' +
      (best ? '<span>白天最遮陰：' + best.start + "–" + best.end + ' <button class="link" data-jump="' + best.start_slot + '">跳到這個時間</button></span>' : "<span>白天沒有明顯遮陰時段</span>") +
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
    var near = state.sort === "near" && state.user;
    fs.sort(function (a, b) {
      if (near) return distM(state.user, a.geometry.coordinates) - distM(state.user, b.geometry.coordinates);
      var ra = a.properties.rain === true ? 1 : 0, rb = b.properties.rain === true ? 1 : 0;
      var ca = unsure(a.properties) ? 0 : 1, cb = unsure(b.properties) ? 0 : 1;
      // Rain-proof first, then confirmed playgrounds before parks whose equipment is unsure, then shade now.
      return rb - ra || cb - ca || (shadeAt(b) || 0) - (shadeAt(a) || 0);
    });
    $("#count").textContent = filters.fav ? "我的最愛（" + fs.length + "）" : "這個範圍有 " + fs.length + " 座公園";
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
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; btn.setAttribute("aria-pressed", "false"); btn.innerHTML = '▶<span class="lbl"> 播放一天</span>'; return; }
    btn.setAttribute("aria-pressed", "true"); btn.innerHTML = '⏸<span class="lbl"> 暫停</span>';
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
  function setSort(mode) {
    state.sort = mode;
    document.querySelectorAll("[data-sort]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.sort === mode)); });
    render(true);
  }
  document.querySelectorAll("[data-sort]").forEach(function (b) {
    b.addEventListener("click", function () {
      // "Nearest" needs the user's position; ask for it the first time.
      if (b.dataset.sort === "near" && !state.user) { if (locateBtn) locate(locateBtn); return; }
      setSort(b.dataset.sort);
    });
  });
  // ---------------------------------------------------------------- search
  // By park name or district, across all regions (they load on the first keystroke).
  var searchQ = "", searchEl = $("#search"), resultsEl = $("#searchResults");
  function norm(t) { return String(t || "").replace(/臺/g, "台").replace(/\s+/g, "").toLowerCase(); }
  function runSearch() {
    var q = norm(searchQ);
    if (!q) { resultsEl.hidden = true; searchEl.setAttribute("aria-expanded", "false"); return; }
    var hits = [], districts = {};
    state.features.forEach(function (f) {
      var p = f.properties, name = norm(p.name), dist = norm(p.district);
      if (dist.indexOf(q) >= 0) {
        var key = p.region + "|" + p.district;
        (districts[key] = districts[key] || { region: p.region, district: p.district, fs: [] }).fs.push(f);
      }
      if (name.indexOf(q) >= 0) hits.push(f);
    });
    hits.sort(function (a, b) {
      var an = norm(a.properties.name), bn = norm(b.properties.name);
      return (bn.indexOf(q) === 0) - (an.indexOf(q) === 0) ||                       // name starts with the query
        unsure(a.properties) - unsure(b.properties) ||                             // confirmed playgrounds first
        an.length - bn.length;
    });
    var html = Object.keys(districts).slice(0, 2).map(function (k) {
      var d = districts[k], r = state.regions.find(function (x) { return x.id === d.region; });
      return '<li role="option" tabindex="-1" data-district="' + esc(k) + '">📍 前往 ' + esc((r ? r.city : "") + d.district) +
        ' <span class="muted">（' + d.fs.length + " 處）</span></li>";
    }).join("");
    // Several play areas of one park share its name: list the park once.
    var groups = [], byKey = {};
    hits.forEach(function (f) {
      var k = f.properties.name + "|" + f.properties.district;
      if (!byKey[k]) groups.push(byKey[k] = []);
      byKey[k].push(f);
    });
    html += groups.slice(0, 8).map(function (g, i) {
      var p = g[0].properties;
      return '<li role="option" tabindex="-1" ' + (g.length > 1 ? 'data-group="' + i + '"' : 'data-id="' + esc(p.id) + '"') + ">" + esc(p.name) +
        ' <span class="muted">' + esc(p.district) + (g.length > 1 ? "・" + g.length + " 處遊戲場" : unsure(p) ? "・遊具待確認" : "") + "</span></li>";
    }).join("");
    resultsEl._groups = groups;
    if (!html) html = '<li class="muted">' + (Object.keys(state.loaded).length < state.regions.length ? "搜尋中…" : "找不到符合的公園") + "</li>";
    resultsEl.innerHTML = html;
    resultsEl.hidden = false;
    searchEl.setAttribute("aria-expanded", "true");
    resultsEl._districts = districts;
  }
  function chooseResult(li) {
    if (!li) return;
    if (li.dataset.id) {
      var f = state.features.find(function (x) { return x.properties.id === li.dataset.id; });
      if (f && !markers[li.dataset.id]) mapToast("這座公園不符合目前的篩選條件，先幫你移過去");
      if (f) {
        map.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], 17);
        if (markers[li.dataset.id]) focusPark(li.dataset.id);
      }
    } else if (li.dataset.district || li.dataset.group) {
      var fs = li.dataset.group ? resultsEl._groups[Number(li.dataset.group)] : resultsEl._districts[li.dataset.district].fs;
      map.fitBounds(L.latLngBounds(fs.map(function (f) { return [f.geometry.coordinates[1], f.geometry.coordinates[0]]; })).pad(0.2), { maxZoom: 17 });
      document.getElementById("map").scrollIntoView({ behavior: "smooth" });
    } else {
      return;
    }
    resultsEl.hidden = true;
    searchEl.setAttribute("aria-expanded", "false");
    searchEl.blur();
  }
  var searchTimer = null;
  searchEl.addEventListener("input", function () {
    searchQ = searchEl.value.trim();
    loadAllRegions();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  searchEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); chooseResult(resultsEl.querySelector("li[tabindex]")); }
    if (e.key === "Escape") { resultsEl.hidden = true; searchEl.setAttribute("aria-expanded", "false"); }
    if (e.key === "ArrowDown") { e.preventDefault(); var first = resultsEl.querySelector("li[tabindex]"); if (first) first.focus(); }
  });
  resultsEl.addEventListener("keydown", function (e) {
    var li = e.target.closest("li");
    if (e.key === "Enter") { e.preventDefault(); chooseResult(li); }
    if (e.key === "ArrowDown" && li && li.nextElementSibling) { e.preventDefault(); li.nextElementSibling.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); (li && li.previousElementSibling ? li.previousElementSibling : searchEl).focus(); }
  });
  resultsEl.addEventListener("click", function (e) { chooseResult(e.target.closest("li")); });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search")) { resultsEl.hidden = true; searchEl.setAttribute("aria-expanded", "false"); }
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

  // The district of the park nearest the map centre: the weather endpoint takes a district, not
  // coordinates, so no position leaves the browser.
  function centreDistrict() {
    var c = map.getCenter(), best = null, bestD = Infinity;
    state.features.forEach(function (f) {
      var d = distM([c.lng, c.lat], f.geometry.coordinates);
      if (d < bestD) { bestD = d; best = f; }
    });
    if (!best || bestD > 5000) return null;
    var r = state.regions.find(function (x) { return x.id === best.properties.region; });
    return r ? { city: r.city, district: best.properties.district } : null;
  }

  function weather() {
    var where = centreDistrict();
    if (!where) return;  // parks in view not loaded yet; loadRegion calls weatherIfMoved again
    weatherAt = map.getCenter();
    fetch("api/weather?city=" + encodeURIComponent(where.city) + "&district=" + encodeURIComponent(where.district))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (w) {
        var rainy = w.pop !== null && w.pop >= 60, msg = "";
        if (rainy) {
          msg = "☔ " + where.district + "未來 3 小時降雨機率 " + w.pop + "%" + (w.weather ? "（" + w.weather + "）" : "") + "，已幫你開啟「下雨可玩」。";
          filters.rain = true; document.querySelector('[data-filter="rain"]').setAttribute("aria-pressed", "true");
        } else if (w.uv !== null && w.uv >= 6) {
          msg = "☀️ " + where.district + "今天紫外線指數 " + w.uv + "，建議選擇此時段遮陰 ≥ 60% 的公園。";
        }
        $("#weather").textContent = msg ? msg + "（天氣：中央氣象署）" : "";
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
        weatherIfMoved();  // the weather needs a park nearby to know the district
        if (searchQ) runSearch();  // results can come from a region that just loaded
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
        weatherIfMoved();  // the weather needs a park nearby to know the district
        if (searchQ) runSearch();  // results can come from a region that just loaded
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
      var b = locateBtn = L.DomUtil.create("button", "locate", box);
      b.type = "button"; b.title = "回到我的位置"; b.setAttribute("aria-label", "回到我的位置");
      b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/>' +
        '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M12 1v3M12 20v3M1 12h3M20 12h3" stroke="currentColor" stroke-width="2"/></svg>';
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.on(b, "click", function () { locate(b); });
      return box;
    },
  });
  var locateBtn = null;
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
      setSort("near");  // located: nearest parks first (the user can switch back)
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
  fetch("api/reports").then(function (r) { return r.ok ? r.json() : {}; }).then(function (all) {
    reports = all || {};
    render();
  }).catch(function () {});
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
