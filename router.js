/**
 * NBS SPA 前端路由 router.js v5
 * Phase 1：summary / coverage
 * Phase 2：+ savings, + beneficiary, + hospital, + policy, + visit, + family
 * Phase 2 收尾：+ export（本次新增，並清理死碼）
 *
 * v2：新增「監聽器自動清除」（window.addEventListener 疊加問題）
 * v4：新增「計時器自動清除」（setTimeout/setInterval 疊加問題）
 * v5：遷移 policy.html 時發現兩個新狀況：
 *   (a) policy.html 的 <head> 裡用 <script src="...pdf.js">
 *       載入外部函式庫，並且緊接著一段內嵌 script 設定
 *       pdfjsLib.GlobalWorkerOptions.workerSrc。之前 router 只處理
 *       <body> 裡的 script，<head> 的外部函式庫完全沒被載入，會導致
 *       用到 pdfjsLib 的功能整個掛掉。這次補上「head 相依性載入」：
 *       換頁時掃描該頁 <head> 的 <script>，外部的（有 src）如果目前
 *       文件裡還沒載入過，就動態載入並等它 load 完成，內嵌的依序執行，
 *       全部完成後才繼續往下跑 <body> 的 script（保持跟原本檔案一樣的
 *       執行順序）。已經載入過的外部函式庫（例如 nav.js、Google GSI）
 *       不會重複載入。
 *   (b) policy.html 有一個 document.addEventListener("click", ...)
 *       （點擊選單外部關閉選單），是 window 以外的另一個監聽目標，
 *       之前的追蹤機制只顧到 window.addEventListener。這次一併把
 *       document.addEventListener 也納入追蹤／清除範圍。
 *
 * 目前機制涵蓋的範圍（誠實列出邊界）：
 * - 只會追蹤「頁面 <script> 剛執行時，同步呼叫」的
 *   window/document.addEventListener 與 setTimeout/setInterval。
 * - 使用者點擊按鈕之後才觸發、包在點擊處理函式裡面的 setTimeout
 *   （例如存檔後 2~3 秒讓按鈕文字恢復原狀），不在追蹤範圍內——
 *   這類計時器referencing的是使用者當下操作的既有 DOM 元素，就算
 *   使用者馬上切走，最多是對一個已離開畫面的元素做無意義的樣式
 *   變更，沒有害處，因此刻意不處理，避免機制過度複雜。
 *
 * 設計原則：
 * - 完全不修改既有 8 支獨立 .html 檔案內容，直接 fetch 現有檔案本身，
 *   用 DOMParser 解析後取出 <style> 與 <body> 內容、<script> 內容來重組。
 * - 只在 shell.html 這種「有引入 router.js」的頁面生效；
 *   舊的獨立 .html 頁面沒有引入 router.js，nav.js 會自動退回整頁導航，
 *   兩種模式並存、互不影響。
 */
(function(global) {
  "use strict";

  var CONTENT_ID = "nbs-app-content";
  var PILOT_PAGES = ["summary.html", "coverage.html", "savings.html", "beneficiary.html", "hospital.html", "policy.html", "visit.html", "family.html", "export.html"];

  var _current = { key: null, scriptEls: [], listeners: [], timers: [] };
  var _loadedExternalSrcs = null;

  function _keyFromHref(href) {
    return href.split("/").pop().split("?")[0].split("#")[0];
  }

  function _absSrc(src) {
    try { return new URL(src, document.baseURI).href; } catch (e) { return src; }
  }

  function _initLoadedSrcSet() {
    if (_loadedExternalSrcs) return;
    _loadedExternalSrcs = {};
    document.querySelectorAll("script[src]").forEach(function(s) {
      _loadedExternalSrcs[_absSrc(s.src)] = true;
    });
  }

  function _removeTrackedListeners() {
    _current.listeners.forEach(function(l) {
      try { l.target.removeEventListener(l.type, l.fn, l.opts); } catch (e) {}
    });
    _current.listeners = [];
  }

  function _clearTrackedTimers() {
    _current.timers.forEach(function(t) {
      try { (t.kind === "interval" ? clearInterval : clearTimeout)(t.id); } catch (e) {}
    });
    _current.timers = [];
  }

  // 依序載入該頁 <head> 裡的相依 script（外部的等載入完成，內嵌的依序執行）
  function _loadHeadDeps(doc) {
    _initLoadedSrcSet();
    var headScripts = Array.prototype.slice.call(doc.head.querySelectorAll("script"));
    var chain = Promise.resolve();
    headScripts.forEach(function(s) {
      if (s.src) {
        var abs = _absSrc(s.src);
        if (_loadedExternalSrcs[abs]) return; // 已載入過，略過
        chain = chain.then(function() {
          return new Promise(function(resolve, reject) {
            var el = document.createElement("script");
            el.src = abs;
            el.onload = function() { _loadedExternalSrcs[abs] = true; resolve(); };
            el.onerror = function() { reject(new Error("外部腳本載入失敗：" + abs)); };
            document.head.appendChild(el);
          });
        });
      } else if (s.textContent && s.textContent.trim()) {
        chain = chain.then(function() {
          var el = document.createElement("script");
          // 跟 body script 同樣的道理，用 _wrapPageScript 處理
          el.textContent = _wrapPageScript(s.textContent);
          document.head.appendChild(el);
        });
      }
    });
    return chain;
  }

  function navigate(href, opts) {
    opts = opts || {};
    var key = _keyFromHref(href);

    if (PILOT_PAGES.indexOf(key) === -1) {
      window.location.href = href;
      return;
    }

    fetch(href, { cache: "no-store" })
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function(html) { return _mount(key, href, html, opts); })
      .catch(function(e) {
        console.error("[router] 載入 " + href + " 失敗，改用整頁導航：", e);
        window.location.href = href;
      });
  }

  function _mount(key, href, html, opts) {
    var doc = new DOMParser().parseFromString(html, "text/html");

    _current.scriptEls.forEach(function(s) {
      if (s.parentNode) s.parentNode.removeChild(s);
    });
    _current.scriptEls = [];

    _removeTrackedListeners();
    _clearTrackedTimers();

    document.querySelectorAll("style[data-nbs-page-style]").forEach(function(s) { s.remove(); });
    var styleSrc = doc.querySelector("style");
    if (styleSrc) {
      var styleEl = document.createElement("style");
      styleEl.setAttribute("data-nbs-page-style", key);
      styleEl.textContent = styleSrc.textContent;
      document.head.appendChild(styleEl);
    }

    var container = document.getElementById(CONTENT_ID);
    if (!container) {
      console.error("[router] 找不到 #" + CONTENT_ID + "，改用整頁導航");
      window.location.href = href;
      return Promise.resolve();
    }
    var bodyClone = doc.body.cloneNode(true);
    var scriptNodes = Array.prototype.slice.call(bodyClone.querySelectorAll("script"));
    scriptNodes.forEach(function(s) { s.remove(); });
    container.innerHTML = bodyClone.innerHTML;

    if (!opts.skipPush) history.pushState({ nbsPage: key }, "", href);
    if (global.NBS_NAV && typeof global.NBS_NAV.setActivePage === "function") {
      global.NBS_NAV.setActivePage(key.replace(/\.html$/, ""));
    }
    window.scrollTo(0, 0);

    // 先確保這一頁在 <head> 宣告的外部相依（例如 pdf.js）都載入完成，
    // 再執行 <body> 的邏輯 script，維持跟原始整頁載入一致的執行順序
    return _loadHeadDeps(doc).then(function() {
      _runBodyScripts(key, scriptNodes);
    }).catch(function(e) {
      console.error("[router] " + key + " 相依載入失敗，改用整頁導航：", e);
      window.location.href = href;
    });
  }

  // 把頁面的 <script> 內容包進一層 { } 區塊：區塊內的 const／let 只在
  // 這次執行的生命週期裡有效，執行完就釋放，重複切回同一頁不會撞上
  // 「已宣告」而整段腳本崩潰。
  //
  // 但單純包 { } 有個例外：一般的 function 宣告，瀏覽器基於 Annex B
  // 相容性規則會自動掛回 window，可是 async function／generator
  // function 不適用這條規則，包進區塊後會變成只在區塊內看得到，
  // onclick="xxx()" 這種寫在 HTML 屬性裡、需要從全域呼叫的寫法就會找
  // 不到函式。這裡額外掃描頂層（沒有縮排、真正寫在最外層的）
  // function／async function／function* 宣告，在區塊「結束前」明確補一行
  // window.名稱 = 名稱，讓它們不管是哪種 function 都能被 onclick 呼叫到。
  // 允許 function／async function 前面有縮排空白（[ \t]*）——不同頁面
  // 的程式碼縮排風格不一樣，family.html 這類會把整段 <script> 內容縮排
  // 4 個空白，原本要求「完全沒有空白」才抓得到，導致這種寫法的頁面，
  // 所有函式都沒被掛回 window，onclick 呼叫時就會「函式未定義」。
  var TOP_LEVEL_FN_RE = /^[ \t]*(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  function _wrapPageScript(code) {
    var names = [];
    var m;
    TOP_LEVEL_FN_RE.lastIndex = 0;
    while ((m = TOP_LEVEL_FN_RE.exec(code))) { names.push(m[1]); }
    var exposeLines = names.map(function(n) {
      return "if (typeof " + n + " === 'function') { window." + n + " = " + n + "; }";
    }).join("\n");
    return "{\n" + code + "\n" + exposeLines + "\n}";
  }

  function _runBodyScripts(key, scriptNodes) {
    var capturedListeners = [];
    var capturedTimers = [];
    var origWinAdd = window.addEventListener;
    var origDocAdd = document.addEventListener;
    var origSetTimeout = window.setTimeout;
    var origSetInterval = window.setInterval;

    window.addEventListener = function(type, fn, o) {
      capturedListeners.push({ target: window, type: type, fn: fn, opts: o });
      return origWinAdd.call(window, type, fn, o);
    };
    document.addEventListener = function(type, fn, o) {
      capturedListeners.push({ target: document, type: type, fn: fn, opts: o });
      return origDocAdd.call(document, type, fn, o);
    };
    window.setTimeout = function(fn, delay) {
      var id = origSetTimeout.apply(window, arguments);
      capturedTimers.push({ kind: "timeout", id: id });
      return id;
    };
    window.setInterval = function(fn, delay) {
      var id = origSetInterval.apply(window, arguments);
      capturedTimers.push({ kind: "interval", id: id });
      return id;
    };

    scriptNodes.forEach(function(s) {
      if (s.src) return; // 外部 body script：目前 8 支頁面沒有這種用法，暫不支援
      var el = document.createElement("script");
      el.textContent = _wrapPageScript(s.textContent);
      document.body.appendChild(el);
      _current.scriptEls.push(el);
    });

    window.addEventListener = origWinAdd;
    document.addEventListener = origDocAdd;
    window.setTimeout = origSetTimeout;
    window.setInterval = origSetInterval;
    _current.listeners = capturedListeners;
    _current.timers = capturedTimers;

    origSetTimeout(function() {
      if (global.NBS_NAV && typeof global.NBS_NAV.reannounce === "function") {
        global.NBS_NAV.reannounce();
      }
    }, 0);

    _current.key = key;
  }

  window.addEventListener("popstate", function(e) {
    var key = (e.state && e.state.nbsPage) || _keyFromHref(location.pathname);
    if (!key || PILOT_PAGES.indexOf(key) === -1) return;
    navigate(key, { skipPush: true });
  });

  global.NBSRouter = {
    navigate: navigate,
    // 讓各頁面的非同步資料載入（await 之後）可以檢查自己是否還是
    // 目前使用者正在看的頁面，避免使用者已經切到別頁時，還去操作
    // 已經被替換掉的 DOM（例如 document.getElementById(...).style
    // 對一個已經不存在的元素，會拋出 Cannot read properties of null）。
    isActive: function(key) { return _current.key === key; }
  };

})(window);
