/**
 * NBS 導覽系統 nav.js v4
 * Drive 操作全部改為前端直接呼叫 Drive REST API（用使用者自己的 access_token）
 * GAS 只保留身份驗證（checkAuth / apply）
 */
(function(global) {
  "use strict";

  // ==========================================
  // 1. 系統設定
  // ==========================================
  var AUTH_GAS_URL = "https://script.google.com/macros/s/AKfycbwzDwyZy09189eOJOs-zEwkZOml2_pJOq15nYGtHF2Kyrtv6ag5VY-I2M8sDyrt0iPdZQ/exec";
  var TOKEN_MARGIN = 5 * 60 * 1000; // 提前 5 分鐘視為過期

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

  var _page     = "";
  var _family   = null;
  var _personId = null;
  var _user     = null;

  // ==========================================
  // 2. Token 管理
  // ==========================================
  function _getToken() {
    return localStorage.getItem("nbs_access_token") || null;
  }

  function _isTokenValid() {
    var expiry = parseInt(localStorage.getItem("nbs_token_expiry") || "0", 10);
    return expiry - Date.now() > TOKEN_MARGIN;
  }

  // token 過期時導回 index 重新授權
  function _ensureToken() {
    if (!_isTokenValid()) {
      window.location.href = "index.html";
      throw new Error("token_expired");
    }
    return _getToken();
  }

  // ==========================================
  // 3. Google Drive REST API 引擎
  // ==========================================
  var DriveDB = {
    folderCache: {},

    async req(path, opts) {
      var token = _ensureToken();
      var headers = Object.assign({ "Authorization": "Bearer " + token }, (opts || {}).headers || {});
      var res = await fetch("https://www.googleapis.com/" + path, Object.assign({}, opts || {}, { headers: headers }));
      if (res.status === 401) {
        // token 被撤銷，強制重新登入
        localStorage.removeItem("nbs_access_token");
        localStorage.removeItem("nbs_token_expiry");
        window.location.href = "index.html";
        throw new Error("unauthorized");
      }
      return res;
    },

    async getFolder(name, parentId) {
      parentId = parentId || "root";
      var q = "name='" + name + "' and '" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false";
      var res = await this.req("drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id)");
      var data = await res.json();
      return (data.files && data.files.length > 0) ? data.files[0].id : null;
    },

    async createFolder(name, parentId) {
      parentId = parentId || "root";
      var res = await this.req("drive/v3/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] })
      });
      var data = await res.json();
      return data.id;
    },

    async ensureFolder(email, subFolder) {
      var cacheKey = email + "_" + subFolder;
      if (this.folderCache[cacheKey]) return this.folderCache[cacheKey];

      // NBS 根目錄
      var rootId = await this.getFolder("NBS雲端保單體檢");
      if (!rootId) rootId = await this.createFolder("NBS雲端保單體檢");

      // 業務員目錄（email 轉換為合法資料夾名稱）
      var agentName = email.replace(/[^a-zA-Z0-9]/g, "_");
      var agentId = await this.getFolder(agentName, rootId);
      if (!agentId) agentId = await this.createFolder(agentName, rootId);

      // 子目錄（families / persons / visits）
      var targetId = await this.getFolder(subFolder, agentId);
      if (!targetId) targetId = await this.createFolder(subFolder, agentId);

      this.folderCache[cacheKey] = targetId;
      return targetId;
    },

    async saveFile(email, folderType, fileName, content) {
      var parentId = await this.ensureFolder(email, folderType);

      // 查找是否已存在同名檔案
      var q = "name='" + fileName + "' and '" + parentId + "' in parents and trashed=false";
      var searchRes = await this.req("drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id)");
      var searchData = await searchRes.json();

      var boundary = "NBS_BOUNDARY_314159";
      var body =
        "\r\n--" + boundary + "\r\n" +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify({ name: fileName, mimeType: "application/json" }) +
        "\r\n--" + boundary + "\r\n" +
        "Content-Type: application/json\r\n\r\n" +
        JSON.stringify(content, null, 2) +
        "\r\n--" + boundary + "--";

      var headers = { "Content-Type": "multipart/related; boundary=" + boundary };

      if (searchData.files && searchData.files.length > 0) {
        // 更新
        await this.req("upload/drive/v3/files/" + searchData.files[0].id + "?uploadType=multipart", {
          method: "PATCH", headers: headers, body: body
        });
      } else {
        // 新增（metadata 要加 parents）
        var metaWithParent = { name: fileName, mimeType: "application/json", parents: [parentId] };
        var body2 =
          "\r\n--" + boundary + "\r\n" +
          "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
          JSON.stringify(metaWithParent) +
          "\r\n--" + boundary + "\r\n" +
          "Content-Type: application/json\r\n\r\n" +
          JSON.stringify(content, null, 2) +
          "\r\n--" + boundary + "--";
        await this.req("upload/drive/v3/files?uploadType=multipart", {
          method: "POST", headers: headers, body: body2
        });
      }
      return { status: "ok" };
    },

    async readFile(email, folderType, fileName) {
      var parentId = await this.ensureFolder(email, folderType);
      var q = "name='" + fileName + "' and '" + parentId + "' in parents and trashed=false";
      var res = await this.req("drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id)");
      var data = await res.json();
      if (!data.files || data.files.length === 0) return { status: "not_found", content: null };
      var fileRes = await this.req("drive/v3/files/" + data.files[0].id + "?alt=media");
      var content = await fileRes.json();
      return { status: "ok", content: content };
    },

    async listFamilies(email) {
      var parentId = await this.ensureFolder(email, "families");
      var q = "'" + parentId + "' in parents and trashed=false and name contains '.json'";
      var res = await this.req("drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id,name)&orderBy=modifiedTime desc");
      var data = await res.json();
      var families = [];
      for (var i = 0; i < (data.files || []).length; i++) {
        try {
          var file = data.files[i];
          var fileRes = await this.req("drive/v3/files/" + file.id + "?alt=media");
          var content = await fileRes.json();
          families.push({
            fileName:     file.name,
            fileId:       file.id,
            familyId:     content.familyId     || "",
            familyName:   content.familyName   || "",
            analysisDate: content.analysisDate  || "",
            updatedAt:    content.updatedAt     || "",
            memberCount:  (content.members || []).filter(function(m){ return m.role !== "beneficiary_only"; }).length,
          });
        } catch(e) { /* 跳過格式錯誤 */ }
      }
      families.sort(function(a,b){ return new Date(b.updatedAt) - new Date(a.updatedAt); });
      return { families: families };
    },

    async listVisits(email, familyId) {
      var parentId = await this.ensureFolder(email, "visits");
      var q = "'" + parentId + "' in parents and trashed=false and name contains 'visit_'";
      var res = await this.req("drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id,name)");
      var data = await res.json();
      var visits = [];
      for (var i = 0; i < (data.files || []).length; i++) {
        try {
          var fileRes = await this.req("drive/v3/files/" + data.files[i].id + "?alt=media");
          var v = await fileRes.json();
          if (!familyId || v.familyId === familyId) visits.push(v);
        } catch(e) {}
      }
      visits.sort(function(a,b){ return (b.date||"").localeCompare(a.date||""); });
      return { status: "ok", visits: visits };
    },

    async deleteVisit(email, visitId) {
      var parentId = await this.ensureFolder(email, "visits");
      var q = "name='visit_" + visitId + ".json' and '" + parentId + "' in parents and trashed=false";
      var res = await this.req("drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id)");
      var data = await res.json();
      if (data.files && data.files.length > 0) {
        await this.req("drive/v3/files/" + data.files[0].id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: true })
        });
      }
      return { status: "ok" };
    }
  };

  // ==========================================
  // 4. 公開 API
  // ==========================================
  global.NBS_NAV = {
    init: function(opts) {
      _page = opts.page || "";
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function() { _setup(opts); });
      } else {
        _setup(opts);
      }
    },
    getCurrentPersonId: function() { return _personId; },
    getFamilyData:      function() { return _family; },
    getUser:            function() { return _user; },

    // callGAS：只留身份驗證類動作；Drive 操作改走 DriveDB
    callGAS: async function(action, params) {
      var authActions = ["apply", "checkAuth", "getAgents", "getHospitals"];
      if (authActions.indexOf(action) !== -1) {
        var res = await fetch(AUTH_GAS_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(Object.assign({ action: action }, params))
        });
        return await res.json();
      }

      // Drive 操作 → 直接呼叫 DriveDB
      var email = (_user && _user.email) || (params && params.email) || "";
      switch (action) {
        case "saveFile":
          return DriveDB.saveFile(email, params.fileType, params.fileName, params.content);
        case "readFile":
          return DriveDB.readFile(email, params.fileType, params.fileName);
        case "listFamilies":
          return DriveDB.listFamilies(email);
        case "saveVisit":
          return DriveDB.saveFile(email, "visits", "visit_" + params.visit.id + ".json", params.visit);
        case "listVisits":
          return DriveDB.listVisits(email, params.familyId || null);
        case "deleteVisit":
          return DriveDB.deleteVisit(email, params.visitId);
        default:
          return { status: "error", message: "未知 action: " + action };
      }
    },

    // 供外部直接使用 DriveDB
    DriveDB: DriveDB,
    onMemberChange: null,
  };

  // ==========================================
  // 5. 初始化
  // ==========================================
  function _setup(opts) {
    _injectStyles();
    _insertNav();

    var savedUser = localStorage.getItem("nbs_user");
    if (!savedUser) {
      // 未登入且不在 index.html → 導回登入
      if (window.location.href.indexOf("index.html") === -1) {
        window.location.href = "index.html";
      }
      return;
    }
    _user = JSON.parse(savedUser);

    // 驗證 token 是否有效
    if (!_isTokenValid()) {
      // Token 過期 → 導回 index 做靜默重新授權
      window.location.href = "index.html";
      return;
    }

    // main.html 不需要載入 family
    if (window.location.href.indexOf("main.html") !== -1) return;

    _loadData(opts);
  }

  // ==========================================
  // 6. 資料載入
  // ==========================================
  function _loadData(opts) {
    var fn = localStorage.getItem("nbs_current_family");
    if (!fn) { window.location.href = "main.html"; return; }

    DriveDB.readFile(_user.email, "families", fn)
      .then(function(fr) {
        if (!fr || fr.status === "not_found" || !fr.content) {
          console.warn("[nav] 家庭資料 not_found，fn=", fn);
          _finishLoad(fn, true); return;
        }
        _family = fr.content;
        _personId = localStorage.getItem("nbs_current_person") ||
                    (_family.members && _family.members[0] && _family.members[0].personId) || null;
        _finishLoad(fn, false);
      })
      .catch(function(e) {
        console.error("[nav] 載入家庭失敗", e);
        _finishLoad(fn, true);
      });
  }

  function _finishLoad(fn, isError) {
    _renderAll();
    window.dispatchEvent(new CustomEvent("nbs_nav_ready", {
      detail: {
        user: _user,
        familyData: isError ? null : _family,
        currentPersonId: isError ? null : _personId,
        familyFileName: fn
      }
    }));
  }

  // family.html 自己載入資料後通知 nav 補渲染側邊欄
  window.addEventListener("nbs_family_loaded", function(e) {
    if (_family) return; // nav 已有資料，不需重複
    var detail = e.detail || {};
    _family = detail.familyData || null;
    if (!_family) return;
    _personId = (_family.members && _family.members[0] && _family.members[0].personId) || null;
    _renderAll();
  });

  // ==========================================
  // 7. UI 插入與渲染（維持原版）
  // ==========================================
  function _insertNav() {
    var sidebar = document.createElement("div");
    sidebar.id = "nbs-sidebar";
    sidebar.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,0.3);font-size:12px">載入中…</div>';
    document.body.insertBefore(sidebar, document.body.firstChild);

    var tab = document.createElement("div");
    tab.id = "nbs-bottom-tab";
    document.body.appendChild(tab);

    var hdr = document.createElement("div");
    hdr.id = "nbs-mobile-hdr";
    document.body.insertBefore(hdr, sidebar.nextSibling);

    _applyLayout();
    window.addEventListener("resize", _debounce(_applyLayout, 150));

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
          '<label class="nbs-ef-label">住家地址（縣市＋區，用於醫院病房費查詢）</label>' +
          '<input class="nbs-ef-input" id="nbs-ef-address" placeholder="如：台北市中正區"/>' +
          '<div class="nbs-ef-btns">' +
            '<button class="nbs-ef-cancel" onclick="NBS_NAV._closeEfForm()">取消</button>' +
            '<button class="nbs-ef-save" onclick="NBS_NAV._saveEfMember()">儲存</button>' +
          '</div>' +
        '</div>' +
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

  function _renderAll() {
    _renderSidebar();
    _renderBottomTab();
    _renderMobileHdr();
    _applyLayout();
  }

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
      '<div class="nbs-logo" style="padding:12px 14px 10px;border-bottom:1px solid rgba(255,255,255,.08)">' +
        '<div style="font-size:16px;font-weight:700;color:#fff;letter-spacing:.5px">🛡️ NBS</div>' +
      '</div>' +
      '<div class="nbs-fam">' +
        '<div class="nbs-sl">目前家庭</div>' +
        '<div class="nbs-fn">'+_family.familyName+'</div>' +
        '<div class="nbs-fd">分析日 '+_fmtROC(_family.analysisDate)+'</div>' +
      '</div>' +
      '<div class="nbs-nsec">' +
        '<div class="nbs-sl">功能模組</div>' +
        navHtml +
      '</div>' +
      '<div class="nbs-member-entry" onclick="NBS_NAV._openMemberModal()">' +
        '<span class="nbs-nicon">👨‍👩‍👧</span>' +
        '<span class="nbs-nlabel">家庭成員管理</span>' +
      '</div>' +
      '<div class="nbs-foot">' +
        '<button class="nbs-pbtn" onclick="NBS_NAV._print()">🖨️ 快速列印此頁</button>' +
        '<button class="nbs-bbtn" onclick="NBS_NAV._back()">← 返回家庭列表</button>' +
        '<div class="nbs-disclaimer">本報告為保障檢視參考，實際理賠項目與條件以各保險公司正式契約條款為準。</div>' +
      '</div>';
  }

  function _renderBottomTab() {
    var el = document.getElementById("nbs-bottom-tab");
    if (!el) return;
    el.innerHTML = NAV_ITEMS.map(function(item) {
      var active = _page === item.key;
      return '<div class="nbs-ti'+(active?" nbs-ti-on":"")+'" onclick="NBS_NAV._go(\''+item.href+'\')">' +
        '<span style="font-size:20px">'+item.icon+'</span>' +
        '<span class="nbs-tl">'+item.label+'</span>' +
        (active ? '<div class="nbs-tdot"></div>' : '') +
      '</div>';
    }).join("");
  }

  function _renderMobileHdr() {
    var el = document.getElementById("nbs-mobile-hdr");
    if (!el || !_family) return;
    var members = (_family.members||[]).filter(function(m){ return m.role !== "beneficiary_only"; });
    var opts = members.map(function(m){
      return '<option value="'+m.personId+'"'+(m.personId===_personId?" selected":"")+'>'+m.name+'（'+(m.relation||m.role)+'）</option>';
    }).join("") + '<option value="__add__">＋ 新增成員</option>';
    el.innerHTML =
      '<div style="font-size:14px;font-weight:700;color:#fff;flex-shrink:0">🛡️ NBS</div>' +
      '<div style="flex:1;min-width:0;font-size:11px;color:rgba(255,255,255,0.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_family.familyName+'</div>' +
      '<select onchange="NBS_NAV._setPerson(this.value)" style="padding:4px 8px;font-size:12px;border:none;border-radius:99px;background:rgba(255,255,255,0.12);color:#fff;outline:none;cursor:pointer;font-family:inherit">'+opts+'</select>' +
      '<button onclick="NBS_NAV._print()" style="padding:5px 8px;background:rgba(255,255,255,0.12);border:none;border-radius:6px;color:rgba(255,255,255,0.8);font-size:13px;cursor:pointer">🖨️</button>';
  }

  // ==========================================
  // 8. 成員管理（維持原版邏輯，儲存改走 DriveDB）
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
      var m = (_family.members||[]).find(function(x){ return x.personId===personId; });
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

  global.NBS_NAV._saveEfMember = async function() {
    var name    = document.getElementById("nbs-ef-name").value.trim();
    var rel     = document.getElementById("nbs-ef-relation").value;
    var birth   = document.getElementById("nbs-ef-birth").value;
    var address = document.getElementById("nbs-ef-address").value.trim();
    if (!name) { alert("請填寫姓名"); return; }
    if (!_user) { alert("登入資訊遺失，請重新整理"); return; }

    var saveBtn = document.querySelector(".nbs-ef-save");
    saveBtn.textContent = "儲存中…"; saveBtn.disabled = true;

    var fn = localStorage.getItem("nbs_current_family");

    try {
      if (_editingPersonId) {
        // 編輯
        var m = (_family.members||[]).find(function(x){ return x.personId===_editingPersonId; });
        if (m) { m.name=name; m.relation=rel; m.birthDate=birth||null; }
        var p = window.personDataMap && window.personDataMap[_editingPersonId];
        if (p) {
          p.profile.name=name; p.profile.birthDate=birth||null; p.profile.address=address||null;
          p.updatedAt = new Date().toISOString();
          await DriveDB.saveFile(_user.email, "persons", name+"_"+_editingPersonId+".json", p);
        }
      } else {
        // 新增
        var newId = "p_" + Date.now();
        var newPerson = { personId:newId, profile:{ name:name, birthDate:birth||null, analysisDate:_family.analysisDate, address:address||null }, policies:[], coverage:{}, savings:[], updatedAt:new Date().toISOString() };
        if (!window.personDataMap) window.personDataMap = {};
        window.personDataMap[newId] = newPerson;
        _family.members.push({ personId:newId, name:name, role:"secondary", relation:rel, birthDate:birth||null });
        await DriveDB.saveFile(_user.email, "persons", name+"_"+newId+".json", newPerson);
      }
      // 儲存 family
      _family.updatedAt = new Date().toISOString();
      await DriveDB.saveFile(_user.email, "families", fn, _family);
      NBS_NAV._closeMemberModal();
      _renderSidebar();
      if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(_editingPersonId);
      alert("已儲存！");
    } catch(e) {
      alert("儲存失敗：" + e.message);
    } finally {
      saveBtn.textContent = "儲存"; saveBtn.disabled = false;
    }
  };

  // ==========================================
  // 9. 動作
  // ==========================================
  global.NBS_NAV._setPerson = function(id) {
    if (id === "__add__") { NBS_NAV._openMemberModal(); return; }
    _personId = id;
    localStorage.setItem("nbs_current_person", id);
    _renderAll();
    if (typeof NBS_NAV.onMemberChange === "function") NBS_NAV.onMemberChange(id);
  };
  global.NBS_NAV._go    = function(href) { window.location.href = href; };
  global.NBS_NAV._print = function() { window.print(); };
  global.NBS_NAV._back  = function() { window.location.href = "main.html"; };

  // ==========================================
  // 10. 工具
  // ==========================================
  function _fmtROC(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d)) return s;
    return (d.getFullYear()-1911)+"年"+(d.getMonth()+1)+"月"+d.getDate()+"日";
  }
  function _debounce(fn, ms) { var t; return function(){ clearTimeout(t); t=setTimeout(fn,ms); }; }

  // ==========================================
  // 11. 樣式
  // ==========================================
  function _injectStyles() {
    if (document.getElementById("nbs-nav-css")) return;
    var s = document.createElement("style");
    s.id = "nbs-nav-css";
    s.textContent = [
      "#nbs-sidebar{position:fixed;top:0;left:0;bottom:0;width:220px;background:#1A2B4A;display:flex;flex-direction:column;overflow-y:hidden;z-index:200}",
      ".nbs-nsec{padding:8px 10px;flex:1;overflow-y:auto;min-height:0}",
      "#nbs-mobile-hdr{position:fixed;top:0;left:0;right:0;height:50px;background:#1A2B4A;display:none;align-items:center;gap:8px;padding:0 14px;z-index:200}",
      "#nbs-bottom-tab{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e8e8e8;display:none;z-index:200;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:env(safe-area-inset-bottom,0)}",
      ".nbs-fam{padding:10px 14px 8px}",
      ".nbs-fn{font-size:13px;font-weight:500;color:#fff}",
      ".nbs-fd{font-size:10px;color:rgba(255,255,255,.35);margin-top:2px}",
      ".nbs-sl{font-size:10px;color:rgba(255,255,255,.4);padding:0 4px 5px;letter-spacing:.05em}",
      ".nbs-ni{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;border-left:3px solid transparent;transition:all .15s}",
      ".nbs-ni:hover{background:rgba(255,255,255,.06)}",
      ".nbs-ni-on{background:rgba(55,138,221,.18);border-left-color:#378ADD}",
      ".nbs-nicon{font-size:15px;flex-shrink:0}",
      ".nbs-nlabel{font-size:13px;color:rgba(255,255,255,.6)}",
      ".nbs-ni-on .nbs-nlabel{color:#fff;font-weight:500}",
      ".nbs-foot{padding:10px;border-top:1px solid rgba(255,255,255,.08)}",
      ".nbs-disclaimer{margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:10px;color:rgba(255,255,255,.25);line-height:1.6;letter-spacing:.01em}",
      ".nbs-pbtn{width:100%;padding:8px;margin-bottom:5px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.12);border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px}",
      ".nbs-pbtn:hover{background:rgba(255,255,255,.14)}",
      ".nbs-bbtn{width:100%;padding:7px;background:transparent;color:rgba(255,255,255,.35);border:none;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px}",
      ".nbs-bbtn:hover{color:rgba(255,255,255,.6)}",
      ".nbs-ti{flex:0 0 auto;min-width:64px;max-width:80px;display:flex;flex-direction:column;align-items:center;padding:8px 4px 5px;cursor:pointer;color:#999}",
      ".nbs-ti-on{color:#378ADD}",
      ".nbs-tl{font-size:9px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      ".nbs-ti-on .nbs-tl{font-weight:500}",
      ".nbs-tdot{width:20px;height:2px;background:#378ADD;border-radius:99px;margin-top:2px}",
      ".nbs-member-entry{display:flex;align-items:center;gap:10px;padding:9px 10px;margin:4px 10px 0;border-radius:8px;cursor:pointer;border:1px dashed rgba(255,255,255,0.2);transition:all .15s}",
      ".nbs-member-entry:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.35)}",
      "#nbs-member-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:500;align-items:center;justify-content:center;padding:20px}",
      "#nbs-member-modal.open{display:flex}",
      "#nbs-member-modal-box{background:#fff;border-radius:14px;width:100%;max-width:460px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.2)}",
      ".nbs-mm-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #f0f0f0}",
      ".nbs-mm-title{font-size:15px;font-weight:600;color:#1a1a1a}",
      ".nbs-mm-close{background:none;border:none;font-size:22px;color:#aaa;cursor:pointer;line-height:1}",
      ".nbs-mm-body{padding:14px 18px}",
      ".nbs-mm-member{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:#f7f7f5;border:1px solid #eee}",
      ".nbs-mm-avatar{width:36px;height:36px;border-radius:50%;background:#378ADD;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#fff;flex-shrink:0}",
      ".nbs-mm-info{flex:1;min-width:0}",
      ".nbs-mm-name{font-size:13px;font-weight:500;color:#333}",
      ".nbs-mm-sub{font-size:11px;color:#aaa;margin-top:1px}",
      ".nbs-mm-edit{padding:5px 12px;font-size:12px;border:1px solid #ddd;border-radius:99px;background:#fff;cursor:pointer;color:#555;font-family:inherit;flex-shrink:0}",
      ".nbs-mm-edit:hover{border-color:#378ADD;color:#378ADD}",
      ".nbs-mm-add{width:100%;padding:10px;background:#378ADD;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:6px}",
      "#nbs-edit-member-form{display:none;padding:14px 18px;border-top:1px solid #f0f0f0}",
      ".nbs-ef-label{font-size:12px;color:#666;margin-bottom:3px;display:block}",
      ".nbs-ef-input{width:100%;padding:8px 11px;font-size:13px;border:1px solid #e0e0e0;border-radius:7px;outline:none;font-family:inherit;margin-bottom:10px}",
      ".nbs-ef-input:focus{border-color:#378ADD}",
      ".nbs-ef-hint{font-size:11px;color:#378ADD;margin-top:-8px;margin-bottom:8px}",
      ".nbs-ef-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".nbs-ef-btns{display:flex;gap:8px;margin-top:4px}",
      ".nbs-ef-cancel{flex:1;padding:9px;background:transparent;color:#666;border:1px solid #ddd;border-radius:7px;cursor:pointer;font-family:inherit;font-size:13px}",
      ".nbs-ef-save{flex:2;padding:9px;background:#378ADD;color:#fff;border:none;border-radius:7px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500}",
      "@media print{#nbs-sidebar,#nbs-mobile-hdr,#nbs-bottom-tab{display:none!important}body{padding-left:0!important;padding-top:0!important;padding-bottom:0!important}}"
    ].join("\n");
    document.head.appendChild(s);
  }

})(window);
