/* Favourite parks, kept only in this browser (localStorage); no account, nothing sent anywhere.
   Shared by the map (app.js) and park pages. Storage can be unavailable (private mode,
   blocked site data), so every access is guarded and the page works without it. */
(function () {
  "use strict";
  var KEY = "shadehop.favs";
  var mem = null;  // fallback for this page view when storage is blocked

  // Park ids whose region prefix changed (Linkou lk-* became New Taipei nt-*).
  var MOVED = { "lk-": "nt-" };
  function migrate(ids) {
    return ids.map(function (id) {
      var p = id.slice(0, 3);
      return MOVED[p] ? MOVED[p] + id.slice(3) : id;
    });
  }
  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(v) ? migrate(v) : [];
    } catch (e) { return mem || []; }
  }
  function write(ids) {
    mem = ids;
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (e) { /* private mode: keep in memory */ }
    document.dispatchEvent(new CustomEvent("shadehop:favs"));
  }

  // Icons for script-built HTML (map popups, cards): the same sprite the templates use.
  var iconMeta = document.querySelector('meta[name="shadehop-icons"]');
  var ICONS = iconMeta ? iconMeta.getAttribute("content") : "";
  window.ShadeHopIcon = function (name, cls) {
    return '<svg class="i' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="' + ICONS + "#" + name + '"></use></svg>';
  };
  var STAR = window.ShadeHopIcon("star", "off") + window.ShadeHopIcon("star-on", "on");

  // Is this half-hour a good time to go? v = shade share 0..1 (null: sun not up), slot = 0 for 06:00.
  // Before 08:00 and from 17:00 the sun is low and weak: a high shade share then is not a reason to go,
  // so those slots say 陽光弱 instead of grading the shade (8-17 is the window the best-time hint uses).
  window.ShadeHopVerdict = function (v, slot) {
    if (v === null || v === undefined) return { cls: "night", word: "沒有直射陽光", text: "沒有直射陽光" };
    var pct = "（遮陰 " + Math.round(v * 100) + "%）";
    if (slot < 4 || slot >= 22) return { cls: "weak", word: "陽光弱", text: "陽光弱" + pct };
    var cls = v >= 0.6 ? "hi" : v >= 0.3 ? "mid" : "lo";
    var word = { hi: "適合", mid: "還可以", lo: "太曬" }[cls];
    return { cls: cls, word: word, text: word + pct };
  };

  window.ShadeHopFavs = {
    list: read,
    has: function (id) { return read().indexOf(id) >= 0; },
    toggle: function (id) {
      var ids = read(), i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1); else ids.push(id);
      write(ids);
      return i < 0;
    },
    // A star toggle for one park: <button class="fav" data-fav="id">.
    button: function (id, withLabel) {
      var on = read().indexOf(id) >= 0;
      return '<button type="button" class="fav" data-fav="' + id + '" aria-pressed="' + on + '" title="' +
        (on ? "從我的最愛移除" : "加入我的最愛") + '">' + STAR +
        (withLabel ? '<span class="fav-label">' + (on ? "已加入我的最愛" : "加入我的最愛") + "</span>" : "") + "</button>";
    },
  };

  // One handler for every star on the page, wherever it was rendered (cards, popups, park page).
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-fav]");
    if (!b || e.defaultPrevented) return;  // already handled (e.g. inside a map popup)
    e.preventDefault();
    window.ShadeHopFavs.toggle(b.dataset.fav);
  });
  // Keep every star for the same park in sync after a change.
  document.addEventListener("shadehop:favs", function () {
    document.querySelectorAll("[data-fav]").forEach(function (b) {
      var on = window.ShadeHopFavs.has(b.dataset.fav);
      b.setAttribute("aria-pressed", String(on));
      b.title = on ? "從我的最愛移除" : "加入我的最愛";
      var label = b.querySelector(".fav-label");
      // A button can carry shorter labels (data-on / data-off), e.g. 收藏 / 已收藏 on park pages.
      if (label) label.textContent = on ? (b.dataset.on || "已加入我的最愛") : (b.dataset.off || "加入我的最愛");
    });
  });
})();
