/**
 * NBS 導覽系統 nav.js v6
 * 架構：所有 Drive 操作透過 GAS API1 轉發到業務員自己的 Shell GAS
 * 業務員資料完全存在自己的 Drive，管理員無法存取
 *
 * v6 變更（向下相容，未刪除任何 v5 行為）：
 * - 新增 initShell()/setActivePage()/reannounce()，供 SPA shell.html 使用
 * - _go()/_back()/_goFamily() 改為偵測 window.NBSRouter 是否存在：
 *   有 → 前端路由換頁（不整頁刷新）；沒有 → 維持原本整頁導航
 *   舊的 8 支獨立 .html 檔案沒有引入 router.js，因此行為完全不變
 */
(function(global) {
  "use strict";

  // ==========================================
  // 1. 系統設定
  // ==========================================
  var GAS_URL = "https://script.google.com/macros/s/AKfycbwzDwyZy09189eOJOs-zEwkZOml2_pJOq15nYGtHF2Kyrtv6ag5VY-I2M8sDyrt0iPdZQ/exec";

  var NAV_ITEMS = [
    { key:"policy",      label:"保險繳費", icon:"📋", href:"policy.html" },
    { key:"beneficiary", label:"受益人",   icon:"👥", href:"beneficiary.html" },
    { key:"coverage",    label:"保障清單", icon:"🛡️", href:"coverage.html" },
    { key:"summary",     label:"保單彙總", icon:"📊", href:"summary.html" },
    { key:"savings",     label:"儲蓄險",   icon:"🐷", href:"savings.html" },
    { key:"export",      label:"匯出圖片", icon:"🖼️", href:"export.html" },
    { key:"hospital",    label:"醫院病房", icon:"🏥", href:"hospital.html" },
    { key:"visit",       label:"訪談紀錄", icon:"📝", href:"visit.html" }
  ];

  // 浮動圓形導覽選單（v6.1 新增，電腦／平板測試版）：
  // 先精簡成 6 個常用項目，醫院病房、訪談紀錄暫緩收錄。
  // 只是既有 NAV_ITEMS 的過濾結果，不影響原本側欄／底部 tab。
  var FLOAT_NAV_ITEMS = NAV_ITEMS.filter(function(it) {
    return it.key !== "hospital" && it.key !== "visit";
  });
  var _floatNavOpen = false;

  var _page     = "";
  var _family   = null;
  var _personId = null;
  var _user     = null;

  // ==========================================
  // 2. GAS API 呼叫（統一 POST）
  // ==========================================
  // ── 替換 nav.js 第 2 區塊 (約第 25 行開始) ──
  // 注意：需要讓 _fetchOnce 接收 url 參數
  function _fetchOnce(url, body) {
    return fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "text/plain" },
      body:    JSON.stringify(body)
    }).then(function(r) {
      return r.text().then(function(text) {
        try { return JSON.parse(text); } 
        catch (e) { throw new Error("GAS 回應非 JSON：" + text.slice(0, 80)); }
      });
    });
  }

  function _gas(action, params) {
    var body = Object.assign({ action: action }, params || {});
    var user = _user || JSON.parse(localStorage.getItem("nbs_user") || "{}");
    if (user.email) body.email = user.email;

    // ── 核心修改：判斷是否直連 ──
    var targetUrl = GAS_URL; // 預設 API 1
    var shellUrl = localStorage.getItem("nbs_shell_url");
    var isAuthAction = (action === 'checkAuth' || action === 'registerShell' || action === 'apply');
    var isAdmin = user && user.isAdmin;

    // 非驗證動作 + 非管理員 + 有專屬網址 ➔ 直連！
    if (!isAuthAction && !isAdmin && shellUrl && shellUrl.startsWith("https://")) {
      targetUrl = shellUrl;
    }

    return _fetchOnce(targetUrl, body).catch(function(err) {
      console.warn("[nav] 請求失敗，1 秒後重試一次：", err.message || err);
      return new Promise(function(resolve) { setTimeout(resolve, 1000); })
        .then(function() { return _fetchOnce(targetUrl, body); });
    });
  }

  // ==========================================
  // 3. 公開 API
  // ==========================================
  global.NBS_NAV = {
    // 每支獨立頁面尾端都會呼叫 NBS_NAV.init({page:"xxx"})，這是既有
    // 8 支頁面共通的既有寫法，完全不用改。
    //
    // 重要修正（Phase 2 發現，回溯修正 Phase 1）：
    // 在 SPA shell（router.js 存在）底下，這支頁面的 <script> 會被
    // router 重新執行一次，代表 init() 也會被重新呼叫一次。如果直接
    // 照舊跑 _setup()，會再呼叫一次 _insertNav()，等於在 DOM 裡多插入
    // 一組一模一樣、位置完全重疊的側欄/底部 tab/mobile header/成員
    // modal —— 因為 CSS 是 position:fixed 且內容相同，兩組會完全疊在
    // 一起，肉眼幾乎看不出來，但 DOM 節點數會隨著換頁次數一直增加，
    // 且哪一組實際接收點擊事件會變得不可預期。
    //
    // 修法：偵測到 window.NBSRouter 存在（代表現在跑在 SPA shell 底
    // 下），就只同步「目前頁面」讓側欄高亮正確，不重建 DOM、不重載
    // 資料（shell 已經在 initShell() 時做過一次）。
    init: function(opts) {
      _page = opts.page || "";
      if (global.NBSRouter) {
        NBS_NAV.setActivePage(_page);
        return;
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function() { _setup(opts); });
      } else {
        _setup(opts);
      }
    },

    // ── SPA Shell 專用進入點（v6 新增）──────────────────────
    // 與 init() 不同：只在 shell 頁面呼叫「一次」，負責注入樣式、
    // 建立側欄 DOM、載入家庭資料。之後切換內容頁一律呼叫
    // setActivePage()，不會重新跑這裡的邏輯。
    initShell: function() {
      _injectStyles();
      _insertNav();

      var savedUser = localStorage.getItem("nbs_user");
      if (!savedUser) { window.location.href = "index.html"; return; }
      _user = JSON.parse(savedUser);

      _loadData({});
    },

    // SPA 路由切換內容頁後呼叫：只更新側欄高亮狀態，不重抓資料、
    // 不重建側欄 DOM（成本極低，純字串 re-render 一次側欄/底部 tab）。
    setActivePage: function(key) {
      _page = key || "";
      _renderSidebar();
      _renderBottomTab();
      _renderFloatNav();
    },

    // 讓 SPA 路由在換頁、重新執行該頁 <script> 後，
    // 補發一次 nbs_nav_ready，讓該頁重新註冊的監聽器能拿到現有資料
    // （資料本身沿用 shell 已載入的記憶體內容，不會重打 GAS）。
    reannounce: function() {
      var fn = localStorage.getItem("nbs_current_family");
      _finishLoad(fn, !_family);
    },

    getCurrentPersonId:    function() { return _personId; },
    getFamilyData:         function() { return _family; },
    getPersonsData:        function() { return _personsData; },
    getUser:               function() { return _user; },
    invalidateBundleCache: function(fn) { _invalidateBundleCache(fn || localStorage.getItem("nbs_current_family")); },

    // callGAS：統一入口，所有頁面呼叫此函式
    callGAS: function(action, params) {
      return _gas(action, params);
    },

    onMemberChange: null,
  };

  // ==========================================
  // 4. 初始化
  // ==========================================
  function _setup(opts) {
    _injectStyles();
    _insertNav();

    var savedUser = localStorage.getItem("nbs_user");
    if (!savedUser) {
      if (window.location.href.indexOf("index.html") === -1) {
        window.location.href = "index.html";
      }
      return;
    }
    _user = JSON.parse(savedUser);

    // main.html 不載入 family 資料
    if (window.location.href.indexOf("main.html") !== -1) return;

    _loadData(opts);
  }

  // ==========================================
  // 5. 載入家庭資料
  // ==========================================
  var _personsData = {};

  // bug 修正：nbs_current_person 是全域的 localStorage 設定，
  // 切換家庭時並不會自動清掉，導致「家庭A 選的成員 ID」被誤用到
  // 「家庭B」身上。這裡統一驗證 ID 是否真的屬於目前家庭。
  function _resolvePersonId(family) {
    var members = (family && family.members) || [];
    var cached  = localStorage.getItem("nbs_current_person");
    var valid   = cached && members.some(function(m) { return m.personId === cached; });
    if (valid) return cached;
    var fallback = members[0] && members[0].personId || null;
    if (cached && !valid) {
      if (fallback) localStorage.setItem("nbs_current_person", fallback);
      else localStorage.removeItem("nbs_current_person");
    }
    return fallback;
  }

  // ── sessionStorage 快取輔助函式 ────────────────────────────
  // 目的：讓同一個工作階段內切換頁面時，可以立即從 sessionStorage
  // 拿到上次抓到的資料直接顯示（< 50ms），不用再等 GAS 的 5 秒冷啟動。
  // 第一次仍然需要完整等待，之後的每次切換都會秒開。
  var BUNDLE_CACHE_TTL = 10 * 60 * 1000; // 10 分鐘

  function _getBundleCache(fn) {
    try {
      var raw = sessionStorage.getItem("nbs_bundle_" + fn);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.ts || !obj.data) return null;
      if (Date.now() - obj.ts > BUNDLE_CACHE_TTL) {
        sessionStorage.removeItem("nbs_bundle_" + fn);
        return null;
      }
      return obj.data;
    } catch(e) { return null; }
  }

  function _setBundleCache(fn, data) {
    try {
      sessionStorage.setItem("nbs_bundle_" + fn, JSON.stringify({ ts: Date.now(), data: data }));
    } catch(e) {}
  }

  // 儲存成功後呼叫此函式，清除對應的快取，下次載入才會拿到最新資料
  function _invalidateBundleCache(fn) {
    try {
      if (fn) sessionStorage.removeItem("nbs_bundle_" + fn);
    } catch(e) {}
  }

  function _applyBundle(fr, fn) {
    _family      = fr.family;
    _personsData = fr.persons || {};
    _personId    = _resolvePersonId(_family);
    _setBundleCache(fn, fr);
    _finishLoad(fn, false);
  }

  function _loadData(opts) {
    var fn = localStorage.getItem("nbs_current_family");
    if (!fn) { window.location.href = "main.html"; return; }

    // ── Step 1：先查 sessionStorage 快取，有就立即渲染 ─────────
    var cached = _getBundleCache(fn);
    if (cached && cached.family) {
      _family      = cached.family;
      _personsData = cached.persons || {};
      _personId    = _resolvePersonId(_family);
      _finishLoad(fn, false); // 立即顯示，< 50ms

      // ── Step 2：背景靜默更新，讓資料保持最新 ─────────────────
      // 不阻塞頁面，失敗也沒關係（下次開頁面會重抓）
      setTimeout(function() {
        _gas("readFamilyBundle", { fileType: "families", fileName: fn })
          .then(function(fr) {
            if (fr && fr.status === "ok" && fr.family) {
              _setBundleCache(fn, fr);
              // 靜默更新記憶體中的資料，不再重新觸發 nbs_nav_ready
              _family      = fr.family;
              _personsData = fr.persons || {};
            }
          }).catch(function() {});
      }, 200);
      return;
    }

    // ── 快取未命中：正常流程（第一次或快取過期）──────────────────
    _gas("readFamilyBundle", { fileType: "families", fileName: fn })
      .then(function(fr) {
        if (fr && fr.status === "ok" && fr.family) {
          _applyBundle(fr, fn);
          return;
        }
        if (fr && fr.needInstall) { window.location.href = "install.html"; return; }
        // 降級回舊版 readFile
        _gas("readFile", { fileType: "families", fileName: fn })
          .then(function(fr2) {
            if (!fr2 || fr2.status === "not_found" || !fr2.content) {
              if (fr2 && fr2.needInstall) { window.location.href = "install.html"; return; }
              _finishLoad(fn, true); return;
            }
            _family = fr2.content;
            _personsData = {};
            _personId = _resolvePersonId(_family);
            _finishLoad(fn, false);
          })
          .catch(function(e) { console.error("[nav] 載入家庭失敗", e); _finishLoad(fn, true); });
      })
      .catch(function(e) { console.error("[nav] 載入家庭失敗", e); _finishLoad(fn, true); });
  }

  function _finishLoad(fn, isError) {
    _renderAll();
    window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
      detail: {
        user:            _user,
        familyData:      isError ? null : _family,
        personsData:     isError ? null : _personsData,
        currentPersonId: isError ? null : _personId,
        familyFileName:  fn
      }
    }));
  }

  // family.html 先載入資料後通知 nav 補渲染
  window.addEventListener("nbs_family_loaded", function(e) {
    if (_family) return;
    var detail = e.detail || {};
    _family = detail.familyData || null;
    if (!_family) return;
    _personId = (_family.members && _family.members[0] && _family.members[0].personId) || null;
    _renderAll();
  });

  // 各頁面載入完資料後通知 nav
  window.addEventListener("nbs_page_data_ready", function(e) {
    if (_family) return;
    var detail = e.detail || {};
    if (!detail.familyData) return;
    _family = detail.familyData;
    _personId = detail.currentPersonId ||
      (_family.members && _family.members[0] && _family.members[0].personId) || null;
    _renderAll();
  });

  // ==========================================
  // 6. UI 插入與渲染
  // ==========================================
  function _insertNav() {
    var sidebar = document.createElement("div");
    sidebar.id = "nbs-sidebar";
    sidebar.innerHTML =
      '<div class="nbs-logo">' +
        '<img src="https://i.ibb.co/FkVkNhhd/NBS-4F3.jpg" class="nbs-logo-img" onerror="this.style.display=\'none\'"/>' +
      '</div>' +
      '<div style="padding:14px 16px;color:#9CA3AF;font-size:12px">連線同步中…</div>';
    document.body.insertBefore(sidebar, document.body.firstChild);

    var tab = document.createElement("div");
    tab.id = "nbs-bottom-tab";
    document.body.appendChild(tab);

    // 獨立於 #nbs-bottom-tab 之外，避免被它的 overflow-x:auto
    // （連帶讓 overflow-y 隱性變成 auto）裁切掉往上長出去的彈出選單
    var moreMenu = document.createElement("div");
    moreMenu.id = "nbs-bottom-more-menu";
    moreMenu.style.display = "none";
    document.body.appendChild(moreMenu);

    var hdr = document.createElement("div");
    hdr.id = "nbs-mobile-hdr";
    document.body.insertBefore(hdr, sidebar.nextSibling);

    _applyLayout();
    window.addEventListener("resize", _debounce(_applyLayout, 150));

    // 成員管理 Modal
    var modal = document.createElement("div");
    modal.id = "nbs-member-modal";
    modal.innerHTML =
      '<div id="nbs-member-modal-box">' +
        '<div class="nbs-mm-head">' +
          '<span class="nbs-mm-title">👨‍👩‍👧 家庭成員管理</span>' +
          '<button class="nbs-mm-close" onclick="NBS_NAV._closeMemberModal()">×</button>' +
        '</div>' +
        '<div class="nbs-mm-body" id="nbs-mm-list"></div>' +
        '<div id="nbs-edit-member-form">' +
          '<div class="nbs-ef-row">' +
            '<div><label class="nbs-ef-label">姓名 *</label><input class="nbs-ef-input" id="nbs-ef-name" placeholder="姓名"/></div>' +
            '<div><label class="nbs-ef-label">關係</label>' +
              '<select class="nbs-ef-input" id="nbs-ef-relation" style="padding:7px 11px">' +
                '<option value="本人">本人</option><option value="配偶">配偶</option>' +
                '<option value="子女">子女</option><option value="父母">父母</option>' +
                '<option value="其他">其他</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<label class="nbs-ef-label">出生日期</label>' +
          '<input class="nbs-ef-input" id="nbs-ef-birth" type="date" oninput="NBS_NAV._updateEfAge()"/>' +
          '<div class="nbs-ef-hint" id="nbs-ef-age-hint"></div>' +
          '<label class="nbs-ef-label">住家地址（縣市＋區）</label>' +
          '<input class="nbs-ef-input" id="nbs-ef-address" placeholder="如：台北市中正區"/>' +
          '<div class="nbs-ef-btns">' +
            '<button class="nbs-ef-cancel" onclick="NBS_NAV._closeEfForm()">取消</button>' +
            '<button class="nbs-ef-save" onclick="NBS_NAV._saveEfMember()">儲存</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    modal.onclick = function(e){ if(e.target===modal) NBS_NAV._closeMemberModal(); };
    document.body.appendChild(modal);

    // 浮動圓形導覽選單（可拖曳＋依位置動態決定展開角度，僅電腦／平板顯示）
    var floatNav = document.createElement("div");
    floatNav.id = "nbs-float-nav";
    floatNav.innerHTML =
      '<div id="nbs-float-items"></div>' +
      '<button id="nbs-float-fab" aria-label="展開導覽選單，可拖曳移動位置">' +
        '<span id="nbs-float-fab-icon">☰</span>' +
      '</button>';
    document.body.appendChild(floatNav);
    _initFloatNavPosition();
    _initFloatNavDrag();
    document.addEventListener("click", function(e){
      var wrap = document.getElementById("nbs-float-nav");
      if (!wrap || !_floatNavOpen) return;
      if (!wrap.contains(e.target)) NBS_NAV._closeFloatNav();
    });
  }

  function _applyLayout() {
    var mobile   = window.innerWidth < 768;
    var sidebar  = document.getElementById("nbs-sidebar");
    var tab      = document.getElementById("nbs-bottom-tab");
    var hdr      = document.getElementById("nbs-mobile-hdr");
    var floatNav = document.getElementById("nbs-float-nav");
    // 浮動圓形選單目前只在電腦／平板測試，手機版先隱藏、沿用底部 tab
    if (floatNav) {
      floatNav.style.display = mobile ? "none" : "block";
      if (mobile) {
        NBS_NAV._closeFloatNav();
      } else {
        var fr = floatNav.getBoundingClientRect();
        _applyFloatNavPos(fr.left, fr.top);
        _renderFloatNav();
      }
    }
    if (!sidebar) return;
    if (mobile) {
      sidebar.style.display = "none";
      tab.style.display = "flex";
      hdr.style.display = "block";
      document.body.style.paddingLeft = "0";
      document.body.style.paddingTop  = "50px";
      document.body.style.paddingBottom = "66px";
    } else {
      sidebar.style.display = "flex";
      tab.style.display = "none";
      hdr.style.display = "none";
      document.body.style.paddingLeft = "200px";
      document.body.style.paddingTop  = "0";
      document.body.style.paddingBottom = "0";
    }
  }

  function _renderAll() {
    _renderSidebar();
    _renderBottomTab();
    _renderMobileHdr();
    _renderFloatNav();
    _applyLayout();
  }

  function _renderSidebar() {
    var el = document.getElementById("nbs-sidebar");
    if (!el) return;
    if (!_family) {
      el.innerHTML =
        '<div class="nbs-logo">' +
          '<img src="https://i.ibb.co/FkVkNhhd/NBS-4F3.jpg" class="nbs-logo-img" onerror="this.style.display=\'none\'"/>' +
        '</div>' +
        '<div style="flex:1"></div>' +
        '<div class="nbs-foot">' +
          '<button class="nbs-bbtn" onclick="NBS_NAV._back()">← 返回家庭列表</button>' +
        '</div>';
      return;
    }
    var navHtml = NAV_ITEMS.map(function(item) {
      var active = _page === item.key;
      return '<div class="nbs-ni'+(active?" nbs-ni-on":"")+'" onclick="NBS_NAV._go(\''+item.href+'\')">' +
        '<span class="nbs-nicon">'+item.icon+'</span>' +
        '<span class="nbs-nlabel">'+item.label+'</span>' +
      '</div>';
    }).join("");
    el.innerHTML =
      '<div class="nbs-logo">' +
        '<img src="https://i.ibb.co/FkVkNhhd/NBS-4F3.jpg" class="nbs-logo-img" onerror="this.style.display=\'none\'"/>' +
      '</div>' +
      '<div class="nbs-fam">' +
        '<div class="nbs-fn">'+_versionIconHtml()+_family.familyName+'</div>' +
        '<div class="nbs-fd">分析日 '+_fmtROC(_family.analysisDate)+'</div>' +
      '</div>' +
      '<div class="nbs-nsec">' +
        '<div class="nbs-sl">功能模組</div>' +
        navHtml +
      '</div>' +
      '<div class="nbs-row2">' +
        '<button class="nbs-row2-btn" onclick="NBS_NAV._goFamily()">🏠 保單首頁</button>' +
        '<button class="nbs-row2-btn" onclick="NBS_NAV._print()">🖨️ 列印此頁</button>' +
      '</div>' +
      '<div class="nbs-row2">' +
        _productLinksHtml() +
        _versionActionsHtml() +
      '</div>' +
      '<div class="nbs-foot">' +
        '<button class="nbs-row2-btn nbs-row2-btn-ghost" style="width:100%" onclick="NBS_NAV._back()">← 返回列表</button>' +
      '</div>';
  }

  // ── 現況/草案/歷史現況：標題前的精簡圖示 + 底部可收合的版本管理 ──
  // 設計原則：「功能模組」是每天都在用的核心導覽，優先保持在最顯眼、
  // 不用捲動就看得到的位置；另存新檔/升格/刪除草案是偶爾才用的操作，
  // 收進底部一個預設收合的區塊，不跟核心功能搶版面。
  function _versionIconHtml() {
    var role = _family.role || "current";
    if (role === "current") return "";
    var icon = role === "draft" ? "📝" : "📦";
    var title = role === "draft" ? "草案"+(_family.draftLabel?"："+_family.draftLabel:"") : "歷史現況";
    return '<span title="'+title+'" style="margin-right:4px">'+icon+'</span>';
  }

  // ── 商品資料查詢：跟目前開啟哪個家庭無關的通用保司商品知識庫連結 ──
  // 設計原則同「版本管理」：偶爾才查、但需要隨時點得到，所以收進
  // 預設收合的區塊，不跟「功能模組」的每日核心操作搶版面。未來要
  // 加其他保險公司的資料庫，往 PRODUCT_LINKS 陣列加項目即可。
  var PRODUCT_LINKS = [
    { icon:"📘", label:"富邦｜醫療長照癌症豁免總覽", url:"https://notebooklm.google.com/notebook/a8816f85-d71e-4701-8a7e-5890ebce0759" },
    { icon:"📗", label:"富邦｜現售商品總覽",         url:"https://notebooklm.google.com/notebook/dd52844f-700f-4d05-8d1a-ac39eef067c0" }
  ];

  function _productLinksHtml() {
    var items = PRODUCT_LINKS.map(function(p) {
      return '<a class="nbs-ni nbs-ni-sm" href="'+p.url+'" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">' +
        '<span class="nbs-nicon">'+p.icon+'</span>' +
        '<span class="nbs-nlabel">'+p.label+'</span>' +
      '</a>';
    }).join("");
    return '<div class="nbs-vm">' +
      '<button class="nbs-row2-btn nbs-row2-btn-ghost" style="width:100%" onclick="event.stopPropagation();NBS_NAV._toggleVersionMenu(this)">📚 富壽查詢</button>' +
      '<div class="nbs-vm-menu">'+items+'</div>' +
    '</div>';
  }

  function _versionActionsHtml() {
    var role = _family.role || "current";
    var items = '<div class="nbs-ni nbs-ni-sm" onclick="event.stopPropagation();NBS_NAV._promptCreateDraft()">' +
      '<span class="nbs-nicon">📝</span>' +
      '<span class="nbs-nlabel">另存新檔（建立提案草案）</span>' +
    '</div>';
    if (role === "draft") {
      items += '<div class="nbs-ni nbs-ni-sm" onclick="event.stopPropagation();NBS_NAV._promptPromoteDraft()">' +
        '<span class="nbs-nicon">✅</span>' +
        '<span class="nbs-nlabel">升格為現況</span>' +
      '</div>';
      items += '<div class="nbs-ni nbs-ni-sm" onclick="event.stopPropagation();NBS_NAV._promptDeleteDraft()">' +
        '<span class="nbs-nicon">🗑️</span>' +
        '<span class="nbs-nlabel">刪除此草案</span>' +
      '</div>';
    }
    items += '<div class="nbs-ni nbs-ni-sm" style="color:#b91c1c" onclick="event.stopPropagation();NBS_NAV._promptDeleteEntireFamily()">' +
      '<span class="nbs-nicon">🗑️</span>' +
      '<span class="nbs-nlabel">刪除整個檔案</span>' +
    '</div>';
    return '<div class="nbs-vm">' +
      '<button class="nbs-row2-btn nbs-row2-btn-ghost" onclick="event.stopPropagation();NBS_NAV._toggleVersionMenu(this)">⋯ 版本管理</button>' +
      '<div class="nbs-vm-menu">'+items+'</div>' +
    '</div>';
  }

  global.NBS_NAV._toggleVersionMenu = function(btn) {
    var wrap = btn.parentElement;
    var wasOpen = wrap.classList.contains("nbs-vm-open");
    document.querySelectorAll(".nbs-vm-open").forEach(function(o){ o.classList.remove("nbs-vm-open"); });
    if (!wasOpen) wrap.classList.add("nbs-vm-open");
  };
  document.addEventListener("click", function(){
    document.querySelectorAll(".nbs-vm-open").forEach(function(o){ o.classList.remove("nbs-vm-open"); });
  });

  function _renderBottomTab() {
    var el = document.getElementById("nbs-bottom-tab");
    if (!el) return;
    var itemsHtml = NAV_ITEMS.map(function(item) {
      var active = _page === item.key;
      return '<div class="nbs-ti'+(active?" nbs-ti-on":"")+'" onclick="NBS_NAV._go(\''+item.href+'\')">' +
        '<span style="font-size:20px">'+item.icon+'</span>' +
        '<span class="nbs-tl">'+item.label+'</span>' +
        (active ? '<div class="nbs-tdot"></div>' : '') +
      '</div>';
    }).join("");
    // 手機版底部列原本只有 8 個核心功能，「返回列表」「版本管理」
    // 「富壽查詢」這幾個桌面版側欄才有的功能，統一收進「⋯更多」
    // 彈出選單，避免底部列被塞爆。
    var moreHtml = '<div class="nbs-ti" id="nbs-bottom-more-btn" onclick="NBS_NAV._toggleBottomMore(event)">' +
      '<span style="font-size:20px">⋯</span>' +
      '<span class="nbs-tl">更多</span>' +
    '</div>';
    el.innerHTML = '<div style="display:flex">'+itemsHtml+moreHtml+'</div>';

    // 這個選單不能放在 #nbs-bottom-tab 裡面當子元素——那個容器有
    // overflow-x:auto（讓 8 個圖示可以左右滑動），瀏覽器規則是只要設了
    // overflow-x，overflow-y 也會自動跟著變成裁切模式，選單往上彈出超出
    // 容器範圍就會被裁掉、變成「點了但看不到」。改成獨立掛在 body 底下、
    // position:fixed，完全不受任何父層 overflow 影響。
    var menu = document.getElementById("nbs-bottom-more-menu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "nbs-bottom-more-menu";
      document.body.appendChild(menu);
    }
    menu.innerHTML =
      '<div class="nbs-ni nbs-ni-sm" onclick="NBS_NAV._back()">' +
        '<span class="nbs-nicon">←</span><span class="nbs-nlabel">返回列表</span>' +
      '</div>' +
      _versionActionsHtml() +
      _productLinksHtml();
  }

  global.NBS_NAV._toggleBottomMore = function(e) {
    if (e) e.stopPropagation();
    var m = document.getElementById("nbs-bottom-more-menu");
    if (!m) return;
    m.style.display = (m.style.display === "block") ? "none" : "block";
  };
  // 點選單或按鈕以外的任何地方，才把選單收起來——用明確判斷點擊
  // 位置是否落在選單/按鈕範圍內，取代容易受事件時序影響的 stopPropagation。
  document.addEventListener("click", function(e){
    var m = document.getElementById("nbs-bottom-more-menu");
    if (!m || m.style.display !== "block") return;
    var btn = document.getElementById("nbs-bottom-more-btn");
    if (m.contains(e.target) || (btn && btn.contains(e.target))) return;
    m.style.display = "none";
  });

  // ── 浮動選單定位（可拖曳、記憶位置）──────────────────────
  // 座標概念：#nbs-float-nav 本身是一個 0 大小的錨點，固定在
  // (left, top)；fab 用 right:0;bottom:0 貼齊這個錨點，等於錨點
  // 就是 fab 的右下角。拖曳只是改變這個錨點座標。
  function _clampFloatPos(left, top) {
    var minL = 64, maxL = window.innerWidth - 8;
    var minT = 64, maxT = window.innerHeight - 8;
    return {
      left: Math.max(minL, Math.min(maxL, left)),
      top:  Math.max(minT, Math.min(maxT, top))
    };
  }
  function _loadFloatNavPos() {
    try {
      var raw = localStorage.getItem("nbs_float_nav_pos");
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (typeof p.left !== "number" || typeof p.top !== "number") return null;
      return p;
    } catch (e) { return null; }
  }
  function _saveFloatNavPos(left, top) {
    try { localStorage.setItem("nbs_float_nav_pos", JSON.stringify({ left: left, top: top })); }
    catch (e) {}
  }
  function _applyFloatNavPos(left, top) {
    var wrap = document.getElementById("nbs-float-nav");
    if (!wrap) return;
    var p = _clampFloatPos(left, top);
    wrap.style.left = p.left + "px";
    wrap.style.top  = p.top + "px";
  }
  function _initFloatNavPosition() {
    var saved = _loadFloatNavPos();
    if (saved) { _applyFloatNavPos(saved.left, saved.top); return; }
    _applyFloatNavPos(window.innerWidth - 28, window.innerHeight - 28);
  }
  function _initFloatNavDrag() {
    var fab  = document.getElementById("nbs-float-fab");
    var wrap = document.getElementById("nbs-float-nav");
    if (!fab || !wrap) return;
    var dragging = false, moved = false, startX, startY, origLeft, origTop;
    fab.addEventListener("pointerdown", function(e) {
      if (_floatNavOpen) return; // 展開狀態下不拖曳，避免跟點選項目衝突
      dragging = true; moved = false;
      var r = wrap.getBoundingClientRect();
      origLeft = r.left; origTop = r.top;
      startX = e.clientX; startY = e.clientY;
      try { fab.setPointerCapture(e.pointerId); } catch (err) {}
    });
    fab.addEventListener("pointermove", function(e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      _applyFloatNavPos(origLeft + dx, origTop + dy);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        var r = wrap.getBoundingClientRect();
        _saveFloatNavPos(r.left, r.top);
        _renderFloatNav(); // 位置變了，重新計算展開角度
      }
    }
    fab.addEventListener("pointerup", endDrag);
    fab.addEventListener("pointercancel", endDrag);
    fab.addEventListener("click", function(e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return; }
      NBS_NAV._toggleFloatNav();
    });
  }

  // ── 依 fab 目前位置，動態決定扇形展開的起訖角度 ──────────────
  // 角度定義：0°=右、90°=下、180°=左、270°=上（沿順時針）。
  // 靠邊角只給 90°、貼單邊給 180°、四周都空曠就給滿 360°。
  function _computeFloatArc() {
    var wrap = document.getElementById("nbs-float-nav");
    if (!wrap) return { start: 180, end: 270 };
    var r = wrap.getBoundingClientRect();
    var left = r.left, top = r.top;
    var threshold = 150; // 半徑 + 圖示半寬 + 安全間距
    var canRight = (window.innerWidth  - left) >= threshold;
    var canLeft  = (left - 56)                 >= threshold;
    var canDown  = (window.innerHeight - top)  >= threshold;
    var canUp    = (top - 56)                  >= threshold;
    var count = [canLeft, canRight, canUp, canDown].filter(Boolean).length;

    if (count >= 4) return { start: -90, end: 270 }; // 四周都空曠：整圈 360°
    if (count === 3) {
      if (!canRight) return { start: 90,  end: 270 };
      if (!canLeft)  return { start: -90, end: 90  };
      if (!canUp)    return { start: 0,   end: 180 };
      if (!canDown)  return { start: 180, end: 360 };
    }
    if (count === 2) {
      if (!canRight && !canDown) return { start: 180, end: 270 }; // 右下角
      if (!canLeft  && !canDown) return { start: 270, end: 360 }; // 左下角
      if (!canRight && !canUp)   return { start: 90,  end: 180 }; // 右上角
      if (!canLeft  && !canUp)   return { start: 0,   end: 90  }; // 左上角
    }
    if (count === 1) {
      var center = canRight ? 0 : canDown ? 90 : canLeft ? 180 : 270;
      return { start: center - 45, end: center + 45 };
    }
    return { start: 180, end: 270 }; // 極端情況（例如卡在窄欄中間）的保底扇形
  }

  function _renderFloatNav() {
    var wrap = document.getElementById("nbs-float-items");
    if (!wrap) return;
    var arc    = _computeFloatArc();
    var span   = arc.end - arc.start;
    var isFull = span >= 359; // 整圈時頭尾角度重疊，要用 n 等分而非 n-1
    var n = FLOAT_NAV_ITEMS.length;
    var radius = 108;
    wrap.innerHTML = FLOAT_NAV_ITEMS.map(function(item, i) {
      var t   = isFull ? (i / n) : (n > 1 ? i / (n - 1) : 0.5);
      var deg = arc.start + span * t;
      var rad = deg * Math.PI / 180;
      var tx  = Math.round(Math.cos(rad) * radius);
      var ty  = Math.round(Math.sin(rad) * radius);
      var active = _page === item.key;
      return '<div class="nbs-float-item'+(active?" nbs-float-item-on":"")+'" style="--tx:'+tx+'px;--ty:'+ty+'px" onclick="NBS_NAV._go(\''+item.href+'\');NBS_NAV._closeFloatNav()" title="'+item.label+'">' +
        '<span class="nbs-float-icon">'+item.icon+'</span>' +
        '<span class="nbs-float-label">'+item.label+'</span>' +
      '</div>';
    }).join("");
  }

  global.NBS_NAV._toggleFloatNav = function() {
    _floatNavOpen = !_floatNavOpen;
    var wrap = document.getElementById("nbs-float-nav");
    var icon = document.getElementById("nbs-float-fab-icon");
    if (_floatNavOpen) _renderFloatNav(); // 展開當下才重算角度，確保拖曳後的位置生效
    if (wrap) wrap.classList.toggle("nbs-float-open", _floatNavOpen);
    if (icon) icon.textContent = _floatNavOpen ? "✕" : "☰";
  };
  global.NBS_NAV._closeFloatNav = function() {
    if (!_floatNavOpen) return;
    _floatNavOpen = false;
    var wrap = document.getElementById("nbs-float-nav");
    var icon = document.getElementById("nbs-float-fab-icon");
    if (wrap) wrap.classList.remove("nbs-float-open");
    if (icon) icon.textContent = "☰";
  };

  function _renderMobileHdr() {
    var el = document.getElementById("nbs-mobile-hdr");
    if (!el || !_family) return;
    var members = (_family.members||[]).filter(function(m){ return m.role !== "beneficiary_only"; });
    var opts = members.map(function(m){
      return '<option value="'+m.personId+'"'+(m.personId===_personId?" selected":"")+'>'+m.name+'（'+(m.relation||m.role)+'）</option>';
    }).join("") + '<option value="__add__">＋ 新增成員</option>';
    el.innerHTML =
      '<img src="https://i.ibb.co/FkVkNhhd/NBS-4F3.jpg" style="height:28px;width:auto;object-fit:contain;flex-shrink:0" onerror="this.style.display=\'none\'"/>' +
      '<div style="flex:1;min-width:0;font-size:11px;color:#374151;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_family.familyName+'</div>' +
      '<select onchange="NBS_NAV._setPerson(this.value)" style="padding:4px 8px;font-size:12px;border:none;border-radius:99px;background:rgba(109,40,217,0.1);color:#4C1D95;outline:none;cursor:pointer;font-family:inherit;font-weight:600">'+opts+'</select>' +
      '<button onclick="NBS_NAV._print()" style="padding:5px 8px;background:rgba(109,40,217,0.1);border:none;border-radius:6px;color:#4C1D95;font-size:13px;cursor:pointer">🖨️</button>';
  }

  // ==========================================
  // 7. 成員管理
  // ==========================================
  var _editingPersonId = null;

  global.NBS_NAV._openMemberModal = function() {
    if (!_family) return;
    var listEl = document.getElementById("nbs-mm-list");
    if (!listEl) return;
    var members = (_family.members||[]).filter(function(m){ return m.role !== "beneficiary_only"; });
    var html = "";
    members.forEach(function(m) {
      html += '<div class="nbs-mm-member">' +
        '<div class="nbs-mm-avatar">'+m.name[0]+'</div>' +
        '<div class="nbs-mm-info">' +
          '<div class="nbs-mm-name">'+m.name+'</div>' +
          '<div class="nbs-mm-sub">'+(m.relation||m.role)+'</div>' +
        '</div>' +
        '<button class="nbs-mm-edit" onclick="NBS_NAV._openEfForm(\''+m.personId+'\')">✏️ 編輯</button>' +
      '</div>';
    });
    html += '<button class="nbs-mm-add" onclick="NBS_NAV._openEfForm(null)">＋ 新增家庭成員</button>';
    listEl.innerHTML = html;
    document.getElementById("nbs-edit-member-form").style.display = "none";
    document.getElementById("nbs-member-modal").classList.add("open");
  };

  global.NBS_NAV._closeMemberModal = function() {
    document.getElementById("nbs-member-modal").classList.remove("open");
  };

  global.NBS_NAV._openEfForm = function(personId) {
    _editingPersonId = personId;
    var form = document.getElementById("nbs-edit-member-form");
    form.style.display = "block";
    if (personId) {
      var m  = (_family.members||[]).find(function(x){ return x.personId===personId; });
      var pd = (window.personDataMap && window.personDataMap[personId]) || null;
      var profile = (pd && pd.profile) || {};
      document.getElementById("nbs-ef-name").value     = m ? m.name : (profile.name || "");
      document.getElementById("nbs-ef-relation").value = m ? (m.relation||"本人") : "本人";
      document.getElementById("nbs-ef-birth").value    = m ? (m.birthDate||"") : (profile.birthDate||"");
      document.getElementById("nbs-ef-address").value  = profile.address || (m && m.address) || "";
      NBS_NAV._updateEfAge();
    } else {
      document.getElementById("nbs-ef-name").value = "";
      document.getElementById("nbs-ef-relation").value = "本人";
      document.getElementById("nbs-ef-birth").value = "";
      document.getElementById("nbs-ef-address").value = "";
      document.getElementById("nbs-ef-age-hint").textContent = "";
    }
    form.scrollIntoView({behavior:"smooth"});
  };

  global.NBS_NAV._closeEfForm = function() {
    document.getElementById("nbs-edit-member-form").style.display = "none";
    _editingPersonId = null;
  };

  global.NBS_NAV._updateEfAge = function() {
    var birth = document.getElementById("nbs-ef-birth").value;
    var hint  = document.getElementById("nbs-ef-age-hint");
    if (!birth) { hint.textContent = ""; return; }
    var b = new Date(birth), a = new Date(_family && _family.analysisDate || new Date());
    var y = a.getFullYear() - b.getFullYear();
    if ((a - new Date(b.getFullYear()+y, b.getMonth(), b.getDate())) / (1000*60*60*24*30.4375) >= 6) y++;
    hint.textContent = "保險年齡：" + y + "歲";
  };

  global.NBS_NAV._saveEfMember = function() {
    var name    = document.getElementById("nbs-ef-name").value.trim();
    var rel     = document.getElementById("nbs-ef-relation").value;
    var birth   = document.getElementById("nbs-ef-birth").value;
    var address = document.getElementById("nbs-ef-address").value.trim();
    if (!name) { alert("請填寫姓名"); return; }

    var saveBtn = document.querySelector(".nbs-ef-save");
    saveBtn.textContent = "儲存中…"; saveBtn.disabled = true;

    var fn = localStorage.getItem("nbs_current_family");

    Promise.resolve().then(function() {
      if (_editingPersonId) {
        var m = (_family.members||[]).find(function(x){ return x.personId===_editingPersonId; });
        if (m) { m.name=name; m.relation=rel; m.birthDate=birth||null; }
        var p = window.personDataMap && window.personDataMap[_editingPersonId];
        if (p) {
          p.profile.name=name; p.profile.birthDate=birth||null; p.profile.address=address||null;
          p.updatedAt = new Date().toISOString();
          return _gas("saveFile", {
            fileType: "persons",
            fileName: name+"_"+_editingPersonId+".json",
            content:  p
          });
        }
      } else {
        var newId = "p_" + Date.now();
        var newPerson = {
          personId: newId,
          profile:  { name:name, birthDate:birth||null, analysisDate:_family.analysisDate, address:address||null },
          policies: [], coverage: {}, savings: [],
          updatedAt: new Date().toISOString()
        };
        if (!window.personDataMap) window.personDataMap = {};
        window.personDataMap[newId] = newPerson;
        _family.members.push({ personId:newId, name:name, role:"secondary", relation:rel, birthDate:birth||null });
        return _gas("saveFile", {
          fileType: "persons",
          fileName: name+"_"+newId+".json",
          content:  newPerson
        });
      }
    }).then(function() {
      _family.updatedAt = new Date().toISOString();
      return _gas("saveFile", {
        fileType: "families",
        fileName: fn,
        content:  _family
      });
    }).then(function() {
      NBS_NAV._closeMemberModal();
      _renderSidebar();
      if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(_editingPersonId);
      alert("已儲存！");
    }).catch(function(e) {
      alert("儲存失敗：" + e.message);
    }).finally(function() {
      saveBtn.textContent = "儲存"; saveBtn.disabled = false;
    });
  };

  // ==========================================
  // 8. 動作
  // ==========================================
  global.NBS_NAV._setPerson = function(id) {
    if (id === "__add__") { NBS_NAV._openMemberModal(); return; }
    _personId = id;
    localStorage.setItem("nbs_current_person", id);
    _renderAll();
    if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(id);
  };
  // 統一導航：若頁面上有載入 router.js（SPA shell 模式）就走前端路由，
  // 不整頁刷新；沒有 router.js（舊的獨立 .html 頁面直接開啟）則維持
  // 原本 window.location.href 整頁導航，行為完全不變。
  function _navigate(href) {
    if (global.NBSRouter && typeof global.NBSRouter.navigate === "function") {
      global.NBSRouter.navigate(href);
    } else {
      window.location.href = href;
    }
  }
  global.NBS_NAV._go       = function(href) { _navigate(href); };
  global.NBS_NAV._print    = function() { window.print(); };
  global.NBS_NAV._back     = function() { _navigate("main.html"); };
  global.NBS_NAV._goFamily = function() { _navigate("family.html"); };

  // ── 另存新檔（建立提案草案）/ 升格 / 刪除草案 ─────────────
  // 重要：家庭檔案只是「成員名單」，每位成員真正的保單/保障資料存在
  // 獨立的「個人」檔案裡（用 personId 對應）。另存新檔時，家庭檔案
  // 跟每一位成員的個人檔案都要各自複製一份、給新的 ID，草案才會是
  // 真正獨立、不影響現況的版本。
  function _stripDraftTag(name) {
    return (name || "").replace(/〔草案[：:][^〕]*〕/g, "").replace(/〔歷史現況〕/g, "").trim();
  }

  // 全螢幕忙碌中提示：用於「刪除」這類要等後端跑一段時間、
  // 沒有任何回饋會讓人以為畫面卡住的操作。純內嵌樣式，不依賴
  // 外部 CSS，任何頁面載入 nav.js 後都能直接使用。
  function _showBusyOverlay(text) {
    _hideBusyOverlay();
    var el = document.createElement("div");
    el.id = "nbs-busy-overlay";
    el.style.cssText = "position:fixed;inset:0;background:rgba(30,27,60,.55);backdrop-filter:blur(2px);z-index:99999;display:flex;align-items:center;justify-content:center";
    el.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:28px 36px;display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.25)">' +
        '<div style="width:34px;height:34px;border:4px solid #e5e0ff;border-top-color:#7c3aed;border-radius:50%;animation:nbs-spin 0.8s linear infinite"></div>' +
        '<div style="font-size:14px;font-weight:700;color:#374151">'+(text||"處理中，請稍候...")+'</div>' +
      '</div>' +
      '<style>@keyframes nbs-spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(el);
  }
  function _hideBusyOverlay() {
    var el = document.getElementById("nbs-busy-overlay");
    if (el) el.remove();
  }

  global.NBS_NAV._showBusyOverlay = _showBusyOverlay;
  global.NBS_NAV._hideBusyOverlay = _hideBusyOverlay;

  function _duplicateFamilyAsDraft(draftLabel) {
    if (!_family) return Promise.reject(new Error("尚未載入家庭資料"));
    var groupId = _family.familyGroupId || _family.familyId;
    var newFamilyId = "f_" + Date.now() + "_" + Math.random().toString(36).substr(2,5);
    var idMap = {};
    var label = draftLabel || "草案";

    var newFamily = JSON.parse(JSON.stringify(_family));
    newFamily.familyId = newFamilyId;
    newFamily.familyGroupId = groupId;
    newFamily.role = "draft";
    newFamily.draftLabel = label;
    newFamily.basedOnFamilyId = _family.familyId;
    newFamily.createdAt = new Date().toISOString();
    newFamily.updatedAt = new Date().toISOString();
    // 分析日改成建立草案當天，不要原封不動延用舊的
    newFamily.analysisDate = new Date().toISOString().slice(0,10);
    // 把「草案」標記直接寫進家庭名稱本身：在 listFamilies 還沒回傳
    // familyId/role 這些欄位讓前端正確分組之前，這樣至少光看家庭
    // 列表的標題文字就能分辨「這是草案」，不會跟現況搞混；等 GAS
    // 補上欄位、前端能正確分組合併卡片後，這個標記依然有意義（無論
    // 分不分組，隨時可以一眼確認自己在哪個版本）
    newFamily.familyName = _stripDraftTag(_family.familyName) + "〔草案：" + label + "〕";

    newFamily.members = (newFamily.members || []).map(function(m){
      if (m.role === "beneficiary_only") return m; // 沒有獨立個人檔案的不用複製
      var newPid = "p_" + Date.now() + "_" + Math.random().toString(36).substr(2,5);
      idMap[m.personId] = newPid;
      return Object.assign({}, m, { personId: newPid });
    });

    var newFamilyFileName = newFamily.familyName + "_" + newFamilyId + ".json";

    var savePersonPromises = Object.keys(idMap).map(function(oldPid){
      var newPid = idMap[oldPid];
      var personData = _personsData[oldPid];
      if (!personData) return Promise.resolve();
      var newPersonData = JSON.parse(JSON.stringify(personData));
      newPersonData.personId = newPid;
      newPersonData.basedOnPersonId = oldPid;
      var pFileName = (newPersonData.profile && newPersonData.profile.name || "member") + "_" + newPid + ".json";
      return _gas("saveFile", { fileType:"persons", fileId:newPid, fileName:pFileName, content:newPersonData });
    });

    return Promise.all(savePersonPromises).then(function(){
      return _gas("saveFile", { fileType:"families", fileId:newFamilyId, fileName:newFamilyFileName, content:newFamily });
    }).then(function(){
      return { fileName: newFamilyFileName, familyName: newFamily.familyName };
    });
  }

  function _promoteDraftToCurrent() {
    if (!_family || _family.role !== "draft") return Promise.reject(new Error("目前這份不是草案，無法升格"));
    var fn = localStorage.getItem("nbs_current_family");
    var basedOnId = _family.basedOnFamilyId;

    var archiveOld = basedOnId
      ? _gas("listFamilies", {}).then(function(res){
          var old = (res.families || []).find(function(f){ return f.familyId === basedOnId; });
          if (!old) return null;
          return _gas("readFile", { fileType:"families", fileName: old.fileName }).then(function(rf){
            if (!rf || rf.status !== "ok") return null;
            var oldFamily = rf.content;
            oldFamily.role = "archived";
            oldFamily.updatedAt = new Date().toISOString();
            oldFamily.familyName = _stripDraftTag(oldFamily.familyName) + "〔歷史現況〕";
            return _gas("saveFile", { fileType:"families", fileId: oldFamily.familyId, fileName: old.fileName, content: oldFamily });
          });
        })
      : Promise.resolve();

    return archiveOld.then(function(){
      _family.role = "current";
      _family.updatedAt = new Date().toISOString();
      _family.familyName = _stripDraftTag(_family.familyName); // 升格後移除「〔草案：...〕」標記
      return _gas("saveFile", { fileType:"families", fileId:_family.familyId, fileName:fn, content:_family });
    }).then(function(){
      _invalidateBundleCache(fn);
    });
  }

  // 刪除草案：需要 GAS 後端支援 deleteFile 這個動作（目前尚未提供，
  // 等後端補上後這裡就能直接接上運作，不需要再改前端）
  function _deleteDraftFiles() {
    if (!_family || _family.role !== "draft") return Promise.reject(new Error("目前這份不是草案，無法刪除"));
    var fn = localStorage.getItem("nbs_current_family");
    var groupId = _family.familyGroupId || _family.familyId;
    var draftPersonIds = (_family.members || [])
      .filter(function(m){ return m.role !== "beneficiary_only"; })
      .map(function(m){ return m.personId; });

    // 🛡️ 安全檢查：草案的成員 personId 有可能跟現況/其他版本共用同一份
    // 個人檔案（例如這份草案不是透過「另存新檔」建立、而是舊資料或手動
    // 複製出來的，沒有各自獨立的 personId）。逐一讀出同一組的其他存活
    // 版本，只要有任何一個還在用這個 personId，就絕對不能刪這個人的檔案，
    // 否則會連現況正在依賴的保單資料一起銷毀。
    return _gas("listFamilies", {}).then(function(res){
      var survivors = (res.families || []).filter(function(f){
        return (f.familyGroupId === groupId || f.familyId === groupId) && f.fileName !== fn;
      });
      return Promise.all(survivors.map(function(f){
        return _gas("readFile", { fileType:"families", fileName: f.fileName }).then(function(rf){
          if (rf && rf.status === "ok" && rf.content && rf.content.members) {
            return rf.content.members.map(function(m){ return m.personId; });
          }
          return [];
        }).catch(function(){ return []; });
      }));
    }).then(function(survivorPersonIdLists){
      var stillInUse = {};
      survivorPersonIdLists.forEach(function(ids){ ids.forEach(function(id){ stillInUse[id] = true; }); });

      var safeToDeletePersonFiles = (_family.members || [])
        .filter(function(m){ return m.role !== "beneficiary_only" && !stillInUse[m.personId]; })
        .map(function(m){
          var p = _personsData[m.personId];
          var nm = (p && p.profile && p.profile.name) || m.name || "member";
          return nm + "_" + m.personId + ".json";
        });

      return _gas("deleteFile", { fileType:"families", fileName: fn }).then(function(){
        return Promise.all(safeToDeletePersonFiles.map(function(pfn){
          return _gas("deleteFile", { fileType:"persons", fileName: pfn }).catch(function(){});
        }));
      });
    });
  }

  global.NBS_NAV._promptCreateDraft = function() {
    var todayStr = new Date().toISOString().slice(0,10);
    var label = window.prompt("請輸入這份草案的名稱（例如：方案A、增加壽險方案）", "草案 "+todayStr);
    if (label === null) return; // 使用者取消
    _duplicateFamilyAsDraft(label.trim() || "草案").then(function(res){
      alert("已建立草案「"+ (label.trim() || "草案") +"」，可以到家庭列表切換過去編輯。");
    }).catch(function(err){
      alert("建立草案失敗："+(err.message||err));
    });
  };

  global.NBS_NAV._promptPromoteDraft = function() {
    if (!window.confirm("確定要把這份草案升格為現況嗎？\n原本的現況會改標記成「歷史現況」保留下來，不會刪除。")) return;
    _promoteDraftToCurrent().then(function(){
      alert("已升格為現況，畫面即將重新整理。");
      window.location.reload();
    }).catch(function(err){
      alert("升格失敗："+(err.message||err));
    });
  };

  global.NBS_NAV._promptDeleteDraft = function() {
    if (!window.confirm("確定要刪除這份草案嗎？此動作無法復原。")) return;
    _showBusyOverlay("刪除中，請稍候...");
    _deleteDraftFiles().then(function(){
      _hideBusyOverlay();
      alert("草案已刪除，即將返回家庭列表。");
      global.NBS_NAV._back();
    }).catch(function(err){
      _hideBusyOverlay();
      alert("刪除失敗（可能是後端尚未支援刪除功能）："+(err.message||err));
    });
  };

  // 刪除整個檔案：涵蓋這個家庭的所有版本（現況＋所有草案＋所有歷史現況），
  // 以及底下曾經出現過的每一位成員的個人保單檔案。跟「刪除此草案」不同，
  // 這是整組一起刪、不限於目前正在看的這個版本。同樣依賴 GAS 後端的
  // deleteFile 動作。
  function _deleteEntireFamilyFiles() {
    if (!_family) return Promise.reject(new Error("尚未載入家庭資料"));
    var groupId = _family.familyGroupId || _family.familyId;
    return _gas("listFamilies", {}).then(function(res){
      var all = (res.families || []).filter(function(f){
        return f.familyGroupId === groupId || f.familyId === groupId;
      });
      if (!all.length) {
        var fn = localStorage.getItem("nbs_current_family");
        all = [{ familyId:_family.familyId, fileName: fn }];
      }
      var personFileNameSet = {};
      return Promise.all(all.map(function(f){
        return _gas("readFile", { fileType:"families", fileName: f.fileName }).then(function(rf){
          if (rf && rf.status === "ok" && rf.content && rf.content.members) {
            rf.content.members.filter(function(m){ return m.role !== "beneficiary_only"; }).forEach(function(m){
              var p = _personsData[m.personId];
              var nm = (p && p.profile && p.profile.name) || m.name || "member";
              personFileNameSet[nm + "_" + m.personId + ".json"] = true;
            });
          }
          return f.fileName;
        }).catch(function(){ return f.fileName; });
      })).then(function(familyFileNames){
        var deleteFamilies = familyFileNames.map(function(fn){
          return _gas("deleteFile", { fileType:"families", fileName: fn }).catch(function(){});
        });
        var deletePersons = Object.keys(personFileNameSet).map(function(pfn){
          return _gas("deleteFile", { fileType:"persons", fileName: pfn }).catch(function(){});
        });
        return Promise.all(deleteFamilies.concat(deletePersons));
      });
    });
  }

  global.NBS_NAV._promptDeleteEntireFamily = function() {
    if (!_family) return;
    var name = _stripDraftTag(_family.familyName);
    if (!window.confirm(
      "確定要刪除「"+name+"」這整個檔案嗎？\n\n" +
      "這會刪除所有版本（現況／草案／歷史現況）與底下所有成員的保單資料，此動作無法復原。"
    )) return;
    var typed = window.prompt("最後確認：請完整輸入家庭名稱「"+name+"」以永久刪除：");
    if (typed === null) return; // 使用者取消
    if (typed.trim() !== name) {
      alert("輸入的名稱不符，已取消刪除，資料仍然保留。");
      return;
    }
    _showBusyOverlay("刪除中，請稍候...");
    _deleteEntireFamilyFiles().then(function(){
      _hideBusyOverlay();
      alert("「"+name+"」已永久刪除，即將返回家庭列表。");
      global.NBS_NAV._back();
    }).catch(function(err){
      _hideBusyOverlay();
      alert("刪除失敗（可能是後端尚未支援刪除功能）："+(err.message||err));
    });
  };

  // ==========================================
  // 9. 工具函式
  // ==========================================
  function _fmtROC(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d)) return s;
    return (d.getFullYear()-1911)+"年"+(d.getMonth()+1)+"月"+d.getDate()+"日";
  }
  function _debounce(fn, ms) { var t; return function(){ clearTimeout(t); t=setTimeout(fn,ms); }; }

  // ==========================================
  // 10. 樣式（與 v4 相同）
  // ==========================================
  function _injectStyles() {
    if (document.getElementById("nbs-nav-css")) return;
    var s = document.createElement("style");
    s.id = "nbs-nav-css";
    s.textContent = [
      /* ── 方案A：淡色玻璃側欄，延續 index/main 漸層風格 ── */
      "#nbs-sidebar{position:fixed;top:0;left:0;bottom:0;width:200px;background:linear-gradient(180deg,rgba(238,244,255,.96) 0%,rgba(245,240,255,.96) 100%);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-right:1px solid rgba(120,140,255,.13);display:flex;flex-direction:column;overflow-y:hidden;z-index:200}",
      ".nbs-nsec{padding:8px 10px;flex:1;overflow-y:auto;min-height:0}",
      "#nbs-mobile-hdr{position:fixed;top:0;left:0;right:0;height:50px;background:rgba(238,244,255,.95);backdrop-filter:blur(14px);border-bottom:1px solid rgba(120,140,255,.13);display:none;align-items:center;gap:8px;padding:0 14px;z-index:200}",
      "#nbs-bottom-tab{position:fixed;bottom:0;left:0;right:0;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-top:1px solid rgba(120,140,255,.12);display:none;z-index:200;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:env(safe-area-inset-bottom,0)}",
      "#nbs-bottom-more-menu{display:none;position:fixed;left:10px;right:10px;bottom:calc(66px + env(safe-area-inset-bottom,0));background:#fff;border-radius:14px;box-shadow:0 -8px 24px rgba(0,0,0,.18);padding:6px;max-height:60vh;overflow-y:auto;z-index:210}",
      ".nbs-fam{padding:8px 14px 6px;border-bottom:1px solid rgba(120,140,255,.10);margin-bottom:4px}",
      ".nbs-fn{font-size:14px;font-weight:800;color:#111827;letter-spacing:-.2px}",
      ".nbs-fd{font-size:11px;color:#9CA3AF;margin-top:2px}",
      ".nbs-sl{font-size:10px;font-weight:700;color:#9CA3AF;padding:0 8px 5px;letter-spacing:.07em;text-transform:uppercase}",
      ".nbs-ni{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer;margin-bottom:2px;border-left:3px solid transparent;transition:all .15s}",
      ".nbs-ni:hover{background:rgba(59,130,246,.07);color:#1D4ED8}",
      ".nbs-ni-on{background:rgba(59,130,246,.10);border-left-color:#7C3AED}",
      ".nbs-nicon{font-size:16px;flex-shrink:0}",
      ".nbs-nlabel{font-size:13px;color:#6B7280;font-weight:500}",
      ".nbs-ni:hover .nbs-nlabel{color:#1D4ED8}",
      ".nbs-ni-on .nbs-nlabel{color:#4F46E5;font-weight:700}",
      ".nbs-foot{padding:10px;border-top:1px solid rgba(120,140,255,.10)}",
      ".nbs-ni-sm{padding:7px 6px!important;font-size:12px!important}",
      ".nbs-ni-sm .nbs-nicon{font-size:14px!important}",
      ".nbs-ni-sm .nbs-nlabel{font-size:12px!important}",
      ".nbs-disclaimer{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(120,140,255,.05);border:1px solid rgba(120,140,255,.10);font-size:10px;color:#9CA3AF;line-height:1.6;letter-spacing:.01em}",
      ".nbs-pbtn{width:100%;padding:8px;margin-bottom:5px;background:linear-gradient(90deg,rgba(59,130,246,.10),rgba(124,58,237,.10));color:#4F46E5;border:1px solid rgba(120,140,255,.18);border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px}",
      ".nbs-row2{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 10px 8px}",
      ".nbs-row2-btn{padding:8px 4px;background:linear-gradient(90deg,rgba(59,130,246,.10),rgba(124,58,237,.10));color:#4F46E5;border:1px solid rgba(120,140,255,.18);border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;width:100%}",
      ".nbs-row2-btn-ghost{background:transparent;color:#9CA3AF;border:1px solid rgba(120,140,255,.14)}",
      ".nbs-row2-btn-ghost:hover{color:#6B7280}",
      ".nbs-vm{position:relative}",
      ".nbs-vm-menu{display:none;position:absolute;bottom:calc(100% + 6px);right:-4px;width:190px;background:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);border:1px solid rgba(120,140,255,.14);padding:4px;z-index:60}",
      ".nbs-vm-open .nbs-vm-menu{display:block}",
      ".nbs-pbtn:hover{background:linear-gradient(90deg,rgba(59,130,246,.16),rgba(124,58,237,.16))}",
      ".nbs-bbtn{width:100%;padding:7px;background:transparent;color:#9CA3AF;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px}",
      ".nbs-bbtn:hover{color:#6B7280}",
      ".nbs-ti{flex:0 0 auto;min-width:64px;max-width:80px;display:flex;flex-direction:column;align-items:center;padding:8px 4px 5px;cursor:pointer;color:#999}",
      ".nbs-ti-on{color:#6D28D9}",
      ".nbs-tl{font-size:9px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      ".nbs-ti-on .nbs-tl{font-weight:500}",
      ".nbs-tdot{width:20px;height:2px;background:linear-gradient(90deg,#3B82F6,#7C3AED);border-radius:99px;margin-top:2px}",
      "#nbs-member-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:500;align-items:center;justify-content:center;padding:20px}",
      "#nbs-member-modal.open{display:flex}",
      "#nbs-member-modal-box{background:#fff;border-radius:14px;width:100%;max-width:460px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.2)}",
      ".nbs-mm-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #f0f0f0}",
      ".nbs-mm-title{font-size:15px;font-weight:600;color:#1a1a1a}",
      ".nbs-mm-close{background:none;border:none;font-size:22px;color:#aaa;cursor:pointer;line-height:1}",
      ".nbs-mm-body{padding:14px 18px}",
      ".nbs-mm-member{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:#f7f7f5;border:1px solid #eee}",
      ".nbs-mm-avatar{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#3B82F6,#7C3AED);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0}",
      ".nbs-mm-info{flex:1;min-width:0}",
      ".nbs-mm-name{font-size:13px;font-weight:500;color:#333}",
      ".nbs-mm-sub{font-size:11px;color:#aaa;margin-top:1px}",
      ".nbs-mm-edit{padding:5px 12px;font-size:12px;border:1px solid #ddd;border-radius:99px;background:#fff;cursor:pointer;color:#555;font-family:inherit;flex-shrink:0}",
      ".nbs-mm-edit:hover{border-color:#378ADD;color:#378ADD}",
      ".nbs-mm-add{width:100%;padding:10px;background:linear-gradient(90deg,#3B82F6,#7C3AED);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:6px}",
      "#nbs-edit-member-form{display:none;padding:14px 18px;border-top:1px solid #f0f0f0}",
      ".nbs-ef-label{font-size:12px;color:#666;margin-bottom:3px;display:block}",
      ".nbs-ef-input{width:100%;padding:8px 11px;font-size:13px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit;margin-bottom:10px}",
      ".nbs-ef-input:focus{border-color:#3B82F6;box-shadow:0 0 0 3px rgba(59,130,246,.10)}",
      ".nbs-ef-hint{font-size:11px;color:#378ADD;margin-top:-8px;margin-bottom:8px}",
      ".nbs-ef-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".nbs-ef-btns{display:flex;gap:8px;margin-top:4px}",
      ".nbs-ef-cancel{flex:1;padding:9px;background:transparent;color:#666;border:1px solid #ddd;border-radius:7px;cursor:pointer;font-family:inherit;font-size:13px}",
      ".nbs-ef-save{flex:2;padding:9px;background:linear-gradient(90deg,#3B82F6,#7C3AED);color:#fff;border:none;border-radius:9px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600}",
      "#nbs-float-nav{position:fixed;width:1px;height:1px;z-index:300}",
      "#nbs-float-fab{position:absolute;right:0;bottom:0;width:56px;height:56px;border-radius:50%;border:none;cursor:grab;background:linear-gradient(135deg,#3B82F6,#7C3AED);box-shadow:0 6px 18px rgba(76,29,149,.28);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;transition:transform .2s;touch-action:none}",
      "#nbs-float-fab:active{cursor:grabbing}",
      "#nbs-float-fab:hover{transform:scale(1.05)}",
      "#nbs-float-nav.nbs-float-open #nbs-float-fab{transform:rotate(90deg)}",
      "#nbs-float-nav.nbs-float-open #nbs-float-fab:hover{transform:rotate(90deg) scale(1.05)}",
      "#nbs-float-items{position:absolute;right:28px;bottom:28px;width:0;height:0}",
      ".nbs-float-item{position:absolute;right:0;bottom:0;width:52px;height:52px;margin-right:-26px;margin-bottom:-26px;border-radius:50%;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);box-shadow:0 4px 14px rgba(0,0,0,.14);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;opacity:0;transform:translate(0,0) scale(.4);transition:transform .28s cubic-bezier(.34,1.56,.64,1),opacity .2s;pointer-events:none}",
      "#nbs-float-nav.nbs-float-open .nbs-float-item{opacity:1;transform:translate(var(--tx),var(--ty)) scale(1);pointer-events:auto}",
      ".nbs-float-item-on{box-shadow:0 0 0 2px #7C3AED,0 4px 14px rgba(0,0,0,.14)}",
      ".nbs-float-icon{font-size:18px;line-height:1}",
      ".nbs-float-label{font-size:9px;color:#6B7280;margin-top:2px;white-space:nowrap;max-width:48px;overflow:hidden;text-overflow:ellipsis}",
      ".nbs-float-item-on .nbs-float-label{color:#4F46E5;font-weight:700}",
      "@media print{#nbs-sidebar,#nbs-mobile-hdr,#nbs-bottom-tab,#nbs-float-nav{display:none!important}body{padding-left:0!important;padding-top:0!important;padding-bottom:0!important}}",
      ".nbs-logo{border-bottom:1px solid rgba(120,140,255,.12);padding:0;line-height:0;overflow:hidden}",
      ".nbs-logo-img{width:100%;height:auto;max-width:200px;display:block;object-fit:contain}"
    ].join("\n");
    document.head.appendChild(s);
  }

})(window);
