/**
 * NBS 導覽系統 nav.js v5
 * 架構：所有 Drive 操作透過 GAS API1 轉發到業務員自己的 Shell GAS
 * 業務員資料完全存在自己的 Drive，管理員無法存取
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
    init: function(opts) {
      _page = opts.page || "";
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function() { _setup(opts); });
      } else {
        _setup(opts);
      }
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
    sidebar.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,0.3);font-size:12px">連線同步中...</div>';
    document.body.insertBefore(sidebar, document.body.firstChild);

    var tab = document.createElement("div");
    tab.id = "nbs-bottom-tab";
    document.body.appendChild(tab);

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
  }

  function _applyLayout() {
    var mobile  = window.innerWidth < 768;
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
      document.body.style.paddingLeft = "200px";
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
        '<div class="nbs-fn">'+_family.familyName+'</div>' +
        '<div class="nbs-fd">分析日 '+_fmtROC(_family.analysisDate)+'</div>' +
      '</div>' +
      '<div class="nbs-nsec">' +
        '<div class="nbs-sl">功能模組</div>' +
        navHtml +
      '</div>' +
      '<div class="nbs-ni" onclick="NBS_NAV._goFamily()">' +
        '<span class="nbs-nicon">🏠</span>' +
        '<span class="nbs-nlabel">家庭保單首頁</span>' +
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
      '<img src="https://i.ibb.co/FkVkNhhd/NBS-4F3.jpg" style="height:28px;width:auto;object-fit:contain;flex-shrink:0" onerror="this.style.display=\'none\'"/>' +
      '<div style="flex:1;min-width:0;font-size:11px;color:rgba(255,255,255,0.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_family.familyName+'</div>' +
      '<select onchange="NBS_NAV._setPerson(this.value)" style="padding:4px 8px;font-size:12px;border:none;border-radius:99px;background:rgba(255,255,255,0.12);color:#fff;outline:none;cursor:pointer;font-family:inherit">'+opts+'</select>' +
      '<button onclick="NBS_NAV._print()" style="padding:5px 8px;background:rgba(255,255,255,0.12);border:none;border-radius:6px;color:rgba(255,255,255,0.8);font-size:13px;cursor:pointer">🖨️</button>';
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
  global.NBS_NAV._go    = function(href) { window.location.href = href; };
  global.NBS_NAV._print = function() { window.print(); };
  global.NBS_NAV._back     = function() { window.location.href = "main.html"; };
  global.NBS_NAV._goFamily  = function() { window.location.href = "family.html"; };

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
      ".nbs-disclaimer{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(120,140,255,.05);border:1px solid rgba(120,140,255,.10);font-size:10px;color:#9CA3AF;line-height:1.6;letter-spacing:.01em}",
      ".nbs-pbtn{width:100%;padding:8px;margin-bottom:5px;background:linear-gradient(90deg,rgba(59,130,246,.10),rgba(124,58,237,.10));color:#4F46E5;border:1px solid rgba(120,140,255,.18);border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px}",
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
      "@media print{#nbs-sidebar,#nbs-mobile-hdr,#nbs-bottom-tab{display:none!important}body{padding-left:0!important;padding-top:0!important;padding-bottom:0!important}}",
      ".nbs-logo{border-bottom:1px solid rgba(120,140,255,.12);padding:0;line-height:0;overflow:hidden}",
      ".nbs-logo-img{width:100%;height:auto;max-width:200px;display:block;object-fit:contain}"
    ].join("\n");
    document.head.appendChild(s);
  }

})(window);
