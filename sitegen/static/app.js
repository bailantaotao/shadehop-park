(function () {
  "use strict";

  var SLOT_START = 6 * 60, SLOT_MIN = 30, SLOTS = 24, TZ = 8;
  var SHADOW_MIN_ZOOM = 16, MAX_SHADOW_M = 600;
  var PARK_HREF = window.SHADEHOP_PARK_HREF || "parks/{id}/";
  function parkHref(id) { return PARK_HREF.replace("{id}", encodeURIComponent(id)); }
  var filters = { rain: false, shade: false, parking: false, fast: false, slow: false, toilet: false, fav: false, confirmed: false };
  var Favs = window.ShadeHopFavs, I = window.ShadeHopIcon;
  var LIST_MAX = 60;
  var CHARGER_R = window.SHADEHOP_CHARGER_RADIUS_M || 500, PARKING_R = window.SHADEHOP_PARKING_RADIUS_M || 800;
  // Parks load per region as the map view reaches it; nobody has to pick a region first.
  var state = { date: null, slot: 8, user: null, features: [], playTimer: null, regions: [], loaded: {}, sort: "shade" };
  // Chargers are off until asked for (the map is about shade); the choice is remembered.
  var chargersOn = storeGet("shadehop.chargers") === "1";
  // Shadow casters are split into ~1 km tiles; only tiles in view are downloaded.
  var tiles = { index: null, deg: 0.01, data: {} };

  var $ = function (s) { return document.querySelector(s); };
  // Phones get a full-screen map with a bottom sheet (summary, list, filters, the tapped park).
  var phone = window.matchMedia("(max-width: 600px)");
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
  // The answer a parent wants, in words (colour alone fails colour-blind users and bright sun).
  function verdict(v) { return window.ShadeHopVerdict(v, state.slot); }
  function distM(a, b) {
    var r = Math.PI / 180, dl = (b[0] - a[0]) * r, dp = (b[1] - a[1]) * r;
    var h = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dl / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  }

  // ------------------------------------------------------------------ map
  // Canvas draws hundreds of markers much faster than SVG on old phones.
  // tolerance widens every marker's tap area by 12px (a 10px dot becomes a ~44px target).
  var map = L.map("map", { zoomControl: true, preferCanvas: true, renderer: L.canvas({ tolerance: 12 }) });
  map.createPane("chargers").style.zIndex = 650;
  map.createPane("near").style.zIndex = 660;  // a park's nearby places sit above the charger layer
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
    if (filters.parking && !(p.parking_display_m != null && p.parking_display_m <= 300)) return false;
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

  // For a 太曬 park: the nearest confirmed playground within 1.5 km that is shaded (or rain-proof) at
  // the selected time, and the first half-hour later today (08-17) when this park itself is shaded.
  function sunnyAlternatives(f) {
    var alt = null, altD = 1500;
    state.features.forEach(function (g) {
      if (g === f || unsure(g.properties)) return;
      var vg = shadeAt(g);
      if (!(g.properties.rain === true || (vg !== null && vg !== undefined && vg >= 0.6))) return;
      var d = distM(f.geometry.coordinates, g.geometry.coordinates);
      if (d < altD) { altD = d; alt = g; }
    });
    var row = f.properties.timetable[String(month())] || [], later = -1;
    for (var i = Math.max(state.slot + 1, 4); i < 22 && later < 0; i++) if (row[i] !== null && row[i] >= 0.6) later = i;
    var out = "";
    if (later >= 0) out += '<div class="pp-alt">' + I("sun") + slotLabel(later) + ' 後這裡會變陰涼 <button type="button" class="link" data-jump="' + later + '">跳到 ' + slotLabel(later) + "</button></div>";
    if (alt) out += '<div class="pp-alt">' + I("trees") + '附近較陰涼：<button type="button" class="link" data-goto="' + esc(alt.properties.id) + '">' +
      esc(alt.properties.name) + "</button> " + Math.round(altD) + "m</div>";
    return out;
  }

  function popupHtml(f) {
    // What a parent decides on at a glance: is it hot now, can we play in the rain, when is it
    // shadiest, are parking / toilets / chargers close. Everything else is on the park page.
    var p = f.properties, v = shadeAt(f), t = slotLabel(state.slot);
    var now = taipeiNow(), today = state.date === now.y + "-" + String(now.m).padStart(2, "0") + "-" + String(now.d).padStart(2, "0");
    var vd = verdict(v), shade = '<span class="pp-pill ' + vd.cls + '">' + t + " " + vd.text + "</span>";
    var rain = p.rain === true ? '<span class="pp-pill a">下雨可玩</span>'
      : p.rain === "partial" ? '<span class="pp-pill">部分可躲雨</span>' : '<span class="pp-pill">下雨不適合</span>';
    var best = bestDaytime((p.timetable || {})[String(month())] || []);
    // A tile shows those places around the park on this map (Google Maps frames a category search
    // its own way, never around the park); each place there opens Google Maps for that one spot.
    var tile = function (icon, label, m, kind) {
      var inner = "<span>" + icon + "</span>" + label + "<b>" + (m === null || m === undefined ? "—" : m + "m") + "</b>";
      return m !== null && m !== undefined
        ? '<button type="button" class="pp-tile" data-near="' + kind + '" data-park="' + esc(p.id) + '" aria-pressed="' +
          String(nearShown === p.id + "|" + kind) + '" title="在地圖上看附近的' + label + '">' + inner + "</button>"
        : '<div class="pp-tile">' + inner + "</div>";
    };
    var charge = p.fast_nearest_m !== null && p.fast_nearest_m !== undefined ? tile(I("bolt"), "快充", p.fast_nearest_m, "charge") : tile(I("plug"), "慢充", p.slow_nearest_m, "charge");
    return '<div class="pp">' +
      '<div class="pp-head"><div><div class="pp-name">' + esc(p.name) + '</div><div class="pp-sub">' + esc(p.district) +
      (reportNote(p) || (unsure(p) ? "・遊具待確認" : "")) + (p.indoor === true ? "・室內" : "") + "</div></div>" + Favs.button(p.id) + "</div>" +
      '<div class="pp-pills">' + shade + rain + "</div>" +
      '<div class="pp-best">' + (today ? "今天" : "這天") + "最陰涼：" +
      (best ? "<b>" + best.start + "–" + best.end + "</b>" : '<span class="muted">8–17 點沒有明顯遮陰時段，避開中午</span>') + "</div>" +
      (vd.cls === "lo" ? sunnyAlternatives(f) : "") +
      '<div class="pp-grid">' + tile(I("parking"), esc(p.parking_display_name || "停車"), p.parking_display_m, "parking") + tile(I("toilet"), "廁所", p.toilet_m, "toilet") +
      tile(I("store"), "超商", p.shop_m, "shop") + charge + "</div>" +
      // Most parents looking at this card are deciding whether to go: navigating is the main action.
      '<div class="pp-btns">' + (p.nav ? '<a class="pp-btn primary" href="' + esc(p.nav) + '" target="_blank" rel="noopener">導航</a>' : "") +
      '<a class="pp-btn' + (p.nav ? "" : " primary") + '" href="' + parkHref(p.id) + '">詳情</a>' +
      (p.gmaps ? '<a class="pp-btn" href="' + esc(p.gmaps) + '" target="_blank" rel="noopener">評論</a>' : "") +
      '<button type="button" class="pp-btn" data-share="' + esc(p.id) + '">分享</button>' +
      "</div></div>";
  }

  // Keep the popup clear of the zoom buttons (top left) and the charger toggle (top right), and never
  // wider than the map: on a 375px phone 280px plus that padding would push the close button off.
  function popupOptions() {
    // The popup box is about 31px wider than its content; 56px on the left clears the zoom/locate buttons.
    var w = map.getSize().x, max = Math.min(280, w - 100);
    return { className: "park-pop", minWidth: Math.min(240, max), maxWidth: max,
      autoPanPaddingTopLeft: L.point(56, 70), autoPanPaddingBottomRight: L.point(8, 24) };
  }

  var TICK_ZOOM = 14;
  var TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.5 4.5 8.5-9" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var tickMode = null;

  // The park the parent tapped grows and lifts (a copy of its marker drawn on top), so it is clear
  // what was hit and which dot the open card belongs to. Canvas dots cannot animate, hence the copy.
  var looks = {}, redrawing = false, popupSel = null, selMarker = null, selShown = null, selKey = null;
  function selectedId() {
    if (!phone.matches) return popupSel;
    var sp = document.getElementById("sheetPark");
    return sp && !sp.hidden ? state.selected : null;
  }
  function drawSel() {
    if (redrawing) return;
    var id = selectedId(), lk = id && looks[id];
    if (!lk) { if (selMarker) map.removeLayer(selMarker); selMarker = selShown = null; return; }
    var d, inner;
    if (lk.tick) { d = lk.size; inner = '<span class="' + lk.cls + '" style="width:' + d + 'px;height:' + d + 'px">' + TICK_SVG + "</span>"; }
    else {
      d = 2 * lk.r + lk.weight;
      inner = '<span class="sel-dot" style="width:' + d + "px;height:" + d + "px;background:" + lk.fill + ";border:" + lk.weight + "px solid " + lk.stroke + '"></span>';
    }
    var scale = lk.tick ? 1.5 : Math.max(1.7, 20 / d), box = Math.ceil(d * scale) + 12;
    var key = id + "|" + lk.ll + "|" + inner + scale;
    if (selMarker && selKey === key) return;  // unchanged: leave it, so a running pop is not cut short
    if (selMarker) map.removeLayer(selMarker);
    selKey = key;
    selMarker = L.marker(lk.ll, { interactive: false, keyboard: false, zIndexOffset: 3000, icon: L.divIcon({
      className: "mk-sel" + (selShown === id ? "" : " pop"), iconSize: [box, box], iconAnchor: [box / 2, box / 2],
      html: '<span class="mk-sel-in" style="--s:' + scale.toFixed(2) + '">' + inner + "</span>" }) }).addTo(map);
    selShown = id;
  }
  // True while a finger zooms the map (below): the view changes every frame, so the redraws wait for the end.
  var zoomGesture = false;
  map.on("zoomend", function () {
    if (zoomGesture) return;
    var t = map.getZoom() >= TICK_ZOOM;
    if (tickMode !== null && t !== tickMode) drawMarkers();
  });
  function drawMarkers() {
    // Redrawing replaces every marker, which would close an open popup; reopen it afterwards.
    var open = null;
    Object.keys(markers).forEach(function (id) { if (markers[id].isPopupOpen()) open = id; });
    redrawing = true;
    markerLayer.clearLayers();
    markers = {};
    looks = {};
    // Parks that suit the selected time stand out (a tick, drawn last so they sit on top); 太曬 parks
    // are a quiet ring, so a midday map of mostly
    // sunny parks is not a wall of red. Zoomed far out, ticks would be a heap of DOM icons: dots instead.
    var ticks = tickMode = map.getZoom() >= TICK_ZOOM;
    var ordered = state.features.filter(passes).map(function (f) {
      // Parks with unconfirmed equipment look like any other: parents read the map for shade. The card
      // still says 遊具待確認, and the 確定有遊戲場 filter hides them.
      var p = f.properties, cls = verdict(shadeAt(f)).cls;
      return { f: f, cls: cls, rank: cls === "hi" ? 5 : p.rain === true ? 3 : cls === "mid" ? 2 : 1 };
    }).sort(function (a, b) { return a.rank - b.rank; });
    ordered.forEach(function (o) {
      var f = o.f, p = f.properties, cls = o.cls, ll = [f.geometry.coordinates[1], f.geometry.coordinates[0]], m;
      var rain = p.rain === true;
      if (cls === "hi" && ticks) {
        var size = 26;
        m = L.marker(ll, { title: p.name, zIndexOffset: 1000, icon: L.divIcon({
          className: "mk-hi" + (rain ? " rain" : ""), html: TICK_SVG,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) });
        looks[p.id] = { ll: ll, tick: true, size: size, cls: "mk-hi" + (rain ? " rain" : "") };
      } else if (cls === "hi") {
        m = L.circleMarker(ll, { radius: 7, color: rain ? css("--a") : "#fff", weight: rain ? 3 : 1.5, fillColor: css("--hi"), fillOpacity: 1 });
      } else if (cls === "lo") {
        m = L.circleMarker(ll, { radius: rain ? 8 : 5, color: rain ? css("--a") : css("--lo"), weight: rain ? 3 : 1.5, fillColor: css("--surface"), fillOpacity: .9 });
      } else {
        // 還可以, 不太曬 (low sun) and night: a plain filled dot (the brown edge keeps the amber visible on light map areas).
        var mid = cls === "mid";
        m = L.circleMarker(ll, { radius: rain ? 9 : mid ? 7 : 6, color: rain ? css("--a") : mid ? "#6b5000" : css("--surface"),
          weight: rain ? 3 : 1.5, fillColor: css(cls === "night" ? "--muted" : "--" + cls), fillOpacity: cls === "night" ? .85 : 1 });
      }
      m.options.bubblingMouseEvents = false;  // a tap on a park is not a tap on the empty map
      if (!looks[p.id]) looks[p.id] = { ll: ll, r: m.options.radius, fill: m.options.fillColor, stroke: m.options.color, weight: m.options.weight };
      // Keep the popup clear of the zoom buttons (top left) and the charger toggle (top right) when it opens.
      if (phone.matches) m.on("click", function () { showPark(f); });
      else m.bindPopup(function () { return popupHtml(f); }, popupOptions());
      m.addTo(markerLayer);
      markers[p.id] = m;
    });
    if (open && markers[open]) markers[open].openPopup();
    redrawing = false;
    drawSel();
    if (phone.matches && state.selected && !$("#sheetPark").hidden) {
      var sel = state.features.find(function (x) { return x.properties.id === state.selected; });
      if (sel && passes(sel)) parkCard(sel);  // the selected time changed
      else { closePark(); setSheet("peek"); }  // a filter just hid it
    }
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
    label.innerHTML = evening
      ? I("moon") + "日落後，沒有直射陽光" + (t.down !== null ? "（這天日落約 " + hhmm(t.down) + "）" : "")
      : I("sunrise") + "日出前，還沒有直射陽光" + (t.up !== null ? "（這天日出約 " + hhmm(t.up) + "）" : "");
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

  var dupName = {};  // names shown more than once in the list get their district beside them
  function card(f) {
    var p = f.properties, v = shadeAt(f), row = p.timetable[String(month())] || [];
    var best = bestDaytime(row);
    var cells = row.map(function (x, i) {
      var vx = window.ShadeHopVerdict(x, i);
      return '<span class="' + vx.cls + (i === state.slot ? " cur" : "") + '" title="' + slotLabel(i) + " " + vx.text + '"></span>';
    }).join("");
    var dist = state.user ? " · 距離你 " + (distM(state.user, f.geometry.coordinates) / 1000).toFixed(1) + " km" : "";
    // The verdict for the selected time leads; the all-year grade is background, so it is a small note.
    var year = { B: "部分遮陽/樹蔭", C: "大樓陰影", none: "大多曝曬" }[p.level];
    return '<article class="card' + (state.selected === p.id ? " selected" : "") + '" data-park="' + esc(p.id) + '"><h3>' + Favs.button(p.id) + ' <a href="' + parkHref(p.id) + '">' + esc(p.name) + "</a>" +
      (dupName[p.name] > 1 && p.district ? '<span class="h-district">' + esc(p.district) + "</span>" : "") + "</h3>" +
      '<div class="badges"><span class="badge v-' + verdict(v).cls + '">' + slotLabel(state.slot) + " " + verdict(v).text + "</span>" +
      (p.level === "A" ? '<span class="badge A">' + I("umbrella") + "下雨可玩</span>" : "") +
      (reportNote(p) ? '<span class="badge">' + reportNote(p).slice(1) + "</span>" : unsure(p) ? '<span class="badge">遊戲設施待確認</span>' : "") + (p.indoor === true ? '<span class="badge">室內</span>' : p.indoor === "possible" ? '<span class="badge">可能室內/中庭</span>' : "") +
      (year ? '<span class="year">全年：' + year + "</span>" : "") + "</div>" +
      '<div class="timeline" role="img" aria-label="' + esc(state.date.slice(5).replace("-", "/") + " 遮陰：" + window.ShadeHopStripText(row)) + '">' + cells +
      '</div><div class="tl-axis" aria-hidden="true"><span>6</span><span>9</span><span>12</span><span>15</span><span>18</span></div>' +
      '<div class="facts">' +
      (best ? '<span>最陰涼：' + best.start + "–" + best.end + ' <button class="link" data-jump="' + best.start_slot + '">跳到這個時間</button></span>' : "<span>8–17 點沒有明顯遮陰時段</span>") +
      "<span>" + I("parking") + (p.parking_display_name ? esc(p.parking_display_name) + " " + p.parking_display_m + "m" : PARKING_R + "m 內未標示停車場") + "</span>" +
      "<span>" + I("bolt") + (p.fast_nearest_m !== null ? "快充 " + p.fast_nearest_m + "m" : CHARGER_R + "m 內沒有快充") + " · " + I("plug") + (p.slow_nearest_m !== null ? "慢充 " + p.slow_nearest_m + "m" : CHARGER_R + "m 內沒有慢充") + "</span>" +
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
    $("#count").textContent = filters.fav ? "我的最愛（" + fs.length + "）"
      : (fs.length ? "這個範圍有 " + fs.length + " 座公園" : "這個範圍沒有符合的公園") + "（" + state.date.slice(5).replace("-", "/") + " " + slotLabel(state.slot) + "）";
    dupName = {};
    fs.slice(0, LIST_MAX).forEach(function (f) { dupName[f.properties.name] = (dupName[f.properties.name] || 0) + 1; });
    var html = fs.slice(0, LIST_MAX).map(card).join("");
    if (fs.length > LIST_MAX) html += '<p class="muted">還有 ' + (fs.length - LIST_MAX) + " 處，放大地圖可以縮小範圍。</p>";
    if (!fs.length && filters.fav) {
      html = '<p class="muted">還沒有收藏的公園。點公園名稱旁的星號就能加入；收藏只存在這個瀏覽器裡，不需要登入。</p>';
    } else if (!fs.length) {
      var covered = state.regions.some(function (r) { return regionInView(r); });
      html = covered ? emptyHelp()
        : '<p class="muted">這個範圍還沒有資料。目前收錄：' + state.regions.map(function (r) { return r.city + (r.name !== r.city ? r.name : ""); }).join("、") + "。</p>";
    }
    $("#list").innerHTML = html;
    updateSummary(fs);
    var anyFilter = Object.keys(filters).some(function (k) { return filters[k] && k !== "fav"; });
    mapEmpty(!fs.length && anyFilter && !filters.fav && state.regions.some(function (r) { return regionInView(r); }));
  }

  // No park in view matches: say which filters are on (each removable), when shade comes back, and
  // the nearest match outside the view.
  var FILTER_LABEL = { rain: "下雨可玩", shade: "這個時間有遮陰", confirmed: "確定有遊戲場", fav: "我的最愛", parking: "停車 ≤ 300m",
    fast: CHARGER_R + "m 內有快充", slow: CHARGER_R + "m 內有慢充", toilet: "附近有廁所" };
  // Next half-hour today with shade for some park in view (other filters kept), or -1.
  function nextShadeSlot() {
    var keep = state.slot, found = -1;
    for (var i = state.slot + 1; i < SLOTS && found < 0; i++) {
      state.slot = i;
      var n = state.features.filter(function (f) { return inView(f) && passes(f); }).length;
      if (n) found = i;
    }
    state.slot = keep;
    return found;
  }
  function mapEmpty(show) {
    var el = map.getContainer().querySelector(".map-empty");
    if (!show) { if (el) el.hidden = true; return; }
    if (!el) {
      el = L.DomUtil.create("div", "map-empty", map.getContainer()); el.setAttribute("role", "status");
      L.DomEvent.disableClickPropagation(el);  // a tap here is not a tap on the map
      el.addEventListener("click", function (e) {
        var j = e.target.closest("[data-jump]"), c = e.target.closest("[data-clear]"), g = e.target.closest("[data-goto]");
        if (j) { state.slot = Number(j.dataset.jump); $("#slot").value = state.slot; atNow = false; render(); }
        if (c) clearFilter("all");
        if (g) focusPark(g.dataset.goto);
      });
    }
    var next = filters.shade ? nextShadeSlot() : -1;
    var near = nearestMatch();
    el.innerHTML = "沒有符合條件的公園" + (next >= 0 ? '・<button type="button" class="link" data-jump="' + next + '">' + slotLabel(next) + " 起有遮陰</button>" : "") +
      (near ? '・<button type="button" class="link" data-goto="' + esc(near.f.properties.id) + '">最近：' + esc(near.f.properties.name) + " " + kmLabel(near.d) + "</button>" : "") +
      '・<button type="button" class="link" data-clear="all">取消篩選</button>';
    el.hidden = false;
  }

  function emptyHelp() {
    var on = Object.keys(filters).filter(function (k) { return filters[k]; });
    var out = '<div class="empty"><p><b>這個範圍沒有符合條件的公園。</b></p>';
    if (on.length) {
      out += '<p class="empty-filters">目前條件：' + on.map(function (k) {
        return '<button type="button" class="chip on" data-clear="' + k + '" aria-label="取消「' + FILTER_LABEL[k] + '」">' + FILTER_LABEL[k] + " ✕</button>";
      }).join("") + (on.length > 1 ? '<button type="button" class="link" data-clear="all">全部取消</button>' : "") + "</p>";
    }
    var next = filters.shade ? nextShadeSlot() : -1;
    if (next >= 0) {
      var keep = state.slot; state.slot = next;
      var n = state.features.filter(function (f) { return inView(f) && passes(f); }).length;
      state.slot = keep;
      out += '<p>' + slotLabel(next) + " 起有 " + n + ' 座有遮陰。<button type="button" class="link" data-jump="' + next + '">跳到 ' + slotLabel(next) + "</button></p>";
    }
    var near = nearestMatch();
    if (near) {
      out += '<p>畫面外最近的：<button type="button" class="link" data-goto="' + esc(near.f.properties.id) + '">' +
        esc(near.f.properties.name) + "（" + kmLabel(near.d) + "）</button></p>";
    }
    return out + "</div>";
  }
  // The closest park that passes the filters, measured from the user (if located) or the map centre.
  function nearestMatch() {
    var c = map.getCenter(), ref = state.user || [c.lng, c.lat], best = null, bestD = Infinity;
    state.features.forEach(function (f) {
      if (!passes(f)) return;
      var d = distM(ref, f.geometry.coordinates);
      if (d < bestD) { bestD = d; best = f; }
    });
    return best ? { f: best, d: bestD } : null;
  }
  function kmLabel(d) { return d < 1000 ? Math.round(d) + "m" : (d / 1000).toFixed(1) + " km"; }
  function clearFilter(k) {
    Object.keys(filters).forEach(function (x) {
      if (k !== "all" && x !== k) return;
      filters[x] = false;
      var b = document.querySelector('[data-filter="' + x + '"]');
      if (b) b.setAttribute("aria-pressed", "false");
    });
    syncMore();
    render();
  }

  // Coalesce redraws to one per animation frame, so dragging the time slider stays smooth on slow phones.
  // Moving the map only changes the list and shadows (markers do not depend on the view).
  var pending = null;
  function render(viewOnly) {
    $("#slotOut").textContent = slotLabel(state.slot);
    if (state.date) dateLabel();
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
    var early = t.min < SLOT_START, late = t.min >= SLOT_START + SLOTS * SLOT_MIN;
    atNow = !(early || late);
  }
  var atNow = true;  // any manual time change leaves "now"

  $("#slot").addEventListener("input", function (e) { state.slot = Number(e.target.value); atNow = false; render(); });
  $("#date").addEventListener("change", function (e) { if (e.target.value) { state.date = e.target.value; atNow = false; render(); } });
  $("#nowBtn").addEventListener("click", function () { setNow(); render(); });
  $("#playBtn").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; btn.setAttribute("aria-pressed", "false"); btn.innerHTML = I("play") + '<span class="lbl">播放一天</span>'; return; }
    btn.setAttribute("aria-pressed", "true"); btn.innerHTML = I("pause") + '<span class="lbl">暫停</span>';
    state.playTimer = setInterval(function () {
      state.slot = (state.slot + 1) % SLOTS; $("#slot").value = state.slot; render();
    }, 700);
  });
  document.querySelectorAll("[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.dataset.filter; filters[k] = !filters[k];
      b.setAttribute("aria-pressed", String(filters[k]));
      if (k === "fav" && filters[k]) loadAllRegions();  // favourites can be in any region
      if ((k === "fast" || k === "slow") && filters[k] && !chargersOn) setChargers(true);  // show what the filter is about
      syncMore();
      render();
    });
  });
  // Secondary filters live behind "更多條件"; the button counts the ones that are on while hidden.
  var moreBtn = $("#moreBtn"), moreBox = $("#moreFilters");
  function syncMore() {
    var n = moreBox.querySelectorAll('[aria-pressed="true"]').length;
    moreBtn.querySelector(".n").textContent = n ? "（" + n + "）" : "";
    var all = Object.keys(filters).filter(function (k) { return filters[k] && k !== "fav"; }).length;
    $("#filterBtn .n").textContent = all ? "（" + all + "）" : "";
  }
  moreBtn.addEventListener("click", function () {
    var open = moreBtn.getAttribute("aria-expanded") !== "true";
    moreBtn.setAttribute("aria-expanded", String(open));
    moreBox.hidden = !open;
  });
  function setSort(mode) {
    state.sort = mode;
    document.querySelectorAll("[data-sort]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.sort === mode)); });
    $("#sortNote").textContent = mode === "near" ? "依離你的直線距離排序" : "推薦順序：下雨可玩 → 確定有遊戲場 → 此時遮陰多";
    render(true);
  }
  document.querySelectorAll("[data-sort]").forEach(function (b) {
    b.addEventListener("click", function () {
      // "Nearest" needs the user's position; ask for it the first time.
      if (b.dataset.sort === "near" && !state.user) { if (locateBtn) locate(locateBtn); return; }
      setSort(b.dataset.sort);
    });
  });
  // ------------------------------------------------------- nearby places
  // 停車 / 廁所 / 超商 / 充電 on a park card: those places around the park, the park in the middle.
  var nearLayer = L.layerGroup().addTo(map), nearShown = null, parkCache = {};
  var NEAR = {
    parking: { label: "停車場", icon: "parking" }, toilet: { label: "公廁", icon: "toilet" },
    shop: { label: "便利商店", icon: "store" }, charge: { label: "充電站", icon: "bolt" },
  };
  function parkDetail(id) {
    if (!parkCache[id]) parkCache[id] = fetch("api/parks/" + encodeURIComponent(id) + ".json").then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).catch(function (e) { delete parkCache[id]; throw e; });
    return parkCache[id];
  }
  function nearPlaces(d, kind) {
    var a = d.amenities || {}, one = function (x) { return x && x.value && x.location ? [x] : []; };
    if (kind === "parking") return (d.parking || []).slice().sort(function (a, b) { return a.display_rank - b.display_rank; }).slice(0, 5);
    if (kind === "charge") return d.chargers || [];
    if (kind === "toilet") return one(a.toilet);
    return one(a.convenience_store);
  }
  function placeName(x, kind) {
    if (kind === "parking" && x.display_name) return x.display_name;
    var n = (x.name || "").trim();
    return n && n !== x.kind_label ? n : NEAR[kind].label;
  }
  function placeLink(x, kind, area) {
    // A named place: Google's own listing for it (name and area find that very spot).
    var ll = x.location.lat + "," + x.location.lng;
    return "https://maps.google.com/maps?q=" + encodeURIComponent(placeName(x, kind) + " " + area) + "&ll=" + ll + "&sll=" + ll + "&z=18";
  }
  function placeRoute(x, kind, area) {
    // Directions straight to it. A nameless lot or toilet goes by its coordinates: searching just
    // "停車場" made the Google Maps app list the lots around the phone instead of this one.
    var named = placeName(x, kind) !== NEAR[kind].label;
    return "https://www.google.com/maps/dir/?api=1&destination=" +
      encodeURIComponent(named ? placeName(x, kind) + " " + ((x.official || {}).address || area) : x.location.lat + "," + x.location.lng);
  }
  // Bottom edge (in map pixels) of what floats over the top of the map: the chips and the night/weather note.
  function overlayBottom() {
    var top = map.getContainer().getBoundingClientRect().top, b = $(".controls").getBoundingClientRect().bottom;
    var w = document.getElementById("weather");
    if (w && w.offsetParent && w.textContent.trim()) b = Math.max(b, w.getBoundingClientRect().bottom);
    return Math.max(0, b - top);
  }
  function clearNear() {
    nearLayer.clearLayers();
    if (!nearShown) return;
    nearShown = null;
    document.querySelectorAll("[data-near][aria-pressed=true]").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
  }
  // A tile expands its kind to every place nearby; tapping it again goes back to the overview.
  function showNear(btn) {
    var id = btn.dataset.park, kind = btn.dataset.near;
    if (nearShown === id + "|" + kind) { phone.matches ? nearFor(id, "all", { fit: false }) : clearNear(); return; }
    btn.classList.add("busy");
    nearFor(id, kind, { fit: true }).then(function () { btn.classList.remove("busy"); });
  }
  // kind "all": the nearest parking, toilet, shop and charger, shown as soon as a park is tapped on a
  // phone (where to park and where the toilet is are the next questions); a kind: all of that kind.
  function nearFor(id, kind, opt) {
    var f = state.features.find(function (x) { return x.properties.id === id; });
    if (!f) return Promise.resolve();
    return parkDetail(id).then(function (d) {
      if (kind === "all" ? state.selected !== id : false) return;  // the parent moved on meanwhile
      clearNear();
      var items = [];
      (kind === "all" ? ["parking", "toilet", "shop", "charge"] : [kind]).forEach(function (k) {
        var list = nearPlaces(d, k), picked;
        var fast = k === "charge" ? list.filter(function (x) { return x.speed === "fast" || x.speed === "both"; }) : [];
        if (kind === "all") picked = (fast.length ? fast : list).slice(0, 1);  // the charger its tile names: nearest fast first
        else {
          picked = list.slice(0, 6);
          if (fast.length && picked.indexOf(fast[0]) < 0) picked.push(fast[0]);  // keep the tile's 快充 in the list
        }
        picked.forEach(function (x) { items.push({ x: x, k: k }); });
      });
      if (!items.length) { if (kind !== "all") mapToast("附近沒有" + NEAR[kind].label + "的資料"); return; }
      nearShown = id + "|" + kind;
      if (kind !== "all") document.querySelectorAll('[data-near="' + kind + '"][data-park="' + CSS.escape(id) + '"]').forEach(function (b) { b.setAttribute("aria-pressed", "true"); });
      var c = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]), area = d.region ? d.region.city + (d.region.district !== d.region.city ? d.region.district : "") : "";
      var pts = [c];
      items.forEach(function (it) {
        var x = it.x, k = it.k, ll = L.latLng(x.location.lat, x.location.lng), fast = x.speed === "fast" || x.speed === "both";
        var icon = k === "charge" ? (fast ? "bolt" : "plug") : NEAR[k].icon;
        // Mirror each place through the park too, so fitting the box keeps the park in the middle.
        pts.push(ll, L.latLng(2 * c.lat - ll.lat, 2 * c.lng - ll.lng));
        var sub = k === "charge" ? (x.speed_label || "") : k === "parking" && x.fee ? ({ yes: "收費", no: "免費" }[x.fee] || "") : "";
        var off = x.official || {};  // the city's registered name, fare and hours for this lot
        var more = (off.fare ? '<span class="near-fact">' + esc(off.fare.length > 70 ? off.fare.slice(0, 70) + "…" : off.fare) + "</span>" : "") +
          (off.hours ? '<span class="near-fact">開放：' + esc(off.hours) + "</span>" : "");
        L.marker(ll, { pane: "near", keyboard: true, title: placeName(x, k), icon: L.divIcon({ className: "near-mk " + k + (fast ? " fast" : ""),
          html: '<span class="near-in">' + I(icon) + "<b>" + x.distance_m + "m</b></span>", iconSize: [0, 0], iconAnchor: [0, 0] }) })
          .bindPopup('<div class="near-pop"><strong>' + esc(placeName(x, k)) + "</strong>" +
            '<span class="muted">離公園 ' + x.distance_m + "m（直線）" + (sub ? "・" + esc(sub) : "") + "</span>" +
            more +
            (k === "parking" ? '<span class="near-fact">' + ({ taipei: "臺北市停車管理工程處", newtaipei: "新北市政府交通局", tdx: "交通部 TDX" }[off.source] || "OpenStreetMap") + (off.address ? "・" + esc(off.address) : "") + '</span>' : "") +
            '<div class="near-btns">' + (k === "parking" && (!x.display_name || x.display_name === "未具名停車點") ?
              '<span class="near-fact">車輛入口待確認</span><a class="pp-btn" href="' + esc(placeLink({ name: d.name + " 附近停車場", location: x.location }, k, area)) + '" target="_blank" rel="noopener">搜尋公園附近停車場</a>' :
              '<a class="pp-btn primary" href="' + esc(placeRoute(x, k, area)) + '" target="_blank" rel="noopener">導航</a>' +
              (placeName(x, k) !== NEAR[k].label ? '<a class="pp-btn" href="' + esc(placeLink(x, k, area)) + '" target="_blank" rel="noopener">在 Google 地圖查看</a>' : "")) +
            "</div></div>",
            { className: "near-popup", closeButton: false, autoPanPaddingTopLeft: L.point(16, overlayBottom() + 12),
              autoPanPaddingBottomRight: L.point(16, phone.matches ? sheetMetrics().half + 16 : 16) })
          .addTo(nearLayer);
      });
      // Fit them into the strip of map the floating chips and the sheet leave open. The overview only
      // zooms out when a place would be off screen; it never zooms in past where the park put it.
      var mapBox = map.getContainer().getBoundingClientRect();
      var top = $(".controls").getBoundingClientRect().bottom - mapBox.top + 24;
      var bottom = phone.matches ? mapBox.bottom - (window.innerHeight - sheetMetrics().half) + 24 : 40;
      var b = L.latLngBounds(pts), pad = { paddingTopLeft: [40, Math.max(40, top)], paddingBottomRight: [70, Math.max(40, bottom)] };
      if (opt.fit) { pad.maxZoom = 18; map.fitBounds(b, pad); return; }
      // Measure against where the park's zoom-in lands, not a frame of its animation.
      var check = function () {
        var z = map.getBoundsZoom(b, false, L.point(110, Math.max(40, top) + Math.max(40, bottom)));
        if (z < map.getZoom()) centreOn(c, Math.floor(z));
      };
      if (map._animatingZoom) map.once("zoomend", check); else check();
    }, function () {
      if (kind !== "all") mapToast("暫時載入不到附近設施，請稍後再試");
    });
  }

  // ---------------------------------------------------------------- search
  // By city, park name or district, across all regions (they load on the first keystroke).
  var cardFromSearch = false;
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
    // A city name ('新竹') jumps to the whole region; its districts rarely contain it.
    var html = state.regions.filter(function (r) { return norm(r.city).indexOf(q) >= 0 || norm(r.label).indexOf(q) >= 0; }).map(function (r) {
      return '<li role="option" tabindex="-1" data-region="' + esc(r.id) + '">' + I("pin") + "前往 " + esc(r.city) +
        ' <span class="muted">（' + r.parks + " 處）</span></li>";
    }).join("");
    html += Object.keys(districts).slice(0, 2).map(function (k) {
      var d = districts[k], r = state.regions.find(function (x) { return x.id === d.region; });
      return '<li role="option" tabindex="-1" data-district="' + esc(k) + '">' + I("pin") + "前往 " + esc((r ? r.city : "") + d.district) +
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
      // Its region may have loaded a moment ago, before the next redraw placed its marker.
      if (f && !markers[li.dataset.id] && passes(f)) drawMarkers();
      if (f && !markers[li.dataset.id]) mapToast("這座公園不符合目前的篩選條件，先幫你移過去");
      if (f) {
        map.setView([f.geometry.coordinates[1], f.geometry.coordinates[0]], 17);
        cardFromSearch = true;  // its ✕ comes back to these results
        if (markers[li.dataset.id]) focusPark(li.dataset.id);
        cardFromSearch = false;
      }
    } else if (li.dataset.region) {
      var r = state.regions.find(function (x) { return x.id === li.dataset.region; });
      if (r) map.fitBounds(regionBounds(r));
      document.getElementById("map").scrollIntoView({ behavior: "smooth" });
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
    leaveSearch(!!(li.dataset.id && markers[li.dataset.id]));
  }
  // Phones: the field sits in the bottom sheet, read-only until tapped. A tap first opens the sheet
  // to full height (no animation) so the field is already at the top, then focuses it inside the
  // same gesture: iOS then has nothing to scroll into view above the keyboard (it used to push the
  // whole page up and the field out of sight).
  var searching = false, searchFrom = "peek";
  function endSearch() {
    searching = false;
    sheet.classList.remove("searching"); document.body.classList.remove("searching");
    searchEl.readOnly = phone.matches;
    $("#searchCancel").hidden = true;
    resultsEl.hidden = true; searchEl.setAttribute("aria-expanded", "false");
    searchEl.blur();
  }
  // iOS Safari does not fire "click" for the first tap on a read-only field, so start on touchend
  // (still a user gesture, so the keyboard opens); "click" covers mouse and other browsers.
  function startSearch(e) {
    if (!phone.matches || searching) return;
    e.preventDefault();
    searchFrom = sheetState;
    openSearch(true);
  }
  // focus=false: back from a park chosen in the results; the results come back without the keyboard.
  function openSearch(focus) {
    searching = true;
    closePark(); closeFilters();
    sheet.classList.add("searching"); document.body.classList.add("searching");
    sheet.style.transition = "none"; setSheet("full"); void sheet.offsetHeight; sheet.style.transition = "";
    $("#searchCancel").hidden = false;
    searchEl.readOnly = false;
    if (focus) { searchEl.blur(); searchEl.focus(); }
    if (searchQ) { searchEl.value = searchQ; runSearch(); }
  }
  searchEl.addEventListener("touchend", startSearch, { passive: false });
  searchEl.addEventListener("click", startSearch);
  searchEl.addEventListener("focus", function () {
    if (phone.matches) requestAnimationFrame(function () { window.scrollTo(0, 0); });
  });
  function leaveSearch(toPark) {
    if (!searching) return;
    endSearch();
    if (!toPark) setSheet(searchFrom === "full" ? "half" : searchFrom);
  }
  $("#searchCancel").addEventListener("click", function () { searchEl.value = ""; searchQ = ""; leaveSearch(false); });
  if (window.visualViewport) visualViewport.addEventListener("resize", function () {
    document.documentElement.style.setProperty("--vvh", visualViewport.height + "px");
  });
  var searchTimer = null;
  searchEl.addEventListener("input", function () {
    searchQ = searchEl.value.trim();
    loadAllRegions();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  searchEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); chooseResult(resultsEl.querySelector("li[tabindex]")); }
    if (e.key === "Escape") { resultsEl.hidden = true; searchEl.setAttribute("aria-expanded", "false"); leaveSearch(false); }
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
    if (phone.matches && searching) return;  // the phone search screen keeps its results until it closes
    if (!e.target.closest(".search")) { resultsEl.hidden = true; searchEl.setAttribute("aria-expanded", "false"); }
  });

  // Show a park on the map: centre it, open its popup, mark its card, and bring the map into view.
  function focusPark(id) {
    var m = markers[id];
    if (!m) return;
    state.selected = id;
    if (phone.matches) {  // showPark zooms in and centres it above the sheet
      showPark(state.features.find(function (x) { return x.properties.id === id; }));
      return;
    }
    // Open the popup once the map has stopped moving: Leaflet skips its auto-pan during a zoom
    // animation, which left the popup under the zoom/locate buttons on phones.
    var open = function () { if (markers[id]) markers[id].openPopup(); };
    var z = Math.max(map.getZoom(), 17), ll = m.getLatLng();
    if (map.getZoom() === z && map.getCenter().distanceTo(ll) < 1) open();
    else { map.once("moveend", open); map.setView(ll, z); }
    var box = document.getElementById("map").getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) document.getElementById("map").scrollIntoView({ behavior: "smooth" });
    render(true);
  }

  $("#list").addEventListener("click", function (e) {
    var clr = e.target.closest("[data-clear]"), go = e.target.closest("[data-goto]");
    if (clr) { clearFilter(clr.dataset.clear); return; }
    if (go) { var g = state.features.find(function (x) { return x.properties.id === go.dataset.goto; });
      if (g) { map.setView([g.geometry.coordinates[1], g.geometry.coordinates[0]], 16); setTimeout(function () { focusPark(go.dataset.goto); }, 400); }
      return; }
    var j = e.target.closest("[data-jump]"), f = e.target.closest("[data-focus]");
    if (j) { state.slot = Number(j.dataset.jump); $("#slot").value = state.slot; atNow = false; render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (f) { focusPark(f.dataset.focus); return; }
    // Anywhere else on a card (not its name link, star or other buttons) also shows it on the map.
    var card = e.target.closest("[data-park]");
    if (card && !e.target.closest("a, button, input")) focusPark(card.dataset.park);
  });
  map.on("moveend", function () {
    if (zoomGesture) return;  // every frame of a one-finger zoom: thousands of markers redrawn 60 times a second froze phones
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
        var rainy = w.pop !== null && w.pop >= 60, msg = "", ico = "", undo = "";
        if (rainy) {
          ico = "rain"; msg = where.district + "未來 3 小時降雨機率 " + w.pop + "%" + (w.weather ? "（" + w.weather + "）" : "") + "，已幫你開啟「下雨可玩」。";
          if (!filters.rain) {
            filters.rain = true; document.querySelector('[data-filter="rain"]').setAttribute("aria-pressed", "true");
            undo = '<button type="button" class="link" data-clear="rain">不用，顯示全部</button>';
          }
        } else if (w.uv !== null && w.uv >= 6) {
          ico = "sun"; msg = where.district + "今天紫外線指數 " + w.uv + "，挑標示「適合」的公園比較不會曬。";
        }
        $("#weather").innerHTML = msg ? I(ico) + esc(msg + "（天氣：中央氣象署）") + (undo ? " " + undo : "") : "";
        render();
      }).catch(function () {
        $("#weather").textContent = "暫時查不到天氣，這次沒有降雨和紫外線提醒。";
      });
  }


  $("#weather").addEventListener("click", function (e) {
    var b = e.target.closest("[data-clear]");
    if (b) { clearFilter(b.dataset.clear); b.remove(); }
  });

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

  // Floating notes would cover an open popup; step aside while one is open.
  map.on("popupopen", function (e) {
    map.getContainer().classList.add("popup-open");
    var src = e.popup._source;
    if (nearLayer.hasLayer(src)) return;  // a nearby place's popup: the park stays selected
    popupSel = Object.keys(markers).find(function (id) { return markers[id] === src; }) || null;
    if (popupSel && nearShown && nearShown.split("|")[0] !== popupSel) clearNear();
    drawSel();
  });
  map.on("popupclose", function (e) {
    map.getContainer().classList.remove("popup-open");
    if (redrawing) return;  // drawMarkers reopens it straight away
    if (nearLayer.hasLayer(e.popup._source)) return;
    if (nearShown) return;  // the park's popup gave way to a nearby place's: keep the park marked
    popupSel = null;
    drawSel();
  });

  // Leaflet popups stop click propagation, so stars inside them need their own handler.
  map.on("popupopen", function (e) {
    e.popup.getElement().querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.preventDefault(); focusPark(b.dataset.goto); });
    });
    e.popup.getElement().querySelectorAll("[data-jump]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.preventDefault(); state.slot = Number(b.dataset.jump); $("#slot").value = state.slot; atNow = false; render();
      });
    });
    e.popup.getElement().querySelectorAll("[data-near]").forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.preventDefault(); showNear(b); });
    });
    e.popup.getElement().querySelectorAll("[data-fav]").forEach(function (b) {
      b.addEventListener("click", function (ev) { ev.preventDefault(); Favs.toggle(b.dataset.fav); });
    });
  });

  // 分享 on a park card: the system share sheet on phones (LINE, Messages...), else copy the link.
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-share]");
    if (!b) return;
    e.preventDefault();
    var f = state.features.find(function (x) { return x.properties.id === b.dataset.share; });
    if (!f) return;
    var p = f.properties, url = new URL(parkHref(p.id), location.href).href;
    var text = p.name + "：" + (p.share || "");
    if (navigator.share) navigator.share({ title: p.name + "（" + p.district + "）幾點去不曬？", text: text, url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text + " " + url).then(function () { mapToast("已複製連結，可以貼給朋友"); }, function () {});
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
    // First visit: five cities at once is too far out to answer anything. If location is already
    // allowed, go there; otherwise ask where to start (the overview stays behind the card).
    var ask = function () { showStart(true); };
    if (navigator.permissions && navigator.permissions.query && locateBtn) {
      navigator.permissions.query({ name: "geolocation" }).then(function (p) {
        if (p.state === "granted") locate(locateBtn, function (ok) { if (!ok) ask(); }); else ask();
      }, ask);
    } else ask();
  }

  // ---------------------------------------------------------- first visit
  var START_ZOOM = 15;
  var startEl = $("#mapStart");
  map.getContainer().appendChild(startEl);
  L.DomEvent.disableClickPropagation(startEl);
  L.DomEvent.disableScrollPropagation(startEl);
  function startOpen() { return !!startEl && !startEl.hidden; }
  function showStart(on) {
    startEl.hidden = !on;
    document.body.classList.toggle("start-open", on);
    if (on) $("#startLocate").focus({ preventScroll: true });
    updateSummary(state.features.filter(function (f) { return inView(f) && passes(f); }));
  }
  $("#startLocate").addEventListener("click", function () {
    var b = this;
    b.classList.add("busy"); b.querySelector("span").textContent = "定位中…";
    locate(locateBtn, function (ok) {
      b.classList.remove("busy"); b.querySelector("span").textContent = "用我的位置";
      if (ok) showStart(false);
    });
  });
  startEl.querySelectorAll("[data-start]").forEach(function (b) {
    b.addEventListener("click", function () {
      var ll = b.dataset.start.split(",").map(Number);
      showStart(false);
      map.setView(ll, START_ZOOM);
    });
  });
  $("#startSkip").addEventListener("click", function () { showStart(false); });
  // Moving the map by hand answers the question too.
  map.on("dragstart", function () { if (startOpen()) showStart(false); });

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
      '<a href="https://maps.google.com/maps?q=' + encodeURIComponent(p.name) + "&ll=" + f.geometry.coordinates[1] + "," + f.geometry.coordinates[0] + "&sll=" + f.geometry.coordinates[1] + "," + f.geometry.coordinates[0] + '&z=18" rel="noopener" target="_blank">在 Google 地圖查看</a> · ' +
      (p.source === "tdx" ? '<span class="small">資料介接「交通部TDX平臺」</span>'
        : '<a href="' + esc(p.osm) + '" rel="noopener" target="_blank">OpenStreetMap 資料</a>');
  }

  // Phones: the same facts as a card in the sheet, laid out like the park card.
  function chargerCard(f) {
    var p = f.properties, ll = f.geometry.coordinates[1] + "," + f.geometry.coordinates[0];
    var fast = p.speed === "fast" || p.speed === "both", slow = p.speed === "slow";
    var note = p.speed_source === "brand" ? "依營運商判斷" : p.speed_source === "name" ? "依站名判斷" : "";
    var speed = p.speed === "unknown" ? "快慢充未標示" : p.speed_label.replace(/（.*）$/, "");
    var pill = '<span class="pp-pill chg-pill ' + (fast ? "fast" : slow ? "slow" : "") + '">' + (fast ? BOLT_SVG : slow ? PLUG_SVG : "") +
      esc(speed) + (p.max_kw ? "・最高 " + p.max_kw + " kW" : "") + "</span>";
    var rows = [["插頭", p.sockets.length ? p.sockets.join("、") : ""], ["充電車位", p.capacity], ["充電費率", p.charging_rate],
      ["停車費率", p.parking_rate], ["時間", p.opening_hours], ["樓層", p.floors], ["限制", p.restriction]]
      .filter(function (r) { return r[1]; })
      .map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + esc(String(r[1])) + "</dd>"; }).join("");
    var head = '<div class="pp-head"><div><div class="pp-name">' + esc(p.name) + '</div><div class="pp-sub">' +
      esc(p.operator || "充電站") + "</div></div></div>";
    var body = '<div class="pp">' + '<div class="pp-pills">' + pill + (note ? '<span class="pp-pill">' + note + "</span>" : "") + "</div>" +
      (rows ? '<dl class="chg-dl">' + rows + "</dl>" : '<p class="muted chg-none">OSM 沒有標示插頭、費率或時間</p>') +
      '<div class="pp-btns"><a class="pp-btn primary" href="https://maps.google.com/maps?q=' + encodeURIComponent(p.name) + "&ll=" + ll + "&sll=" + ll +
      '&z=18" target="_blank" rel="noopener">在 Google 地圖查看</a></div>' +
      '<p class="pp-src">' + (p.source === "tdx" ? "資料介接「交通部TDX平臺」"
        : '<a href="' + esc(p.osm) + '" rel="noopener" target="_blank">OpenStreetMap 資料</a>') + "</p></div>";
    return { head: head, body: body };
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
      m.options.bubblingMouseEvents = false;
      if (phone.matches) m.on("click", function () { showCharger(f); });
      else m.bindPopup(function () { return chargerPopup(f); });
      m.addTo(chargerLayer);
    });
  }
  map.on("zoomend", function () {
    if (zoomGesture) return;
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
  function locate(b, done) {
    done = done || function () {};
    if (!navigator.geolocation) { mapToast("這個瀏覽器不支援定位"); done(false); return; }
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
      done(true);
    }, function (err) {
      b.classList.remove("busy");
      done(false);
      mapToast(err.code === 1 ? "沒有定位權限：請在瀏覽器設定允許這個網站使用位置" : "暫時無法取得位置，請稍後再試");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }
  var locateCtl = new LocateControl();
  map.addControl(locateCtl);

  // One charger toggle on the map (like an EV map app), with the number of stations in view.
  var BOLT = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M13.5 1.5 4 13.5h6.5L9 22.5l10-12.5h-6.6z"/></svg>';
  var ChargerControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "map-ctl chg-ctl");
      var b = L.DomUtil.create("button", "chg-btn", box);
      b.type = "button"; b.setAttribute("aria-label", "地圖上顯示充電站");
      b.setAttribute("aria-pressed", String(chargersOn));
      b.innerHTML = BOLT + '<span class="n"></span>';
      L.DomEvent.on(b, "click", function () { setChargers(!chargersOn); });
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  var chargerCtl = new ChargerControl();
  map.addControl(chargerCtl);
  function setChargers(on) {
    chargersOn = on;
    storeSet("shadehop.chargers", on ? "1" : "0");
    var b = document.querySelector(".chg-btn");
    if (b) b.setAttribute("aria-pressed", String(on));
    drawChargers();
  }

  // Colour key on the map itself (the full legend sits below the map, folded).
  var KeyControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "map-key");
      box.innerHTML = '<span><i class="dot hi"></i>適合</span><span><i class="dot mid"></i>還可以</span><span><i class="dot lo"></i>太曬</span>' +
        '<span><i class="dot a"></i>下雨可玩</span>';
      box.setAttribute("aria-hidden", "true");  // the same words are in the list cards and popups
      return box;
    },
  });
  map.addControl(new KeyControl());

  // ----------------------------------------------------------- phone sheet
  // Three heights: peek (one-line answer), half (the tapped park or the first cards), full (list or
  // filters). Drag the head, or tap it to step up; positions are set as a translateY.
  var sheet = $("#sheet"), sheetHead = $("#sheetHead"), sheetBody = $("#sheetBody"), sheetPark = $("#sheetPark");
  sheetPark.innerHTML = '<div id="sheetParkBody"></div>';
  // A tapped park (or charger) takes the sheet over like a place card: its name and ✕ on top where
  // the search was. ✕ goes back to where the parent came from: the search results, or the map.
  var cardHead = $("#sheetCardHead"), cardKind = null, cardFrom = null;
  function setCard(kind, head, body) {
    if (!cardKind) cardFrom = cardFromSearch && searchQ ? "search" : "map";
    cardKind = kind;
    cardHead.innerHTML = head + '<button type="button" class="sheet-close" aria-label="' + (kind === "chg" ? "關閉這個充電站" : "關閉這座公園") + '">✕</button>';
    cardHead.hidden = false;
    $("#sheetParkBody").innerHTML = body;
    sheetPark.hidden = false;
    sheet.classList.add("has-park");
    sheet.classList.toggle("card-chg", kind === "chg");
  }
  function parkCard(f) {
    var box = document.createElement("div");
    box.innerHTML = popupHtml(f);
    var head = box.querySelector(".pp-head");
    head.remove();
    setCard("park", head.outerHTML, box.innerHTML);
  }
  function returnFromCard() {
    var back = cardFrom === "search" && searchQ;
    closePark(); render(true);
    if (back) { searchFrom = "peek"; openSearch(false); } else setSheet("peek");
  }
  cardHead.addEventListener("click", function (e) {
    if (e.target.closest(".sheet-close")) returnFromCard();
  });
  // A tap on the empty map puts the card away, as ✕ does: a moment later, because the tap may be the
  // first half of a double tap or of a tap-and-drag zoom (below), which leave the card alone.
  var tapTimer = null, gestureAt = 0;
  map.on("click", function () {
    if (!phone.matches || sheetPark.hidden || Date.now() - gestureAt < 400) return;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () { if (!sheetPark.hidden) returnFromCard(); }, 320);
  });

  // Google Maps' one-finger gestures on touch screens: double tap zooms in one step; tap, then touch
  // again and drag down to zoom in (up to zoom out), around the spot touched. Leaflet's own double
  // tap zoom is off on touch screens so the two do not both fire.
  (function () {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    map.doubleClickZoom.disable();
    var el = map.getContainer(), last = null, down = null, g = null, snap = map.options.zoomSnap;
    var skip = ".leaflet-control, .leaflet-popup, .map-start";
    el.addEventListener("pointerdown", function (e) {
      if (g) finish();  // a gesture whose end never arrived must not leave the map unable to pan
      if (e.pointerType !== "touch" || !e.isPrimary || e.target.closest(skip)) { last = null; return; }
      var now = Date.now();
      if (last && now - last.t < 300 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
        clearTimeout(tapTimer);
        map.dragging.disable();  // this touch zooms; it must not also pan
        g = { id: e.pointerId, y: e.clientY, z: map.getZoom(), pt: map.mouseEventToContainerPoint(e), moved: false, want: null, raf: 0 };
        last = null;
        return;
      }
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now };
    }, true);
    // On the window, not the map: the finger often slides onto the sheet or off the map while zooming.
    window.addEventListener("pointermove", function (e) {
      if (!g || e.pointerId !== g.id) return;
      var dy = e.clientY - g.y;
      if (!g.moved && Math.abs(dy) < 8) return;
      g.moved = true;
      zoomGesture = true;
      map.options.zoomSnap = 0;
      g.want = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), g.z + dy / 110));  // ~110px a zoom level
      // One zoom per frame, however many move events arrive.
      if (!g.raf) g.raf = requestAnimationFrame(function () {
        if (!g) return;
        g.raf = 0;
        map.setZoomAround(g.pt, g.want, { animate: false });
      });
    }, true);
    function finish() {
      var x = g;
      g = null; gestureAt = Date.now();
      if (x.raf) cancelAnimationFrame(x.raf);
      map.options.zoomSnap = snap;
      zoomGesture = false;
      map.dragging.enable();
      if (x.moved) {
        // A drag ends on the nearest whole level (links and the saved view use whole zooms); the
        // markers, regions and saved view held back during the drag catch up now.
        map.setZoomAround(x.pt, Math.round(x.want !== null ? x.want : map.getZoom()), { animate: false });
        map.fire("zoomend"); map.fire("moveend");
      } else {
        map.setZoomAround(x.pt, Math.min(map.getMaxZoom(), Math.round(map.getZoom()) + 1));  // double tap
      }
    }
    function end(e) {
      if (g && e.pointerId === g.id) { finish(); return; }
      if (down && e.pointerId === down.id) {
        // A short, still touch counts as the first tap of a gesture.
        last = Date.now() - down.t < 250 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12
          ? { t: Date.now(), x: e.clientX, y: e.clientY } : null;
        down = null;
      }
    }
    // The second touch belongs to the zoom: keep iOS from treating it as text selection or a magnifier.
    el.addEventListener("touchstart", function (e) { if (g) e.preventDefault(); }, { passive: false, capture: true });
    el.addEventListener("touchmove", function (e) { if (g) e.preventDefault(); }, { passive: false, capture: true });
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("touchend", function (e) { if (g && !e.touches.length) finish(); }, true);
    window.addEventListener("touchcancel", function () { if (g) finish(); }, true);
  })();
  // Keep a place in the strip of map between the floating controls and the half sheet.
  function keepInView(ll) {
    var top = $(".controls").offsetHeight + 8, bottom = window.innerHeight - sheetMetrics().half - map.getContainer().getBoundingClientRect().top;
    var y = map.latLngToContainerPoint(ll).y, want = (top + bottom) / 2;
    if (y < top + 20 || y > bottom - 20) map.panBy([0, y - want]);
  }
  // A tapped park: zoom in to street level (never out) with the park in the middle of the map strip
  // left open between the floating chips and the half sheet.
  var PARK_ZOOM = 17;
  function centreOn(ll, z) {
    var size = map.getSize(), mapTop = map.getContainer().getBoundingClientRect().top;
    var top = $(".controls").getBoundingClientRect().bottom - mapTop, bottom = window.innerHeight - sheetMetrics().half - mapTop;
    var want = L.point(size.x / 2, (top + bottom) / 2);
    var centre = map.unproject(map.project(ll, z).add(size.divideBy(2)).subtract(want), z);
    map.setView(centre, z);
  }
  function showCharger(f) {
    state.selected = null;
    setCard("chg", chargerCard(f).head, chargerCard(f).body);
    closeFilters();
    sheetBody.scrollTop = 0;
    setSheet("half");
    keepInView(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]));
    render(true);
    drawSel();
  }
  var sheetState = "peek";
  function sheetMetrics() {
    var full = sheet.offsetHeight, peek = sheetHead.offsetHeight, half = Math.round(window.innerHeight * 0.48);
    // With a park or the filters open, "half" is just tall enough to show all of it (actions included).
    var open = !sheetPark.hidden ? sheetPark : !$("#sheetFilters").hidden ? $("#sheetFilters") : null;
    if (open) half = peek + open.offsetHeight + 24;
    return { full: full, peek: peek, half: Math.min(full, Math.max(peek + 160, half)) };
  }
  function sheetOffset(st) {
    var m = sheetMetrics();
    return m.full - (st === "full" ? m.full : st === "half" ? m.half : m.peek);
  }
  function setSheet(st) {
    // Collapsing to the one-line answer puts away whatever was open.
    if (st === "peek" && phone.matches) {
      if (!sheetPark.hidden) {  // dragged down: same as ✕
        var back = cardFrom === "search" && searchQ;
        closePark(); render(true);
        if (back) { searchFrom = "peek"; openSearch(false); return; }
      }
      if (!$("#sheetFilters").hidden) closeFilters();
    }
    if (searching && st !== "full") endSearch();  // dragged down while searching
    sheetState = st;
    if (!phone.matches) { sheet.style.transform = ""; return; }
    sheet.style.transform = "translateY(" + sheetOffset(st) + "px)";
    sheet.dataset.state = st;
    $("#sheetHandle").setAttribute("aria-label", st === "full" ? "收起清單" : "展開清單");
    $("#sheetHandle").setAttribute("aria-expanded", String(st !== "peek"));
    document.documentElement.style.setProperty("--peek", sheetMetrics().peek + "px");
  }
  var drag = null;
  // The whole head drags the sheet (and the tapped park's title row), except its own controls.
  sheet.addEventListener("pointerdown", function (e) {
    if (!phone.matches || drag) return;
    var head = e.target.closest("#sheetHead"), title = e.target.closest("#sheetPark .pp-head");
    if (!head && !title) return;
    // Search and its results sit in the head too: a tap on a result must reach the result.
    if (e.target.closest("button:not(.sheet-handle), a, input, label, select, output, .search")) return;
    drag = { y: e.clientY, from: sheetOffset(sheetState), moved: false, id: e.pointerId, tap: !!head };
    sheet.classList.add("dragging");
  });
  window.addEventListener("pointercancel", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null; sheet.classList.remove("dragging"); setSheet(sheetState);
  });
  window.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dy = e.clientY - drag.y;
    if (Math.abs(dy) > 6) drag.moved = true;
    if (!drag.moved) return;
    var m = sheetMetrics(), y = Math.max(0, Math.min(m.full - m.peek, drag.from + dy));
    sheet.style.transform = "translateY(" + y + "px)";
  });
  window.addEventListener("pointerup", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    sheet.classList.remove("dragging");
    var d = drag; drag = null;
    if (!d.moved) { if (d.tap) setSheet(sheetState === "peek" ? "half" : sheetState === "half" ? "full" : "peek"); else setSheet(sheetState); return; }
    var y = new DOMMatrix(getComputedStyle(sheet).transform).m42;
    var best = ["peek", "half", "full"].reduce(function (a, b) {
      return Math.abs(sheetOffset(b) - y) < Math.abs(sheetOffset(a) - y) ? b : a;
    });
    setSheet(best);
  });
  $("#sheetHandle").addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp") { e.preventDefault(); setSheet(sheetState === "peek" ? "half" : "full"); }
    if (e.key === "ArrowDown") { e.preventDefault(); setSheet(sheetState === "full" ? "half" : "peek"); }
  });
  $("#sheetHandle").addEventListener("click", function (e) {
    if (e.detail === 0) setSheet(sheetState === "peek" ? "half" : sheetState === "half" ? "full" : "peek");  // keyboard
  });

  function showPark(f) {
    if (!f) return;
    if (nearShown && nearShown.split("|")[0] !== f.properties.id) clearNear();
    state.selected = f.properties.id;
    parkCard(f);  // the park answers the question; the search and area summary step aside
    closeFilters();
    sheetBody.scrollTop = 0;
    setSheet("half");
    centreOn(L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]), Math.max(map.getZoom(), PARK_ZOOM));
    render(true);
    drawSel();
    if (!nearShown || nearShown.split("|")[0] !== f.properties.id) nearFor(f.properties.id, "all", { fit: false });
  }
  sheetPark.addEventListener("click", function (e) {
    var go = e.target.closest("[data-goto]"), j = e.target.closest("[data-jump]"), nb = e.target.closest("[data-near]");
    if (nb) { showNear(nb); return; }
    if (go) { e.preventDefault(); focusPark(go.dataset.goto); }
    if (j) { e.preventDefault(); state.slot = Number(j.dataset.jump); $("#slot").value = state.slot; atNow = false; render(); }
  });

  function closePark() {
    clearNear();
    sheetPark.hidden = true; cardHead.hidden = true; cardKind = null;
    sheet.classList.remove("has-park", "card-chg"); state.selected = null; drawSel();
  }
  // Filters take the sheet over; the park card the parent was looking at comes back when they are done.
  var parkBeforeFilters = null;
  function openFilters() {
    parkBeforeFilters = state.selected;
    closePark();
    $("#sheetFilters").hidden = false;
    $("#filterBtn").setAttribute("aria-expanded", "true");
    sheetBody.scrollTop = 0; setSheet("half");  // half: the map and the live count stay in view
  }
  function closeFilters() {
    $("#sheetFilters").hidden = true;
    $("#filterBtn").setAttribute("aria-expanded", "false");
  }
  $("#filterBtn").addEventListener("click", function () {
    if ($("#sheetFilters").hidden) openFilters(); else if (!backToPark()) { closeFilters(); setSheet("half"); }
  });
  function backToPark() {
    var f = parkBeforeFilters && state.features.find(function (x) { return x.properties.id === parkBeforeFilters; });
    parkBeforeFilters = null;
    if (!f || !passes(f)) return false;
    closeFilters(); showPark(f);
    return true;
  }
  $("#filtersDone").addEventListener("click", function () { if (!backToPark()) { closeFilters(); setSheet("peek"); } });

  // The one-line answer in the sheet head: how many parks in view suit the selected time, or why none.
  function updateSummary(fs) {
    var el = $("#sheetSummary");
    // Early morning, evening and night have no shade to compare: the colour key would only add a
    // question ("which colour do I look for?"), so it steps aside and the answer says why.
    var dark = fs.length > 0 && fs.every(function (f) { var v = shadeAt(f); return v === null || v === undefined; });
    var low = dark || window.ShadeHopVerdict(0, state.slot).cls === "weak";
    document.body.classList.toggle("low-sun", low);
    if (startOpen()) { el.textContent = "選一個地方開始，看附近現在不曬的公園"; return; }
    if (!state.features.length) { el.textContent = "地圖載入中…"; return; }
    var covered = state.regions.some(function (r) { return regionInView(r); });
    if (!covered) { el.textContent = "這個範圍還沒有資料"; return; }
    var when = atNow ? "現在" : slotLabel(state.slot) + " ";
    var on = Object.keys(filters).some(function (k) { return filters[k]; });
    if (!fs.length) {
      var next = filters.shade ? nextShadeSlot() : -1;
      var near = on ? nearestMatch() : null;
      el.innerHTML = "<b>畫面中沒有符合的公園</b>" + (next >= 0 ? '・<button type="button" class="link" data-jump="' + next + '">' + slotLabel(next) + " 起有遮陰</button>" : "") +
        (near ? '<br>最近符合的：<button type="button" class="link" data-goto="' + esc(near.f.properties.id) + '">' + esc(near.f.properties.name) + "</button> " + kmLabel(near.d) : "") +
        (on ? '・<button type="button" class="link" data-clear="all">取消篩選</button>' : "");
      return;
    }
    if (dark) { el.innerHTML = "<b>" + when + (state.slot < 12 ? "日出前，還沒有直射陽光" : "天黑了，沒有直射陽光") + "</b>・畫面中 " + fs.length + " 座公園"; return; }
    if (low) { el.innerHTML = "<b>" + when + "太陽低，哪座都不太曬</b>，挑近的就好・畫面中 " + fs.length + " 座公園"; return; }
    var good = fs.filter(function (f) { return verdict(shadeAt(f)).cls === "hi" || f.properties.rain === true && verdict(shadeAt(f)).cls !== "lo"; });
    if (good.length) {
      var ref = state.user || [map.getCenter().lng, map.getCenter().lat];
      good.sort(function (a, b) { return distM(ref, a.geometry.coordinates) - distM(ref, b.geometry.coordinates); });
      var g = good[0], d = distM(ref, g.geometry.coordinates);
      el.innerHTML = "<b>" + when + "有 " + good.length + " 座適合</b>・" + (state.user ? "離你最近 " : "最近：") +
        '<button type="button" class="link" data-goto="' + esc(g.properties.id) + '">' + esc(g.properties.name) + "</button>" +
        (state.user ? " " + (d < 1000 ? Math.round(d) + "m" : (d / 1000).toFixed(1) + " km") : "");
      return;
    }
    var keep = state.slot, later = -1, n = 0;
    for (var i = Math.max(state.slot + 1, 4); i < 22 && later < 0; i++) {
      state.slot = i;
      n = state.features.filter(function (f) { return inView(f) && passes(f) && verdict(shadeAt(f)).cls === "hi"; }).length;
      if (n) later = i;
    }
    state.slot = keep;
    el.innerHTML = "<b>" + when + "畫面中沒有適合的公園</b>" +
      (later >= 0 ? '・<button type="button" class="link" data-jump="' + later + '">' + slotLabel(later) + " 起有 " + n + " 座</button>" : "・往上拉清單，看哪座遮陰最多");
  }
  sheetHead.addEventListener("click", function (e) {
    var c = e.target.closest("[data-clear]"), j = e.target.closest("[data-jump]"), go = e.target.closest("[data-goto]");
    if (c) clearFilter(c.dataset.clear);
    if (j) { state.slot = Number(j.dataset.jump); $("#slot").value = state.slot; atNow = false; render(); }
    if (go) focusPark(go.dataset.goto);
  });

  // Date label (phones): 今天 / 明天 / M/D; the transparent date field on top of it opens the picker.
  function dateLabel() {
    var t = taipeiNow(), today = new Date(Date.UTC(t.y, t.m - 1, t.d)), p = state.date.split("-").map(Number);
    var diff = Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - today) / 86400000);
    $("#dateBtn").textContent = diff === 0 ? "今天" : diff === 1 ? "明天" : p[1] + "/" + p[2];
  }

  // Phones: search and the time row go into the sheet, every filter into the one chip row on top; back on wider screens.
  var moved = [["#sheetSearch", ".search", true], ["#sheetTime", ".timebar", true], ["#chipsMain", "#moreFilters", true], ["#sheetHead", "#weather", true], ["#sheetBody", "footer", false]];
  var homes = moved.map(function (x) { var el = $(x[1]); var mark = document.createComment("home"); el.parentNode.insertBefore(mark, el); return { el: el, mark: mark, to: x[0] }; });
  function layoutForWidth() {
    homes.forEach(function (h) {
      if (phone.matches) { var to = $(h.to); if (to.tagName === "P") to.after(h.el); else to.appendChild(h.el); }
      else h.mark.parentNode.insertBefore(h.el, h.mark.nextSibling);
    });
    $("#moreFilters").hidden = phone.matches ? false : $("#moreBtn").getAttribute("aria-expanded") !== "true";
    searchEl.readOnly = phone.matches && !searching;
    // Phones: pinch replaces the zoom buttons (CSS hides them); locate and chargers sit bottom right, near the thumb.
    locateCtl.setPosition(phone.matches ? "bottomright" : "topleft");
    chargerCtl.setPosition(phone.matches ? "bottomright" : "topright");
    if (!phone.matches) { closeFilters(); closePark(); }
    syncOffsets();
    drawMarkers();
    setSheet(phone.matches ? sheetState : "peek");
    map.invalidateSize();
  }
  function syncOffsets() {
    var root = document.documentElement.style;
    root.setProperty("--head-h", document.querySelector("header.top").offsetHeight + "px");
    root.setProperty("--ctl-h", $(".controls").offsetHeight + "px");
    if (phone.matches) setSheet(sheetState);
  }
  // Space for the floating controls above the map's own buttons (they grow when search results open, etc.).
  if (window.ResizeObserver) {
    new ResizeObserver(syncOffsets).observe($(".controls"));
    // The head grows with the summary text and weather line; keep the peek height and map in step.
    new ResizeObserver(function () { if (phone.matches) setSheet(sheetState); }).observe(sheetHead);
  }
  phone.addEventListener ? phone.addEventListener("change", layoutForWidth) : phone.addListener(layoutForWidth);
  window.addEventListener("resize", function () { if (phone.matches) setSheet(sheetState); });

  // ------------------------------------------------------------------ init
  setNow();
  layoutForWidth();
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
