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
        (on ? "從我的最愛移除" : "加入我的最愛") + '">' + (on ? "★" : "☆") +
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
      b.firstChild.nodeValue = on ? "★" : "☆";
      var label = b.querySelector(".fav-label");
      // A button can carry shorter labels (data-on / data-off), e.g. 收藏 / 已收藏 on park pages.
      if (label) label.textContent = on ? (b.dataset.on || "已加入我的最愛") : (b.dataset.off || "加入我的最愛");
    });
  });
})();
