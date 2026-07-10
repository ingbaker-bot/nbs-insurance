/**
 * NBS SPA 前端路由 router.js v1（Phase 1 試點：僅 summary / coverage 兩頁）
 *
 * 設計原則：
 * - 完全不修改既有 8 支獨立 .html 檔案內容，直接 fetch 現有檔案本身，
 *   用 DOMParser 解析後取出 <style> 與 <body> 內容、<script> 內容來重組。
 * - 只在 shell.html 這種「有引入 router.js」的頁面生效；
 *   舊的獨立 .html 頁面沒有引入 router.js，nav.js 會自動退回整頁導航，
 *   兩種模式並存、互不影響。
 *
 * 已知限制（Phase 1 誠實揭露，Phase 2 逐頁遷移時會處理）：
 * - 換頁時會移除上一頁注入的 <script> 節點，避免程式碼疊加、
 *   避免變數重複宣告報錯，但「已經註冊出去的」setInterval / 
 *   window.addEventListener 等，理論上仍可能殘留在記憶體中執行。
 *   因此 Phase 1 只先開放風險最低的 summary / coverage 兩頁試點，
 *   尚未大量使用 setInterval 或全域監聽的頁面才會被排進來。
 */
(function(global) {
  "use strict";

  var CONTENT_ID = "nbs-app-content";
  var PILOT_PAGES = ["summary.html", "coverage.html"]; // Phase 1 試點白名單

  var _current = { key: null, scriptEls: [] };

  function _keyFromHref(href) {
    return href.split("/").pop().split("?")[0].split("#")[0];
  }

  function navigate(href, opts) {
    opts = opts || {};
    var key = _keyFromHref(href);

    // 不在試點白名單內的頁面，暫時維持整頁導航（Phase 2 逐頁加入白名單）
    if (PILOT_PAGES.indexOf(key) === -1) {
      window.location.href = href;
      return;
    }

    fetch(href, { cache: "no-store" })
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function(html) { _mount(key, href, html, opts); })
      .catch(function(e) {
        console.error("[router] 載入 " + href + " 失敗，改用整頁導航：", e);
        window.location.href = href;
      });
  }

  function _mount(key, href, html, opts) {
    var doc = new DOMParser().parseFromString(html, "text/html");

    // 1) 清掉上一頁注入的 <script>，避免程式碼疊加
    _current.scriptEls.forEach(function(s) {
      if (s.parentNode) s.parentNode.removeChild(s);
    });
    _current.scriptEls = [];

    // 2) 清掉上一頁注入的 <style>，換上這一頁的 <style>
    document.querySelectorAll("style[data-nbs-page-style]").forEach(function(s) { s.remove(); });
    var styleSrc = doc.querySelector("style");
    if (styleSrc) {
      var styleEl = document.createElement("style");
      styleEl.setAttribute("data-nbs-page-style", key);
      styleEl.textContent = styleSrc.textContent;
      document.head.appendChild(styleEl);
    }

    // 3) 換內容容器：拿 body 內容，先拔掉 <script>（稍後單獨處理執行順序）
    var container = document.getElementById(CONTENT_ID);
    if (!container) {
      console.error("[router] 找不到 #" + CONTENT_ID + "，改用整頁導航");
      window.location.href = href;
      return;
    }
    var bodyClone = doc.body.cloneNode(true);
    var scriptNodes = Array.prototype.slice.call(bodyClone.querySelectorAll("script"));
    scriptNodes.forEach(function(s) { s.remove(); });
    container.innerHTML = bodyClone.innerHTML;

    // 4) 更新網址列與側欄高亮（不重抓資料）
    if (!opts.skipPush) history.pushState({ nbsPage: key }, "", href);
    if (global.NBS_NAV && typeof global.NBS_NAV.setActivePage === "function") {
      global.NBS_NAV.setActivePage(key.replace(/\.html$/, ""));
    }
    window.scrollTo(0, 0);

    // 5) 依原順序重新執行這一頁的 <script>（外部 src 的略過，shell 已載入過）
    scriptNodes.forEach(function(s) {
      if (s.src) return;
      var el = document.createElement("script");
      el.textContent = s.textContent;
      document.body.appendChild(el);
      _current.scriptEls.push(el);
    });

    // 6) 補發一次資料就緒事件，讓剛執行的頁面 script 能拿到現有家庭/成員資料
    setTimeout(function() {
      if (global.NBS_NAV && typeof global.NBS_NAV.reannounce === "function") {
        global.NBS_NAV.reannounce();
      }
    }, 0);

    _current.key = key;
  }

  window.addEventListener("popstate", function(e) {
    var key = (e.state && e.state.nbsPage) || _keyFromHref(location.pathname);
    if (!key || PILOT_PAGES.indexOf(key) === -1) return; // 非試點頁不處理，交給瀏覽器預設行為
    navigate(key, { skipPush: true });
  });

  global.NBSRouter = { navigate: navigate };

})(window);
