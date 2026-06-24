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
    { key:"hospital",    label:"醫院病房", icon:"🏥", href:"hospital.html" }
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

    // 家庭成員管理 Modal
    var modal = document.createElement("div");
    modal.id = "nbs-member-modal";
    modal.innerHTML =
      '<div id="nbs-member-modal-box">'+
        '<div class="nbs-mm-head">'+
          '<span class="nbs-mm-title">👨‍👩‍👧 家庭成員管理</span>'+
          '<button class="nbs-mm-close" onclick="NBS_NAV._closeMemberModal()">×</button>'+
        '</div>'+
        '<div class="nbs-mm-body" id="nbs-mm-list"></div>'+
        '<div id="nbs-edit-member-form">'+
          '<div class="nbs-ef-row">'+
            '<div><label class="nbs-ef-label">姓名 *</label><input class="nbs-ef-input" id="nbs-ef-name" placeholder="姓名"/></div>'+
            '<div><label class="nbs-ef-label">關係</label>'+
              '<select class="nbs-ef-input" id="nbs-ef-relation" style="padding:7px 11px">'+
                '<option value="本人">本人</option><option value="配偶">配偶</option>'+
                '<option value="子女">子女</option><option value="父母">父母</option>'+
                '<option value="其他">其他</option>'+
              '</select>'+
            '</div>'+
          '</div>'+
          '<label class="nbs-ef-label">出生日期</label>'+
          '<input class="nbs-ef-input" id="nbs-ef-birth" type="date" oninput="NBS_NAV._updateEfAge()"/>'+
          '<div class="nbs-ef-hint" id="nbs-ef-age-hint"></div>'+
          '<label class="nbs-ef-label">住家地址（縣市＋區，用於醫院病房費查詢）</label>'+
          '<input class="nbs-ef-input" id="nbs-ef-address" placeholder="如：台北市中正區"/>'+
          '<div class="nbs-ef-btns">'+
            '<button class="nbs-ef-cancel" onclick="NBS_NAV._closeEfForm()">取消</button>'+
            '<button class="nbs-ef-save" onclick="NBS_NAV._saveEfMember()">儲存</button>'+
          '</div>'+
        '</div>'+
      '</div>';
    modal.onclick = function(e){ if(e.target===modal) NBS_NAV._closeMemberModal(); };
    document.body.appendChild(modal);
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

    // sessionStorage 快取：同一次瀏覽切換功能頁不重複呼叫 GAS
    var cacheKey = "nbs_fam_" + fn;
    var cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        _family = JSON.parse(cached);
        _personId = localStorage.getItem("nbs_current_person");
        if (!_personId) {
          var prim = _family.members.find(function(m){ return m.role==="primary"; });
          _personId = prim ? prim.personId : (_family.members[0] && _family.members[0].personId);
          if (_personId) localStorage.setItem("nbs_current_person", _personId);
        }
        _renderAll();
        window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
          detail: { user:_user, familyData:_family, currentPersonId:_personId, familyFileName:fn }
        }));
        return;
      } catch(e) { sessionStorage.removeItem(cacheKey); }
    }

    // 快取沒有 → 呼叫 GAS
    _callGAS("readFile", { email: _user.email, fileType: "family", fileName: fn })
      .then(function(fr) {
        _family = fr.content;
        try { sessionStorage.setItem(cacheKey, JSON.stringify(_family)); } catch(e) {}
        _personId = localStorage.getItem("nbs_current_person");
        if (!_personId) {
          var prim = _family.members.find(function(m){ return m.role==="primary"; });
          _personId = prim ? prim.personId : (_family.members[0] && _family.members[0].personId);
          if (_personId) localStorage.setItem("nbs_current_person", _personId);
        }
        _renderAll();
        window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
          detail: { user:_user, familyData:_family, currentPersonId:_personId, familyFileName:fn }
        }));
      })
      .catch(function(e) {
        console.error("NBS_NAV load error", e);
        window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
          detail: { user:_user, familyData:null, currentPersonId:null, familyFileName:fn }
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
      // 移除原本的 nbs-msec 區塊，讓功能模組直接接在家庭資訊下方
      '<div class="nbs-nsec">'+
        '<div class="nbs-sl">功能模組</div>'+
        navHtml+
      '</div>'+
      '<div class="nbs-member-entry" onclick="NBS_NAV._openMemberModal()">'+
        '<span class="nbs-nicon">👨‍👩‍👧</span>'+
        '<span class="nbs-nlabel">家庭成員管理</span>'+
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
  // ── 家庭成員管理 Modal ───────────────────────────────────
  global.NBS_NAV._openMemberModal = function(mode, personId) {
    // 移除已存在的 Modal
    var exist = document.getElementById("nbs-member-modal");
    if (exist) exist.remove();

    var members = (_family && _family.members || []).filter(function(m){ return m.role !== "beneficiary_only"; });
    var editPerson = personId ? members.find(function(m){ return m.personId === personId; }) : null;
    var isNew = mode === "new" || !personId;

    // Modal HTML
    var overlay = document.createElement("div");
    overlay.id = "nbs-member-modal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:500;display:flex;align-items:flex-end;justify-content:center";

    // 成員列表或編輯表單
    var content = "";
    if (isNew) {
      content = _memberEditForm(null, true);
    } else if (editPerson) {
      content = _memberEditForm(editPerson, false);
    } else {
      // 顯示成員列表
      content = _memberListHTML(members);
    }

    overlay.innerHTML = '<div style="background:#fff;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:520px;max-height:85vh;overflow-y:auto">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
        '<span style="font-size:15px;font-weight:600">' + (isNew ? "新增成員" : editPerson ? "編輯："+editPerson.name : "家庭成員管理") + '</span>' +
        '<button onclick="document.getElementById(\'nbs-member-modal\').remove()" style="background:none;border:none;font-size:22px;color:#999;cursor:pointer;line-height:1">×</button>' +
      '</div>' +
      content +
    '</div>';

    overlay.onclick = function(e) { if(e.target===overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  };

  function _memberListHTML(members) {
    var rows = members.map(function(m) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f0f0f0">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:#378ADD;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#fff;flex-shrink:0">' + m.name[0] + '</div>' +
        '<div style="flex:1">' +
          '<div style="font-size:13px;font-weight:500">' + m.name + '</div>' +
          '<div style="font-size:11px;color:#aaa">' + (m.relation||m.role) + (m.profile && m.profile.address ? '　' + m.profile.address : '') + '</div>' +
        '</div>' +
        '<button onclick="NBS_NAV._openMemberModal(\'edit\',' + JSON.stringify(m.personId) + ')" style="padding:4px 12px;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-family:inherit">編輯</button>' +
      '</div>';
    }).join("");

    return rows +
      '<button onclick="NBS_NAV._openMemberModal(&apos;new&apos;)" style="width:100%;margin-top:12px;padding:10px;background:transparent;border:1.5px dashed #ddd;border-radius:8px;font-size:13px;color:#666;cursor:pointer;font-family:inherit">＋ 新增成員</button>';
  }

  function _memberEditForm(person, isNew) {
    // person 是 family.members 裡的成員物件：{ name, relation, birthDate, personId }
    // 不是 { profile:{...} } 結構
    var name     = (person && person.name)      || "";
    var relation = (person && person.relation)  || "";
    var birthDate= (person && person.birthDate) || "";
    var address  = (person && person.address)   || "";

    return '<div id="nbs-member-form">' +
      // 姓名
      '<div style="margin-bottom:12px">' +
        '<label style="font-size:12px;color:#666;display:block;margin-bottom:4px">姓名 <span style="color:#e74c3c">*</span></label>' +
        '<input id="nmf-name" type="text" value="' + name + '" placeholder="請輸入姓名" style="width:100%;padding:9px 12px;font-size:14px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit">' +
      '</div>' +
      // 關係
      '<div style="margin-bottom:12px">' +
        '<label style="font-size:12px;color:#666;display:block;margin-bottom:4px">關係</label>' +
        '<select id="nmf-relation" style="width:100%;padding:9px 12px;font-size:14px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit;background:#fff">' +
          '<option value="本人" ' + (relation==="本人"?"selected":"") + '>本人</option>' +
          '<option value="配偶" ' + (relation==="配偶"?"selected":"") + '>配偶</option>' +
          '<option value="子女" ' + (relation==="子女"?"selected":"") + '>子女</option>' +
          '<option value="父母" ' + (relation==="父母"?"selected":"") + '>父母</option>' +
          '<option value="兄弟姐妹" ' + (relation==="兄弟姐妹"?"selected":"") + '>兄弟姐妹</option>' +
          '<option value="其他" ' + (!["本人","配偶","子女","父母","兄弟姐妹"].includes(relation)&&relation?"selected":"") + '>其他</option>' +
        '</select>' +
      '</div>' +
      // 出生日期
      '<div style="margin-bottom:12px">' +
        '<label style="font-size:12px;color:#666;display:block;margin-bottom:4px">出生日期</label>' +
        '<input id="nmf-birth" type="date" value="' + birthDate + '" style="width:100%;padding:9px 12px;font-size:14px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit">' +
      '</div>' +
      // 住家地址
      '<div style="margin-bottom:12px">' +
        '<label style="font-size:12px;color:#666;display:block;margin-bottom:4px">住家地址</label>' +
        '<input id="nmf-address" type="text" value="' + address + '" placeholder="如：台北市中正區（用於查詢附近醫院）" style="width:100%;padding:9px 12px;font-size:14px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit">' +
      '</div>' +
      // 按鈕
      '<div style="display:flex;gap:8px;margin-top:16px">' +
        (isNew ? '' : '<button onclick="NBS_NAV._openMemberModal()" style="flex:1;padding:10px;background:transparent;color:#666;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-family:inherit">返回列表</button>') +
        (!isNew ? '' : '<button onclick="document.getElementById(\'nbs-member-modal\').remove()" style="flex:1;padding:10px;background:transparent;color:#666;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-family:inherit">取消</button>') +
        '<button onclick="NBS_NAV._saveMember(' + (person ? JSON.stringify(person.personId) : 'null') + ',' + (isNew?'true':'false') + ')" style="flex:2;padding:10px;background:#378ADD;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">儲存</button>' +
      '</div>' +
    '</div>';
  }

  global.NBS_NAV._saveMember = function(personId, isNew) {
    var name    = (document.getElementById("nmf-name")||{}).value||"";
    var rel     = (document.getElementById("nmf-relation")||{}).value||"secondary";
    var birth   = (document.getElementById("nmf-birth")||{}).value||"";
    var address = (document.getElementById("nmf-address")||{}).value||"";

    if (!name.trim()) { alert("請填寫姓名"); return; }

    // 呼叫頁面的成員儲存函式（如果存在），否則用 GAS 直接儲存
    if (typeof window.navSaveMember === "function") {
      window.navSaveMember({ personId:personId, isNew:isNew, name:name.trim(), relation:rel, birthDate:birth, address:address });
    } else {
      // 通用儲存邏輯
      _saveNavMember({ personId:personId, isNew:isNew, name:name.trim(), relation:rel, birthDate:birth, address:address });
    }
  };

  async function _saveNavMember(data) {
    var user = _user;
    if (!user) return;
    var fn = localStorage.getItem("nbs_current_family");

    try {
      var pid = data.isNew ? ("p_" + Date.now()) : data.personId;

      // 更新 family 成員資料
      if (!_family) return;
      if (data.isNew) {
        _family.members.push({ personId:pid, name:data.name, relation:data.relation, role:"secondary" });
      } else {
        var m = _family.members.find(function(x){ return x.personId===pid; });
        if (m) { m.name=data.name; m.relation=data.relation; }
      }

      // 讀取或建立個人 JSON
      var personFileName = data.name + "_" + pid + ".json";
      var person;
      if (!data.isNew) {
        try {
          var pr = await _callGAS("readFile", { email:user.email, fileType:"person", fileName:personFileName });
          person = pr.status==="ok" ? pr.content : null;
        } catch(e) { person = null; }
      }
      if (!person) {
        person = { personId:pid, profile:{}, policies:[], coverage:{}, savings:[] };
      }
      person.profile = person.profile || {};
      person.profile.name       = data.name;
      person.profile.birthDate  = data.birthDate || null;
      person.profile.address    = data.address || null;
      person.profile.analysisDate = _family.analysisDate || new Date().toISOString().slice(0,10);
      person.updatedAt = new Date().toISOString();

      // 儲存 person
      await _callGAS("saveFile", {
        email:user.email, fileType:"person", fileId:pid,
        fileName:personFileName, content:person
      });

      // 儲存 family
      await _callGAS("saveFile", {
        email:user.email, fileType:"family", fileId:_family.familyId||fn,
        fileName:fn, content:_family
      });

      // 清除快取，重新渲染側欄
      var cacheKey = "nbs_fam_" + fn;
      try { sessionStorage.removeItem(cacheKey); } catch(e) {}

      // 重新渲染側欄
      _renderAll();
      // 關閉 Modal
      var modal = document.getElementById("nbs-member-modal");
      if (modal) modal.remove();
      // 通知頁面重新載入
      if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(_personId);

    } catch(e) {
      alert("儲存失敗：" + e.message);
    }
  }

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
    NBS_NAV._openMemberModal();
    NBS_NAV._openEfForm(null); // 新增模式
  };

  // ── 家庭成員 Modal ──────────────────────────────────────
  var _editingPersonId = null;

  global.NBS_NAV._openMemberModal = function() {
    if (!_family) return;
    var listEl = document.getElementById("nbs-mm-list");
    if (!listEl) return;
    var members = (_family.members||[]).filter(function(m){ return m.role!=="beneficiary_only"; });
    var html = "";
    members.forEach(function(m) {
      var age = "";
      if (m.birthDate || (window.personDataMap && window.personDataMap[m.personId])) {
        var bd = m.birthDate || (window.personDataMap&&window.personDataMap[m.personId]&&window.personDataMap[m.personId].profile&&window.personDataMap[m.personId].profile.birthDate);
        var ad = _family.analysisDate || new Date().toISOString().slice(0,10);
        if (bd) { var b=new Date(bd),a=new Date(ad); var y=a.getFullYear()-b.getFullYear(); if((a-new Date(b.getFullYear()+y,b.getMonth(),b.getDate()))/(1000*60*60*24*30.4375)>=6)y++; age=y+"歲"; }
      }
      html += '<div class="nbs-mm-member">'+
        '<div class="nbs-mm-avatar">'+m.name[0]+'</div>'+
        '<div class="nbs-mm-info">'+
          '<div class="nbs-mm-name">'+m.name+'</div>'+
          '<div class="nbs-mm-sub">'+(m.relation||m.role)+(age?" · "+age:"")+'</div>'+
        '</div>'+
        '<button class="nbs-mm-edit" onclick="NBS_NAV._openEfForm(\''+m.personId+'\')">✏️ 編輯</button>'+
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
    // family.html 有內嵌表單；其他頁面（policy、coverage 等）用 overlay modal
    var form = document.getElementById("nbs-edit-member-form");
    if (!form) {
      // fallback：使用第一版 overlay modal（支援任何頁面）
      NBS_NAV._openMemberModal(personId ? "edit" : "new", personId || null);
      return;
    }

    _editingPersonId = personId;
    form.style.display = "block";

    // 取得成員資料：優先 personDataMap，其次直接從 family.members 讀
    var p   = (window.personDataMap && personId && window.personDataMap[personId]) || null;
    var m   = (_family.members||[]).find(function(x){ return x.personId===personId; });
    // 若 personDataMap 沒有，從 family member 本身讀取基本資料
    var name    = (p && p.profile && p.profile.name)      || (m && m.name)      || "";
    var birth   = (p && p.profile && p.profile.birthDate) || (m && m.birthDate) || "";
    var address = (p && p.profile && p.profile.address)   || "";
    var rel     = (m && m.relation) || "本人";

    if (personId) {
      document.getElementById("nbs-ef-name").value     = name;
      document.getElementById("nbs-ef-relation").value  = rel;
      document.getElementById("nbs-ef-birth").value    = birth;
      document.getElementById("nbs-ef-address").value  = address;
      NBS_NAV._updateEfAge();
    } else {
      document.getElementById("nbs-ef-name").value     = "";
      document.getElementById("nbs-ef-relation").value  = "本人";
      document.getElementById("nbs-ef-birth").value    = "";
      document.getElementById("nbs-ef-address").value  = "";
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
    if (!birth) { hint.textContent=""; return; }
    var b=new Date(birth), a=new Date(_family&&_family.analysisDate||new Date());
    var y=a.getFullYear()-b.getFullYear();
    if((a-new Date(b.getFullYear()+y,b.getMonth(),b.getDate()))/(1000*60*60*24*30.4375)>=6)y++;
    hint.textContent = "保險年齡："+y+"歲";
  };

  global.NBS_NAV._saveEfMember = async function() {
    var name    = document.getElementById("nbs-ef-name").value.trim();
    var rel     = document.getElementById("nbs-ef-relation").value;
    var birth   = document.getElementById("nbs-ef-birth").value;
    var address = document.getElementById("nbs-ef-address").value.trim();
    if (!name) { alert("請填寫姓名"); return; }
    if (!_user) { alert("登入資訊遺失，請重新整理"); return; }

    var saveBtn = document.querySelector(".nbs-ef-save");
    saveBtn.textContent = "儲存中…"; saveBtn.disabled = true;

    try {
      if (_editingPersonId) {
        // 編輯現有成員
        var p = window.personDataMap && window.personDataMap[_editingPersonId];
        if (p) {
          p.profile.name    = name;
          p.profile.birthDate = birth || null;
          p.profile.address   = address || null;
          p.updatedAt = new Date().toISOString();
          var m = (_family.members||[]).find(function(x){ return x.personId===_editingPersonId; });
          if (m) m.relation = rel;
          await _callGAS_POST("saveFile", { email:_user.email, fileType:"person", fileId:_editingPersonId, fileName:name+"_"+_editingPersonId+".json", content:p });
          // 更新家庭
          await _callGAS_POST("saveFile", { email:_user.email, fileType:"family", fileId:_family.id||"", fileName:_family.familyName+"_f_"+(_family.id||"")+".json", content:_family });
          // 清除 sessionStorage 快取
          sessionStorage.clear();
          if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(_editingPersonId);
        }
      } else {
        // 新增成員
        var newId = "p_" + Date.now();
        var newPerson = { profile:{ name:name, birthDate:birth||null, analysisDate:_family.analysisDate, address:address||null }, policies:[], coverage:{}, savings:[], updatedAt:new Date().toISOString() };
        if (!window.personDataMap) window.personDataMap = {};
        window.personDataMap[newId] = newPerson;
        _family.members.push({ personId:newId, name:name, role:"secondary", relation:rel, birthDate:birth||null });
        await _callGAS_POST("saveFile", { email:_user.email, fileType:"person", fileId:newId, fileName:name+"_"+newId+".json", content:newPerson });
        await _callGAS_POST("saveFile", { email:_user.email, fileType:"family", fileId:_family.id||"", fileName:localStorage.getItem("nbs_current_family"), content:_family });
        sessionStorage.clear();
      }
      NBS_NAV._closeMemberModal();
      _renderSidebar();
      alert("已儲存！");
    } catch(e) {
      alert("儲存失敗："+e.message);
    } finally {
      saveBtn.textContent = "儲存"; saveBtn.disabled = false;
    }
  };

  // ── 工具 ─────────────────────────────────────────────────
  function _fmtROC(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d)) return s;
    return (d.getFullYear()-1911)+"年"+(d.getMonth()+1)+"月"+d.getDate()+"日";
  }
  function _debounce(fn, ms) { var t; return function(){ clearTimeout(t); t=setTimeout(fn,ms); }; }
  function _callGAS_POST(action, params) {
    return fetch(GAS_URL, {
      method:"POST",
      headers:{"Content-Type":"text/plain"},
      body:JSON.stringify(Object.assign({action:action},params))
    }).then(function(r){ return r.json(); });
  }

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
        overflow-y:hidden;z-index:200;
      }
      /* 成員區：最多顯示4個，超過可捲動 */
      .nbs-msec {
        max-height:220px;
        overflow-y:auto;
        flex-shrink:0;
      }
      /* 功能區：剩餘空間，可捲動 */
      .nbs-nsec {
        flex:1;
        overflow-y:auto;
        min-height:0;
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
      /* 家庭成員入口 */
      .nbs-member-entry{display:flex;align-items:center;gap:10px;padding:9px 10px;margin:4px 10px 0;border-radius:8px;cursor:pointer;border:1px dashed rgba(255,255,255,0.2);transition:all .15s}
      .nbs-member-entry:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.35)}
      /* 成員 Modal */
      #nbs-member-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:500;align-items:center;justify-content:center;padding:20px}
      #nbs-member-modal.open{display:flex}
      #nbs-member-modal-box{background:#fff;border-radius:14px;width:100%;max-width:460px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.2)}
      .nbs-mm-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #f0f0f0}
      .nbs-mm-title{font-size:15px;font-weight:600;color:#1a1a1a}
      .nbs-mm-close{background:none;border:none;font-size:22px;color:#aaa;cursor:pointer;line-height:1}
      .nbs-mm-body{padding:14px 18px}
      .nbs-mm-member{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:#f7f7f5;border:1px solid #eee}
      .nbs-mm-avatar{width:36px;height:36px;border-radius:50%;background:#378ADD;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#fff;flex-shrink:0}
      .nbs-mm-info{flex:1;min-width:0}
      .nbs-mm-name{font-size:13px;font-weight:500;color:#333}
      .nbs-mm-sub{font-size:11px;color:#aaa;margin-top:1px}
      .nbs-mm-edit{padding:5px 12px;font-size:12px;border:1px solid #ddd;border-radius:99px;background:#fff;cursor:pointer;color:#555;font-family:inherit;flex-shrink:0}
      .nbs-mm-edit:hover{border-color:#378ADD;color:#378ADD}
      .nbs-mm-add{width:100%;padding:10px;background:#378ADD;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:6px}
      /* 編輯/新增成員表單 */
      #nbs-edit-member-form{display:none;padding:14px 18px;border-top:1px solid #f0f0f0}
      .nbs-ef-label{font-size:12px;color:#666;margin-bottom:3px;display:block}
      .nbs-ef-input{width:100%;padding:8px 11px;font-size:13px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit;margin-bottom:10px}
      .nbs-ef-input:focus{border-color:#378ADD}
      .nbs-ef-hint{font-size:11px;color:#378ADD;margin-top:-8px;margin-bottom:8px}
      .nbs-ef-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .nbs-ef-btns{display:flex;gap:8px;margin-top:4px}
      .nbs-ef-cancel{flex:1;padding:9px;background:transparent;color:#666;border:1px solid #ddd;border-radius:7px;cursor:pointer;font-family:inherit;font-size:13px}
      .nbs-ef-save{flex:2;padding:9px;background:#378ADD;color:#fff;border:none;border-radius:7px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500}
      @media print {
        #nbs-sidebar,#nbs-mobile-hdr,#nbs-bottom-tab{display:none!important}
        body{padding-left:0!important;padding-top:0!important;padding-bottom:0!important}
      }
    `;
    document.head.appendChild(s);
  }

})(window);
