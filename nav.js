/**
 * NBS 導覽系統 nav.js v2
 * 不移動 DOM，直接在 body 外部插入側欄/底部Tab
 */
(function(global) {
  "use strict";

  var GAS_URL = "https://script.google.com/macros/s/AKfycbzML8PBPSfNIzLx9TT_MgrdQ43yFQmQJy17hLJqTieVPOYnHk6ZYunXkIAYX1653Kbgjg/exec";

  var NAV_ITEMS = [
    { key:"policy",      label:"保險繳費", icon:"📋", href:"policy.html" },
    { key:"coverage",    label:"保障清單", icon:"🛡️", href:"coverage.html" },
    { key:"savings",     label:"儲蓄險",   icon:"🐷", href:"savings.html" },
    { key:"summary",     label:"保單彙總", icon:"📊", href:"summary.html" },
    { key:"beneficiary", label:"受益人",   icon:"👥", href:"beneficiary.html" },
    { key:"export",      label:"匯出圖片", icon:"🖼️", href:"export.html" },
  ];

  var _page = "";
  var _family = null;
  var _personId = null;
  var _user = null;

  // ── 公開 API ──────────────────────────────────────────
  global.NBS_NAV = {
    init: function(opts) {
      _page = opts.page || "";
      // DOM ready 後插入側欄
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function() { _setup(opts); });
      } else {
        _setup(opts);
      }
    },
    getCurrentPersonId: function() { return _personId; },
    getFamilyData:      function() { return _family; },
    getUser:            function() { return _user; },
    onMemberChange: null,
  };

  function _setup(opts) {
    _injectStyles();
    _insertNav();          // 插入側欄 DOM（空的）
    _loadData(opts);       // 非同步載入資料後填充側欄
  }

  // ── 插入側欄 DOM（不動頁面內容）────────────────────────
  function _insertNav() {
    // 側欄
    var sidebar = document.createElement("div");
    sidebar.id = "nbs-sidebar";
    sidebar.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,0.3);font-size:12px">載入中…</div>';
    document.body.insertBefore(sidebar, document.body.firstChild);

    // 底部 Tab
    var tab = document.createElement("div");
    tab.id = "nbs-bottom-tab";
    document.body.appendChild(tab);

    // 手機頂部 Header
    var hdr = document.createElement("div");
    hdr.id = "nbs-mobile-hdr";
    document.body.insertBefore(hdr, sidebar.nextSibling);

    // 讓頁面內容往右推（桌面），往下推（手機）
    _applyLayout();
    window.addEventListener("resize", _debounce(_applyLayout, 150));
  }

  function _applyLayout() {
    var mobile = window.innerWidth < 768;
    var sidebar = document.getElementById("nbs-sidebar");
    var tab     = document.getElementById("nbs-bottom-tab");
    var hdr     = document.getElementById("nbs-mobile-hdr");
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
      document.body.style.paddingLeft = "220px";
      document.body.style.paddingTop  = "0";
      document.body.style.paddingBottom = "0";
    }
  }

  // ── 載入資料 ────────────────────────────────────────────
  function _loadData(opts) {
    var saved = localStorage.getItem("nbs_user");
    if (!saved) { window.location.href = "index.html"; return; }
    _user = JSON.parse(saved);

    var fn = localStorage.getItem("nbs_current_family");
    if (!fn) { window.location.href = "main.html"; return; }

    _callGAS("readFile", { email: _user.email, fileType: "family", fileName: fn })
      .then(function(fr) {
        _family = fr.content;
        _personId = localStorage.getItem("nbs_current_person");
        if (!_personId) {
          var prim = _family.members.find(function(m){ return m.role==="primary"; });
          _personId = prim ? prim.personId : (_family.members[0] && _family.members[0].personId);
          if (_personId) localStorage.setItem("nbs_current_person", _personId);
        }
        _renderAll();
        // 通知頁面 nav 已就緒
        window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
          detail: { user: _user, familyData: _family, currentPersonId: _personId }
        }));
      })
      .catch(function(e) {
        console.error("NBS_NAV load error", e);
        // 就算失敗也通知頁面繼續（避免無限等待）
        window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
          detail: { user: _user, familyData: null, currentPersonId: null }
        }));
      });
  }

  // ── 渲染所有導覽元件 ─────────────────────────────────────
  function _renderAll() {
    _renderSidebar();
    _renderBottomTab();
    _renderMobileHdr();
    _applyLayout();
  }

  // ── 側欄 ─────────────────────────────────────────────────
  function _renderSidebar() {
    var el = document.getElementById("nbs-sidebar");
    if (!el || !_family) return;

    var members = (_family.members||[]).filter(function(m){ return m.role !== "beneficiary_only"; });

    var membersHtml = members.map(function(m) {
      var active = m.personId === _personId;
      return '<div class="nbs-mi'+(active?" nbs-mi-on":"")+'" onclick="NBS_NAV._setPerson(\''+m.personId+'\')">' +
        '<div class="nbs-av'+(active?" nbs-av-on":"")+'">'+m.name[0]+'</div>' +
        '<div style="flex:1;min-width:0"><div class="nbs-mn'+(active?" nbs-mn-on":"")+'">'+m.name+'</div>' +
        '<div class="nbs-ms">'+(m.relation||m.role)+'</div></div>' +
        (active?'<div class="nbs-dot"></div>':'') +
      '</div>';
    }).join("");

    var navHtml = NAV_ITEMS.map(function(item) {
      var active = _page === item.key;
      return '<div class="nbs-ni'+(active?" nbs-ni-on":"")+'" onclick="NBS_NAV._go(\''+item.href+'\')">' +
        '<span class="nbs-nicon">'+item.icon+'</span>' +
        '<span class="nbs-nlabel">'+item.label+'</span>' +
      '</div>';
    }).join("");

    el.innerHTML =
      '<div class="nbs-logo">'+
        '<span style="font-size:20px">🛡️</span>'+
        '<div><div class="nbs-lt">NBS 保單體檢</div><div class="nbs-ls">富邦人壽保險顧問</div></div>'+
      '</div>'+
      '<div class="nbs-fam">'+
        '<div class="nbs-sl">目前家庭</div>'+
        '<div class="nbs-fn">'+_family.familyName+'</div>'+
        '<div class="nbs-fd">分析日 '+_fmtROC(_family.analysisDate)+'</div>'+
      '</div>'+
      '<div class="nbs-msec">'+
        '<div class="nbs-sl">家庭成員</div>'+
        membersHtml+
        '<div class="nbs-add" onclick="NBS_NAV._addMember()">'+
          '<div class="nbs-av nbs-av-add">＋</div>'+
          '<span class="nbs-ms">新增成員</span>'+
        '</div>'+
      '</div>'+
      '<div class="nbs-nsec">'+
        '<div class="nbs-sl">功能模組</div>'+
        navHtml+
      '</div>'+
      '<div class="nbs-foot">'+
        '<button class="nbs-pbtn" onclick="NBS_NAV._print()">🖨️ 快速列印此頁</button>'+
        '<button class="nbs-bbtn" onclick="NBS_NAV._back()">← 返回家庭列表</button>'+
      '</div>';
  }

  // ── 底部 Tab ─────────────────────────────────────────────
  function _renderBottomTab() {
    var el = document.getElementById("nbs-bottom-tab");
    if (!el) return;
    el.innerHTML = NAV_ITEMS.map(function(item) {
      var active = _page === item.key;
      return '<div class="nbs-ti'+(active?" nbs-ti-on":"")+'" onclick="NBS_NAV._go(\''+item.href+'\')">' +
        '<span style="font-size:20px">'+item.icon+'</span>' +
        '<span class="nbs-tl">'+item.label+'</span>' +
        (active?'<div class="nbs-tdot"></div>':'') +
      '</div>';
    }).join("");
  }

  // ── 手機頂部 ─────────────────────────────────────────────
  function _renderMobileHdr() {
    var el = document.getElementById("nbs-mobile-hdr");
    if (!el || !_family) return;
    var members = (_family.members||[]).filter(function(m){ return m.role!=="beneficiary_only"; });
    var opts = members.map(function(m){
      return '<option value="'+m.personId+'"'+( m.personId===_personId?" selected":"")+'>'+m.name+'（'+(m.relation||m.role)+'）</option>';
    }).join("") + '<option value="__add__">＋ 新增成員</option>';

    el.innerHTML =
      '<span style="font-size:16px">🛡️</span>'+
      '<div style="flex:1;min-width:0;font-size:11px;color:rgba(255,255,255,0.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_family.familyName+'</div>'+
      '<select onchange="NBS_NAV._setPerson(this.value)" style="padding:4px 8px;font-size:12px;border:none;border-radius:99px;background:rgba(255,255,255,0.12);color:#fff;outline:none;cursor:pointer;font-family:inherit">'+opts+'</select>'+
      '<button onclick="NBS_NAV._print()" style="padding:5px 8px;background:rgba(255,255,255,0.12);border:none;border-radius:6px;color:rgba(255,255,255,0.8);font-size:13px;cursor:pointer">🖨️</button>';
  }

  // ── 動作 ─────────────────────────────────────────────────
  global.NBS_NAV._setPerson = function(id) {
    if (id === "__add__") { NBS_NAV._addMember(); return; }
    _personId = id;
    localStorage.setItem("nbs_current_person", id);
    _renderAll();
    if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(id);
  };
  global.NBS_NAV._go      = function(href) { window.location.href = href; };
  global.NBS_NAV._print   = function() { window.print(); };
  global.NBS_NAV._back    = function() { window.location.href = "main.html"; };
  global.NBS_NAV._addMember = function() {
    if (typeof openAddMember === "function") openAddMember();
    else window.location.href = "family.html?action=addMember";
  };

  // ── 工具 ─────────────────────────────────────────────────
  function _fmtROC(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d)) return s;
    return (d.getFullYear()-1911)+"年"+(d.getMonth()+1)+"月"+d.getDate()+"日";
  }
  function _debounce(fn, ms) { var t; return function(){ clearTimeout(t); t=setTimeout(fn,ms); }; }
  function _callGAS(action, params) {
    var url = new URL(GAS_URL);
    url.searchParams.set("action", action);
    Object.entries(params||{}).forEach(function(kv){
      var k=kv[0],v=kv[1];
      if(typeof v==="object") url.searchParams.set(k,encodeURIComponent(JSON.stringify(v)));
      else if(v!==null&&v!==undefined) url.searchParams.set(k,v);
    });
    return fetch(url.toString()).then(function(r){ return r.json(); });
  }

  // ── 樣式 ─────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById("nbs-nav-css")) return;
    var s = document.createElement("style");
    s.id = "nbs-nav-css";
    s.textContent = `
      #nbs-sidebar {
        position:fixed;top:0;left:0;bottom:0;width:220px;
        background:#1A2B4A;display:flex;flex-direction:column;
        overflow-y:auto;z-index:200;
      }
      #nbs-mobile-hdr {
        position:fixed;top:0;left:0;right:0;height:50px;
        background:#1A2B4A;display:none;align-items:center;
        gap:8px;padding:0 14px;z-index:200;
      }
      #nbs-bottom-tab {
        position:fixed;bottom:0;left:0;right:0;
        background:#fff;border-top:1px solid #e8e8e8;
        display:none;z-index:200;
        padding-bottom:env(safe-area-inset-bottom,0);
      }
      .nbs-logo{display:flex;align-items:center;gap:8px;padding:16px 14px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
      .nbs-lt{font-size:13px;font-weight:600;color:#fff}
      .nbs-ls{font-size:10px;color:rgba(255,255,255,.4);margin-top:1px}
      .nbs-fam{padding:10px 14px 8px}
      .nbs-fn{font-size:13px;font-weight:500;color:#fff}
      .nbs-fd{font-size:10px;color:rgba(255,255,255,.35);margin-top:2px}
      .nbs-sl{font-size:10px;color:rgba(255,255,255,.4);padding:0 4px 5px;letter-spacing:.05em}
      .nbs-msec{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
      .nbs-nsec{padding:8px 10px;flex:1}
      .nbs-mi{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;margin-bottom:2px;border:1px solid transparent;transition:all .15s}
      .nbs-mi:hover{background:rgba(255,255,255,.06)}
      .nbs-mi-on{background:rgba(55,138,221,.22);border-color:rgba(55,138,221,.35)}
      .nbs-av{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;flex-shrink:0}
      .nbs-av-on{background:#378ADD}
      .nbs-av-add{background:transparent;border:1px dashed rgba(255,255,255,.25);color:rgba(255,255,255,.35);font-size:16px}
      .nbs-mn{font-size:12px;color:rgba(255,255,255,.65);font-weight:400}
      .nbs-mn-on{color:#fff;font-weight:500}
      .nbs-ms{font-size:10px;color:rgba(255,255,255,.35)}
      .nbs-dot{width:6px;height:6px;border-radius:50%;background:#5BC8F5;flex-shrink:0}
      .nbs-add{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;margin-top:2px;border:1px dashed rgba(255,255,255,.18)}
      .nbs-ni{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;border-left:3px solid transparent;transition:all .15s}
      .nbs-ni:hover{background:rgba(255,255,255,.06)}
      .nbs-ni-on{background:rgba(55,138,221,.18);border-left-color:#378ADD}
      .nbs-nicon{font-size:15px;flex-shrink:0}
      .nbs-nlabel{font-size:13px;color:rgba(255,255,255,.6)}
      .nbs-ni-on .nbs-nlabel{color:#fff;font-weight:500}
      .nbs-foot{padding:10px;border-top:1px solid rgba(255,255,255,.08)}
      .nbs-pbtn{width:100%;padding:8px;margin-bottom:5px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.12);border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px}
      .nbs-pbtn:hover{background:rgba(255,255,255,.14)}
      .nbs-bbtn{width:100%;padding:7px;background:transparent;color:rgba(255,255,255,.35);border:none;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px}
      .nbs-bbtn:hover{color:rgba(255,255,255,.6)}
      .nbs-ti{flex:1;display:flex;flex-direction:column;align-items:center;padding:8px 2px 5px;cursor:pointer;color:#999}
      .nbs-ti-on{color:#378ADD}
      .nbs-tl{font-size:9px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
      .nbs-ti-on .nbs-tl{font-weight:500}
      .nbs-tdot{width:20px;height:2px;background:#378ADD;border-radius:99px;margin-top:2px}
      @media print {
        #nbs-sidebar,#nbs-mobile-hdr,#nbs-bottom-tab{display:none!important}
        body{padding-left:0!important;padding-top:0!important;padding-bottom:0!important}
      }
    `;
    document.head.appendChild(s);
  }

})(window);
