/**
 * NBS 導覽系統 nav.js
 * 引入方式：<script src="nav.js"></script>
 * 使用方式：在頁面 <body> 後呼叫 NBS_NAV.init({ page:"policy" })
 */

(function(global) {
  "use strict";

  const GAS_URL = "https://script.google.com/macros/s/AKfycbzML8PBPSfNIzLx9TT_MgrdQ43yFQmQJy17hLJqTieVPOYnHk6ZYunXkIAYX1653Kbgjg/exec";

  const NAV_ITEMS = [
    { key:"policy",      label:"保險繳費", icon:"📋", href:"policy.html" },
    { key:"coverage",    label:"保障清單", icon:"🛡️", href:"coverage.html" },
    { key:"savings",     label:"儲蓄險",   icon:"🐷", href:"savings.html" },
    { key:"summary",     label:"保單彙總", icon:"📊", href:"summary.html" },
    { key:"beneficiary", label:"受益人",   icon:"👥", href:"beneficiary.html" },
    { key:"export",      label:"匯出圖片", icon:"🖼️", href:"export.html" },
  ];

  var currentPage = "";
  var familyData  = null;
  var currentPersonId = null;
  var isMobile = false;

  // ── 公開 API ────────────────────────────────────────────
  global.NBS_NAV = {
    init: init,
    getCurrentPersonId: function() { return currentPersonId; },
    getFamilyData: function() { return familyData; },
    onMemberChange: null,  // 頁面可以設定這個 callback
  };

  // ── 初始化 ───────────────────────────────────────────────
  function init(opts) {
    currentPage = opts.page || "";

    // 樣式注入
    injectStyles();

    // 建立導覽 DOM 結構
    wrapBody();

    // 載入資料後渲染
    loadData().then(function() {
      renderNav();
      // 觸發外部初始化（頁面本身的 init）
      if (typeof opts.onReady === "function") opts.onReady();
    }).catch(function(e) {
      console.error("NBS_NAV: 資料載入失敗", e);
      if (typeof opts.onReady === "function") opts.onReady();
    });

    // 響應式監聽
    window.addEventListener("resize", debounce(function() {
      var wasM = isMobile;
      isMobile = window.innerWidth < 768;
      if (wasM !== isMobile) renderNav();
    }, 150));
  }

  // ── 載入家庭資料 ─────────────────────────────────────────
  async function loadData() {
    var saved = localStorage.getItem("nbs_user");
    if (!saved) { window.location.href = "index.html"; return; }
    var user = JSON.parse(saved);

    var fn = localStorage.getItem("nbs_current_family");
    if (!fn) { window.location.href = "main.html"; return; }

    var fr = await callGAS("readFile", { email: user.email, fileType: "family", fileName: fn });
    familyData = fr.content;

    currentPersonId = localStorage.getItem("nbs_current_person");
    if (!currentPersonId) {
      var prim = familyData.members.find(function(m) { return m.role === "primary"; });
      currentPersonId = prim ? prim.personId : familyData.members[0]?.personId;
    }
  }

  // ── DOM 結構包裹 ─────────────────────────────────────────
  function wrapBody() {
    isMobile = window.innerWidth < 768;

    // 建立外層容器
    var wrapper = document.createElement("div");
    wrapper.id = "nbs-nav-wrapper";
    wrapper.style.cssText = "display:flex;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

    // 側欄佔位
    var sidebar = document.createElement("div");
    sidebar.id = "nbs-sidebar";

    // 主內容區
    var main = document.createElement("div");
    main.id = "nbs-main-content";
    main.style.cssText = "flex:1;min-width:0;background:#f5f5f3;display:flex;flex-direction:column";

    // 手機頂部 header
    var mobileHdr = document.createElement("div");
    mobileHdr.id = "nbs-mobile-header";

    // 手機底部 tab
    var mobileTab = document.createElement("div");
    mobileTab.id = "nbs-bottom-tab";

    // 移動現有 body 內容到 main
    var bodyContent = document.createElement("div");
    bodyContent.id = "nbs-page-content";
    bodyContent.style.cssText = "flex:1;overflow-y:auto";
    while (document.body.firstChild) {
      bodyContent.appendChild(document.body.firstChild);
    }
    main.appendChild(mobileHdr);
    main.appendChild(bodyContent);

    wrapper.appendChild(sidebar);
    wrapper.appendChild(main);
    document.body.appendChild(wrapper);
    document.body.appendChild(mobileTab);
  }

  // ── 渲染導覽 ─────────────────────────────────────────────
  function renderNav() {
    isMobile = window.innerWidth < 768;
    var sidebar = document.getElementById("nbs-sidebar");
    var mobileHdr = document.getElementById("nbs-mobile-header");
    var mobileTab = document.getElementById("nbs-bottom-tab");
    var pageContent = document.getElementById("nbs-page-content");

    if (!familyData) {
      sidebar.innerHTML = "";
      mobileHdr.innerHTML = "";
      mobileTab.innerHTML = "";
      return;
    }

    if (isMobile) {
      sidebar.style.display = "none";
      mobileHdr.style.display = "block";
      mobileTab.style.display = "flex";
      pageContent.style.paddingBottom = "70px";
      renderMobileHeader(mobileHdr);
      renderBottomTab(mobileTab);
    } else {
      sidebar.style.display = "flex";
      mobileHdr.style.display = "none";
      mobileTab.style.display = "none";
      pageContent.style.paddingBottom = "0";
      renderSidebar(sidebar);
    }
  }

  // ── 側欄 ─────────────────────────────────────────────────
  function renderSidebar(el) {
    var members = (familyData.members || []).filter(function(m) { return m.role !== "beneficiary_only"; });

    var membersHtml = members.map(function(m) {
      var isActive = m.personId === currentPersonId;
      return '<div class="nbs-member-item' + (isActive ? " active" : "") + '" onclick="NBS_NAV._switchMember(\'' + m.personId + '\')">' +
        '<div class="nbs-member-avatar">' + m.name[0] + '</div>' +
        '<div class="nbs-member-info"><div class="nbs-member-name">' + m.name + '</div>' +
        '<div class="nbs-member-sub">' + (m.relation || m.role) + '</div></div>' +
        (isActive ? '<div class="nbs-member-dot"></div>' : '') +
      '</div>';
    }).join("");

    var navItemsHtml = NAV_ITEMS.map(function(item) {
      var isActive = currentPage === item.key;
      return '<div class="nbs-nav-item' + (isActive ? " active" : "") + '" onclick="NBS_NAV._goto(\'' + item.href + '\')">' +
        '<span class="nbs-nav-icon">' + item.icon + '</span>' +
        '<span class="nbs-nav-label">' + item.label + '</span>' +
      '</div>';
    }).join("");

    el.style.cssText = "width:220px;flex-shrink:0;height:100vh;position:sticky;top:0;background:#1A2B4A;display:flex;flex-direction:column;overflow-y:auto";
    el.innerHTML =
      '<div class="nbs-sidebar-logo">' +
        '<span style="font-size:20px">🛡️</span>' +
        '<div><div class="nbs-logo-title">NBS 保單體檢</div><div class="nbs-logo-sub">富邦人壽保險顧問</div></div>' +
      '</div>' +
      '<div class="nbs-sidebar-family">' +
        '<div class="nbs-section-label">目前家庭</div>' +
        '<div class="nbs-family-name">' + familyData.familyName + '</div>' +
        '<div class="nbs-family-date">分析日 ' + formatROC(familyData.analysisDate) + '</div>' +
      '</div>' +
      '<div class="nbs-members-section">' +
        '<div class="nbs-section-label">家庭成員</div>' +
        membersHtml +
        '<div class="nbs-add-member" onclick="NBS_NAV._addMember()">' +
          '<div class="nbs-member-avatar add">＋</div>' +
          '<span>新增成員</span>' +
        '</div>' +
      '</div>' +
      '<div class="nbs-nav-section">' +
        '<div class="nbs-section-label">功能模組</div>' +
        navItemsHtml +
      '</div>' +
      '<div class="nbs-sidebar-footer">' +
        '<button class="nbs-print-btn" onclick="NBS_NAV._printPage()">🖨️ 快速列印此頁</button>' +
        '<button class="nbs-back-btn" onclick="NBS_NAV._backToList()">← 返回家庭列表</button>' +
      '</div>';
  }

  // ── 手機頂部 ─────────────────────────────────────────────
  function renderMobileHeader(el) {
    var members = (familyData.members || []).filter(function(m) { return m.role !== "beneficiary_only"; });
    var cur = members.find(function(m) { return m.personId === currentPersonId; }) || members[0];

    var memberOptions = members.map(function(m) {
      return '<option value="' + m.personId + '"' + (m.personId === currentPersonId ? " selected" : "") + '>' +
        m.name + '（' + (m.relation || m.role) + '）</option>';
    }).join("");

    el.style.cssText = "position:sticky;top:0;z-index:100;background:#1A2B4A;padding:10px 14px;display:flex;align-items:center;gap:8px";
    el.innerHTML =
      '<span style="font-size:16px">🛡️</span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + familyData.familyName + '</div>' +
      '</div>' +
      '<select onchange="NBS_NAV._switchMember(this.value)" style="padding:4px 8px;font-size:12px;border:none;border-radius:99px;background:rgba(255,255,255,0.12);color:#fff;outline:none;cursor:pointer;font-family:inherit">' +
        memberOptions +
        '<option value="__add__">＋ 新增成員</option>' +
      '</select>' +
      '<button onclick="NBS_NAV._printPage()" style="padding:5px 8px;background:rgba(255,255,255,0.12);border:none;border-radius:6px;color:rgba(255,255,255,0.8);font-size:13px;cursor:pointer">🖨️</button>';
  }

  // ── 手機底部 Tab ─────────────────────────────────────────
  function renderBottomTab(el) {
    el.style.cssText = "position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e8e8e8;display:flex;z-index:100;padding-bottom:env(safe-area-inset-bottom,0)";
    el.innerHTML = NAV_ITEMS.map(function(item) {
      var isActive = currentPage === item.key;
      return '<div class="nbs-tab-item' + (isActive ? " active" : "") + '" onclick="NBS_NAV._goto(\'' + item.href + '\')">' +
        '<span class="nbs-tab-icon">' + item.icon + '</span>' +
        '<span class="nbs-tab-label">' + item.label + '</span>' +
        (isActive ? '<div class="nbs-tab-dot"></div>' : '') +
      '</div>';
    }).join("");
  }

  // ── 動作 ─────────────────────────────────────────────────
  global.NBS_NAV._switchMember = function(personId) {
    if (personId === "__add__") { NBS_NAV._addMember(); return; }
    currentPersonId = personId;
    localStorage.setItem("nbs_current_person", personId);
    renderNav();
    if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(personId);
  };

  global.NBS_NAV._goto = function(href) {
    window.location.href = href;
  };

  global.NBS_NAV._printPage = function() {
    window.print();
  };

  global.NBS_NAV._backToList = function() {
    window.location.href = "main.html";
  };

  global.NBS_NAV._addMember = function() {
    // 觸發 family.html 的新增成員流程
    if (typeof window.openAddMember === "function") window.openAddMember();
    else window.location.href = "family.html?action=addMember";
  };

  // ── 工具函式 ─────────────────────────────────────────────
  function formatROC(dateStr) {
    if (!dateStr) return "";
    var d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return (d.getFullYear() - 1911) + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function debounce(fn, ms) {
    var t;
    return function() { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function callGAS(action, params) {
    var url = new URL(GAS_URL);
    url.searchParams.set("action", action);
    Object.entries(params || {}).forEach(function(kv) {
      var k = kv[0], v = kv[1];
      if (typeof v === "object") url.searchParams.set(k, encodeURIComponent(JSON.stringify(v)));
      else if (v !== null && v !== undefined) url.searchParams.set(k, v);
    });
    return fetch(url.toString()).then(function(r) { return r.json(); });
  }

  // ── 樣式 ─────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("nbs-nav-styles")) return;
    var style = document.createElement("style");
    style.id = "nbs-nav-styles";
    style.textContent = `
      * { box-sizing: border-box; }
      body { margin: 0; }
      #nbs-nav-wrapper { display: flex; min-height: 100vh; }

      /* 側欄共用 */
      .nbs-sidebar-logo { display:flex;align-items:center;gap:8px;padding:16px 14px 10px;border-bottom:1px solid rgba(255,255,255,0.08) }
      .nbs-logo-title { font-size:13px;font-weight:600;color:#fff }
      .nbs-logo-sub { font-size:10px;color:rgba(255,255,255,0.4);margin-top:1px }
      .nbs-sidebar-family { padding:10px 14px 8px }
      .nbs-family-name { font-size:13px;font-weight:500;color:#fff }
      .nbs-family-date { font-size:10px;color:rgba(255,255,255,0.35);margin-top:2px }
      .nbs-section-label { font-size:10px;color:rgba(255,255,255,0.4);padding:0 4px 5px;letter-spacing:0.05em }
      .nbs-members-section { padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.08) }
      .nbs-nav-section { padding:8px 10px;flex:1 }

      /* 成員 */
      .nbs-member-item { display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;margin-bottom:2px;border:1px solid transparent;transition:all .15s }
      .nbs-member-item:hover { background:rgba(255,255,255,0.06) }
      .nbs-member-item.active { background:rgba(55,138,221,0.22);border-color:rgba(55,138,221,0.35) }
      .nbs-member-avatar { width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;flex-shrink:0 }
      .nbs-member-item.active .nbs-member-avatar { background:#378ADD }
      .nbs-member-avatar.add { background:transparent;border:1px dashed rgba(255,255,255,0.25);color:rgba(255,255,255,0.35);font-size:16px }
      .nbs-member-info { flex:1;min-width:0 }
      .nbs-member-name { font-size:12px;font-weight:500;color:rgba(255,255,255,0.7) }
      .nbs-member-item.active .nbs-member-name { color:#fff }
      .nbs-member-sub { font-size:10px;color:rgba(255,255,255,0.35) }
      .nbs-member-dot { width:6px;height:6px;border-radius:50%;background:#5BC8F5;flex-shrink:0 }
      .nbs-add-member { display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;margin-top:2px;border:1px dashed rgba(255,255,255,0.18) }
      .nbs-add-member span { font-size:12px;color:rgba(255,255,255,0.4) }

      /* 功能選單 */
      .nbs-nav-item { display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;border-left:3px solid transparent;transition:all .15s }
      .nbs-nav-item:hover { background:rgba(255,255,255,0.06) }
      .nbs-nav-item.active { background:rgba(55,138,221,0.18);border-left-color:#378ADD }
      .nbs-nav-icon { font-size:15px;flex-shrink:0 }
      .nbs-nav-label { font-size:13px;color:rgba(255,255,255,0.6);font-weight:400 }
      .nbs-nav-item.active .nbs-nav-label { color:#fff;font-weight:500 }

      /* 側欄底部 */
      .nbs-sidebar-footer { padding:10px;border-top:1px solid rgba(255,255,255,0.08) }
      .nbs-print-btn { width:100%;padding:8px;margin-bottom:5px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.12);border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px }
      .nbs-print-btn:hover { background:rgba(255,255,255,0.12) }
      .nbs-back-btn { width:100%;padding:7px;background:transparent;color:rgba(255,255,255,0.35);border:none;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px }
      .nbs-back-btn:hover { color:rgba(255,255,255,0.6) }

      /* 底部 Tab */
      .nbs-tab-item { flex:1;display:flex;flex-direction:column;align-items:center;padding:8px 2px 5px;cursor:pointer;color:#999;position:relative }
      .nbs-tab-item.active { color:#378ADD }
      .nbs-tab-icon { font-size:20px }
      .nbs-tab-label { font-size:9px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-weight:400 }
      .nbs-tab-item.active .nbs-tab-label { font-weight:500 }
      .nbs-tab-dot { width:20px;height:2px;background:#378ADD;border-radius:99px;margin-top:2px }

      /* 列印樣式 */
      @media print {
        #nbs-sidebar, #nbs-mobile-header, #nbs-bottom-tab { display:none !important }
        #nbs-main-content { margin:0 !important }
        #nbs-page-content { padding-bottom:0 !important }
      }

      /* 響應式 */
      @media (max-width: 767px) {
        #nbs-sidebar { display:none !important }
        #nbs-bottom-tab { display:flex !important }
      }
      @media (min-width: 768px) {
        #nbs-mobile-header { display:none !important }
        #nbs-bottom-tab { display:none !important }
        #nbs-sidebar { display:flex !important }
      }
    `;
    document.head.appendChild(style);
  }

})(window);
