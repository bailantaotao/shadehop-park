/* Park page: favourite star, copy-link and share buttons. */
(function () {
  "use strict";
  var bar = document.getElementById("parkActions");
  if (!bar) return;
  bar.hidden = false;
  document.dispatchEvent(new CustomEvent("shadehop:favs"));  // show the saved star state

  var status = document.getElementById("copyStatus");
  var copyBtn = document.getElementById("copyLink");
  var url = copyBtn.dataset.url;
  var timer = null;
  function say(msg) {
    status.textContent = msg;
    clearTimeout(timer);
    timer = setTimeout(function () { status.textContent = ""; }, 3000);
  }
  function fallbackCopy() {
    // Older browsers / non-https: copy through a temporary text field.
    var t = document.createElement("textarea");
    t.value = url; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(t);
    return ok;
  }
  copyBtn.addEventListener("click", function () {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(function () { say("已複製連結"); }, function () {
        say(fallbackCopy() ? "已複製連結" : "無法自動複製，請手動複製：" + url);
      });
    } else {
      say(fallbackCopy() ? "已複製連結" : "無法自動複製，請手動複製：" + url);
    }
  });

  var shareBtn = document.getElementById("shareLink");
  if (navigator.share) {
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", function () {
      navigator.share({ title: document.title, text: shareBtn.dataset.text, url: url }).catch(function () { /* cancelled */ });
    });
  }
})();
