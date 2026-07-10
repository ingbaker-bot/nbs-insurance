/**
 * NBS SPA 前端路由 router.js v2
 * Phase 1：summary / coverage
 * Phase 2：+ savings（本次新增）
 *
 * v2 變更：新增「監聽器自動清除」機制 —— 每次換頁前，會把上一頁
 * 的 script 在執行期間對 window 註冊的 addEventListener 全部移除，
 * 避免使用者反覆切換同一頁時，nbs_nav_ready 等事件的監聽器不斷疊加
 * （疊加後會造成同一份資料被重複渲染，甚至重複觸發 GAS 呼叫）。
 *
 * 設計原則：
 * - 完全不修改既有 8 支獨立 .html 檔案內容，直接 fetch 現有檔案本身，
 *   用 DOMParser 解析後取出 <style> 與 <body> 內容、<script> 內容來重組。
 * - 只在 shell.html 這種「有引入 router.js」的頁面生效；
 *   舊的獨立 .html 頁面沒有引入 router.js，nav.js 會自動退回整頁導航，
 *   兩種模式並存、互不影響。
 *
 * 已知限制（Phase 1 誠實揭露，尚未完全解決）：
 * - v2 已處理 window.addEventListener 的疊加問題。
 * - 若某頁使用 setInterval/setTimeout 排程尚未觸發就切走，計時器本身
 *   仍會在背景跑完，屆時可能操作到已經被替換掉的 DOM（安全但可能出現
 *   Console 警告）。目前排進白名單的頁面都沒有這類用法，之後排到有
 *   計時器的頁面（如 export.html）會在遷移時個別處理。
 */
(function(global) {
  "use strict";

  var CONTENT_ID = "nbs-app-content";
  var PILOT_PAGES = ["summary.html", "coverage.html", "savings.html"]; // Phase 2 白名單

  var _current = { key: null, scriptEls: [], listeners: [] };

  function _keyFromHref(href) {
    return href.split("/").pop().split("?")[0].split("#")[0];
  }

  function _removeTrackedListeners() {
    _current.listeners.forEach(function(l) {
      try { window.removeEventListener(l.type, l.fn, l.opts); } catch (e) {}
    });
    _current.listeners = [];
  }

  function navigate(href, opts) {
    opts = opts || {};
    var key = _keyFromHref(href);

    // 不在試點白名單內的頁面，暫時維持整頁導航（依序逐頁加入白名單）
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

    // 1) 清掉上一頁注入的 <script> 節點
    _current.scriptEls.forEach(function(s) {
      if (s.parentNode) s.parentNode.removeChild(s);
    });
    _current.scriptEls = [];

    // 1b) 清掉上一頁在 window 上註冊的監聽器（v2 新增）
    _removeTrackedListeners();

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

    // 5) 監聽 addEventListener，把這一頁 script 執行期間註冊的監聽器記下來，
    //    下次換頁時才能精準清掉（v2 新增）
    var captured = [];
    var origAdd = window.addEventListener;
    window.addEventListener = function(type, fn, opts2) {
      captured.push({ type: type, fn: fn, opts: opts2 });
      return origAdd.call(window, type, fn, opts2);
    };

    // 6) 依原順序重新執行這一頁的 <script>（外部 src 的略過，shell 已載入過）
    scriptNodes.forEach(function(s) {
      if (s.src) return;
      var el = document.createElement("script");
      el.textContent = s.textContent;
      document.body.appendChild(el);
      _current.scriptEls.push(el);
    });

    // 還原 addEventListener，記錄本頁註冊的監聽器
    window.addEventListener = origAdd;
    _current.listeners = captured;

    // 7) 補發一次資料就緒事件，讓剛執行的頁面 script 能拿到現有家庭/成員資料
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

