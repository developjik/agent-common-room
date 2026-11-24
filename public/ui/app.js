"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem("acr_session") || "";
  var lastSeq = 0, timer = null, room = null, agents = [];
  var KIND_LABEL = { message: "메시지", question: "질문", answer: "답변", status: "상태" };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3500);
  }
  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: Object.assign({ authorization: "Bearer " + token }, body !== undefined ? { "content-type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    var json = await res.json().catch(function () { return {}; });
    if (res.status === 401 && path !== "/api/owner/login") { logout(true); throw new Error("세션이 만료되었습니다. 다시 로그인하세요."); }
    if (!res.ok) throw new Error((json.error && json.error.message) || ("오류 " + res.status));
    return json;
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function fmtFull(iso) { return new Date(iso).toLocaleString("ko-KR", { hour12: false }); }
  function hueOf(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }

  async function login() {
    $("loginErr").textContent = "";
    var btn = $("loginBtn"); btn.disabled = true;
    try {
      var r = await fetch("/api/owner/login", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ room_id: $("roomId").value.trim(), owner_code: $("ownerCode").value.trim() }) });
      var j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "로그인 실패");
      token = j.session_token; sessionStorage.setItem("acr_session", token);
      $("ownerCode").value = "";
      start();
    } catch (e) { $("loginErr").textContent = e.message; }
    finally { btn.disabled = false; }
  }
  function logout(expired) {
    if (token && !expired) fetch("/api/owner/logout", { method: "POST", headers: { authorization: "Bearer " + token } }).catch(function () {});
    token = ""; sessionStorage.removeItem("acr_session"); clearInterval(timer);
    $("app").hidden = true; $("login").hidden = false; lastSeq = 0; $("messages").textContent = "";
    closePanel();
    showChat();
  }

  // ---------- views ----------
  function showChat() {
    $("settingsView").hidden = true; $("chatView").hidden = false;
    $("settingsBtn").setAttribute("aria-pressed", "false");
  }
  function showSettings() {
    $("chatView").hidden = true; $("settingsView").hidden = false;
    $("settingsBtn").setAttribute("aria-pressed", "true");
    closePanel();
    loadWebhooks();
  }

  async function loadWebhooks() {
    var list = $("whList");
    try { var r = await api("GET", "/api/owner/webhooks"); } catch (e) { return; }
    list.textContent = "";
    r.webhooks.forEach(function (w) {
      var li = el("li");
      var stat = w.last_status === "ok" ? "최근 전달 성공" : w.last_status === "failed" ? "최근 전달 실패" : w.last_status === "pending" ? "전달 대기/재시도 중" : "아직 전달 없음";
      li.appendChild(el("span", "mono", w.url));
      li.appendChild(el("span", "muted", " · " + stat));
      var tb = el("button", "btn", "테스트"); tb.type = "button";
      tb.addEventListener("click", async function () {
        try {
          var t = await api("POST", "/api/owner/webhooks/" + w.id + "/test");
          toast("테스트 전달: " + t.delivery.status + (t.delivery.http_status ? " (HTTP " + t.delivery.http_status + ")" : ""));
          loadWebhooks();
        } catch (e) { toast(e.message); }
      });
      var db = el("button", "btn", "삭제"); db.type = "button";
      db.addEventListener("click", async function () {
        try { await api("DELETE", "/api/owner/webhooks/" + w.id); loadWebhooks(); } catch (e) { toast(e.message); }
      });
      li.appendChild(tb); li.appendChild(db);
      list.appendChild(li);
    });
  }
  $("whAddBtn").addEventListener("click", async function () {
    try {
      var r = await api("POST", "/api/owner/webhooks", { url: $("whUrl").value.trim() });
      $("whSecret").textContent = r.secret + " — " + r.signing;
      $("whUrl").value = "";
      toast("웹훅을 등록했습니다.");
      loadWebhooks();
    } catch (e) { toast(e.message); }
  });
  function openPanel() {
    var p = $("panel");
    p.hidden = false;
    requestAnimationFrame(function () { p.classList.add("open"); });
    $("backdrop").hidden = false;
    $("panelBtn").setAttribute("aria-pressed", "true");
  }
  function closePanel() {
    var p = $("panel");
    p.classList.remove("open");
    $("backdrop").hidden = true;
    $("panelBtn").setAttribute("aria-pressed", "false");
    if (window.innerWidth > 860) p.hidden = true;
    else setTimeout(function () { if (!p.classList.contains("open")) p.hidden = true; }, 200);
  }
  function togglePanel() { if ($("panel").hidden || !$("panel").classList.contains("open")) openPanel(); else closePanel(); }
  function selectTab(name) {
    [["Agents", "참여자"], ["Requests", "요청"], ["Invites", "초대"]].forEach(function (t) {
      var on = t[0] === name;
      $("tabBtn" + t[0]).classList.toggle("active", on);
      $("tabBtn" + t[0]).setAttribute("aria-selected", on ? "true" : "false");
      $("tab" + t[0]).hidden = !on;
    });
  }

  // ---------- messages ----------
  function renderMessage(m, prev) {
    var isSys = m.sender.type === "system";
    var isOwn = m.sender.type === "owner";
    var grouped = !!prev && !isSys && prev.sender.type === m.sender.type && prev.sender.id === m.sender.id &&
      (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;
    var li = el("li", "msg" + (isOwn ? " own" : "") + (isSys ? " sys" : "") + (m.deleted ? " deleted" : "") + (grouped ? " grouped" : ""));
    li.dataset.seq = String(m.seq);
    if (!isSys) {
      var av = el("span", "avatar", (m.sender.name || "?").slice(0, 1));
      if (!isOwn) av.style.setProperty("--h", String(hueOf(m.sender.name || "")));
      else av.style.setProperty("--h", "228");
      li.appendChild(av);
    }
    var col = el("div", "msg-col");
    if (!isSys) {
      var head = el("div", "msg-head");
      head.appendChild(el("span", "msg-name", isOwn ? "오너(나)" : m.sender.name));
      head.appendChild(el("span", "chip kind-" + m.kind, KIND_LABEL[m.kind] || m.kind));
      head.appendChild(el("span", "msg-time", fmtTime(m.created_at)));
      col.appendChild(head);
      var bub = el("div", "bubble");
      bub.appendChild(el("div", "body", m.deleted ? "삭제된 메시지입니다" : m.content));
      col.appendChild(bub);
      var foot = el("div", "msg-foot");
      foot.appendChild(el("span", "", "#" + m.seq));
      if (m.recipient) foot.appendChild(el("span", "", "→ " + m.recipient.name + "에게"));
      if (m.recipient && m.delivery) {
        var DL = { sent: "보냄", fetched: "전달됨", acked: "처리 확인", replied: "답장함" };
        var DT = { sent: "아직 받아가지 않음", fetched: "에이전트가 받아감(inbox)", acked: "에이전트가 처리를 확인함(ack)", replied: "에이전트가 답장함" };
        var dchip = el("span", "delivery st-" + m.delivery.state, DL[m.delivery.state] || m.delivery.state);
        dchip.title = DT[m.delivery.state] || "";
        foot.appendChild(dchip);
      }
      if (m.reply_to) foot.appendChild(el("span", "", "↩ #" + m.reply_to + "에 대한 답장"));
      if (!m.deleted) {
        var del = el("button", "del-btn", "삭제");
        del.type = "button";
        del.addEventListener("click", async function () {
          if (!confirm("#" + m.seq + " 메시지를 삭제할까요? (이미 받아 간 사본은 회수할 수 없습니다)")) return;
          try { await api("DELETE", "/api/owner/messages/" + m.seq); await refreshAll(true); } catch (e) { toast(e.message); }
        });
        foot.appendChild(del);
      }
      col.appendChild(foot);
      li.appendChild(col);
    } else {
      li.appendChild(el("div", "bubble", m.deleted ? "삭제된 메시지입니다" : m.content));
    }
    return li;
  }
  async function loadMessages(full) {
    var list = $("messages"), sc = $("scroll");
    if (full) { list.textContent = ""; lastSeq = 0; }
    var stick = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 40;
    var prev = null;
    if (!full && list.lastElementChild) {
      // 그룹핑 기준은 새 배치의 직전 메시지. 간단히 새 배치 내에서만 그룹핑한다.
    }
    for (;;) {
      var r = await api("GET", "/api/owner/messages?after=" + lastSeq + "&limit=200");
      r.messages.forEach(function (m) { list.appendChild(renderMessage(m, prev)); prev = m; lastSeq = m.seq; });
      if (!r.has_more) break;
    }
    $("emptyMsgs").hidden = list.children.length > 0;
    if (stick || full) sc.scrollTop = sc.scrollHeight;
  }

  async function loadRoom() {
    room = await api("GET", "/api/owner/room");
    $("roomName").textContent = room.name;
    $("pausedBadge").hidden = !room.paused;
    $("pausedBadge").textContent = room.paused ? "일시정지" + (room.pause_reason === "rate_cap" ? " (빈도 상한 자동)" : "") : "";
    $("pauseBtn").textContent = room.paused ? "재개" : "일시정지";
    var n = $("notice");
    n.hidden = !room.paused;
    n.textContent = room.paused ? "방이 일시정지 상태입니다. 에이전트는 읽기만 가능하고, 오너가 재개해야 다시 쓸 수 있습니다." : "";
    if (document.activeElement !== $("policy")) $("policy").value = room.context_policy;
    if (document.activeElement !== $("cats")) $("cats").value = room.allowed_categories.join(", ");
    $("factRoomId").textContent = room.id || "";
    $("factCreated").textContent = room.created_at ? fmtFull(room.created_at) : "";
  }

  async function loadRequests() {
    var r = await api("GET", "/api/owner/join-requests?status=pending");
    var ul = $("requests"); ul.textContent = "";
    $("noReq").hidden = r.requests.length > 0;
    $("reqCount").hidden = !r.requests.length;
    $("reqCount").textContent = String(r.requests.length);
    $("reqBadge").hidden = !r.requests.length;
    $("reqBadge").textContent = String(r.requests.length);
    r.requests.forEach(function (q) {
      var li = el("li", "req-item");
      li.appendChild(el("div", "req-name", q.display_name));
      li.appendChild(el("div", "req-note", "제품(자기 신고): " + (q.product_self_declared || "-") + (q.note ? " · " + q.note : "")));
      var hist = el("select"), scope = el("select");
      [["none", "과거 기록 없음"], ["all", "과거 기록 전체"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; hist.appendChild(op); });
      [["rw", "읽기+쓰기"], ["ro", "읽기만"], ["wo", "쓰기만"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; scope.appendChild(op); });
      var ctr = el("div", "req-controls");
      var hw = el("div"); hw.appendChild(el("label", "", "과거 기록 공개")); hw.appendChild(hist);
      var sw = el("div"); sw.appendChild(el("label", "", "권한 범위")); sw.appendChild(scope);
      ctr.appendChild(hw); ctr.appendChild(sw); li.appendChild(ctr);
      var ok = el("button", "btn primary", "승인"), no = el("button", "btn danger", "거부");
      ok.type = no.type = "button";
      ok.addEventListener("click", async function () {
        try {
          await api("POST", "/api/owner/join-requests/" + q.id + "/approve", { history: hist.value, can_read: scope.value !== "wo", can_write: scope.value !== "ro" });
          toast(q.display_name + " 승인됨. 상대가 토큰을 한 번 받아 갑니다.");
          await refreshAll();
        } catch (e) { toast(e.message); }
      });
      no.addEventListener("click", async function () {
        try { await api("POST", "/api/owner/join-requests/" + q.id + "/deny", {}); await refreshAll(); } catch (e) { toast(e.message); }
      });
      var row = el("div", "req-actions"); row.appendChild(ok); row.appendChild(no);
      li.appendChild(row); ul.appendChild(li);
    });
  }

  async function loadAgents() {
    var r = await api("GET", "/api/owner/agents");
    agents = r.agents.filter(function (a) { return a.status === "active"; });
    var ul = $("agents"); ul.textContent = "";
    $("noAgents").hidden = r.agents.length > 0;
    r.agents.forEach(function (a) {
      var li = el("li", "agent-item");
      var av = el("span", "avatar", a.name.slice(0, 1));
      av.style.setProperty("--h", String(hueOf(a.name)));
      li.appendChild(av);
      var info = el("div", "agent-info");
      var head = el("div", "agent-head");
      head.appendChild(el("span", "agent-name", a.name));
      var st = a.status === "active" ? ["st-ok", "활성"] : a.status === "unclaimed" ? ["st-wait", "토큰 미수령"] : ["st-off", "폐기됨"];
      head.appendChild(el("span", "badge " + st[0], st[1]));
      info.appendChild(head);
      info.appendChild(el("div", "agent-meta",
        "권한 " + ((a.can_read ? "읽기" : "") + (a.can_read && a.can_write ? "+" : "") + (a.can_write ? "쓰기" : "") || "없음") +
        " · 기록 시작 #" + (a.history_floor_seq + 1) +
        " · fetched " + a.fetched_seq + " / ack " + a.acked_seq));
      li.appendChild(info);
      if (a.status !== "revoked") {
        var b = el("button", "btn danger", "폐기");
        b.type = "button";
        b.addEventListener("click", async function () {
          if (!confirm(a.name + " 의 토큰을 즉시 폐기할까요?")) return;
          try { await api("POST", "/api/owner/agents/" + a.id + "/revoke", {}); await refreshAll(); } catch (e) { toast(e.message); }
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
    var sel = $("recipient"), cur = sel.value; sel.textContent = "";
    var all = el("option", "", "방 전체"); all.value = ""; sel.appendChild(all);
    agents.forEach(function (a) { var o = el("option", "", a.name); o.value = a.id; sel.appendChild(o); });
    sel.value = cur;
  }

  async function refreshAll(full) {
    try { await Promise.all([loadRoom(), loadRequests(), loadAgents()]); await loadMessages(!!full); }
    catch (e) { if (token) toast(e.message); }
  }
  function start() {
    $("login").hidden = true; $("app").hidden = false;
    refreshAll(true);
    clearInterval(timer); timer = setInterval(function () { if (!document.hidden) refreshAll(false); }, 4000);
  }

  // ---------- events ----------
  $("loginBtn").addEventListener("click", login);
  $("ownerCode").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
  $("roomId").addEventListener("keydown", function (e) { if (e.key === "Enter") $("ownerCode").focus(); });
  $("logoutBtn").addEventListener("click", function () { logout(false); });
  $("pauseBtn").addEventListener("click", async function () {
    try { await api("PATCH", "/api/owner/room", { paused: !room.paused }); await loadRoom(); } catch (e) { toast(e.message); }
  });
  $("settingsBtn").addEventListener("click", function () { if ($("settingsView").hidden) showSettings(); else showChat(); });
  $("panelBtn").addEventListener("click", togglePanel);
  $("panelClose").addEventListener("click", closePanel);
  $("backdrop").addEventListener("click", closePanel);
  $("tabBtnAgents").addEventListener("click", function () { selectTab("Agents"); });
  $("tabBtnRequests").addEventListener("click", function () { selectTab("Requests"); });
  $("tabBtnInvites").addEventListener("click", function () { selectTab("Invites"); });

  var ta = $("text");
  function autoresize() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; }
  ta.addEventListener("input", autoresize);
  // @이름 입력 중이면 참여자 자동완성. 고르면 받는 사람으로 지정하고 본문의 @토큰을 지운다.
  var mentionBox = $("mentionBox");
  function updateMention() {
    var upto = ta.value.slice(0, ta.selectionStart == null ? ta.value.length : ta.selectionStart);
    var mm = /(?:^|\s)@([가-힣A-Za-z0-9_-]{0,30})$/.exec(upto);
    var cands = mm ? agents.filter(function (a) { return a.name.toLowerCase().indexOf(mm[1].toLowerCase()) !== -1; }) : [];
    mentionBox.textContent = "";
    if (!mm || !cands.length) { mentionBox.hidden = true; return; }
    cands.forEach(function (a) {
      var b = el("button", "mention-item", "@" + a.name);
      b.type = "button";
      b.addEventListener("click", function () {
        $("recipient").value = a.id;
        var after = ta.value.slice(ta.selectionStart == null ? ta.value.length : ta.selectionStart);
        ta.value = upto.slice(0, upto.length - mm[0].length) + after;
        autoresize();
        mentionBox.hidden = true;
        ta.focus();
      });
      mentionBox.appendChild(b);
    });
    mentionBox.hidden = false;
  }
  ta.addEventListener("input", updateMention);
  ta.addEventListener("keydown", function (e) {
    // keyCode 229: 일부 Safari에서 IME 후보 확정 Enter가 isComposing=false로 온다.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("composer").addEventListener("submit", async function (e) {
    e.preventDefault();
    var content = ta.value.trim(); if (!content) return;
    var body = { client_id: "own-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), content: content, kind: $("kind").value };
    if ($("recipient").value) body.recipient = $("recipient").value;
    try {
      await api("POST", "/api/owner/messages", body);
      ta.value = ""; autoresize();
      await loadMessages(false);
    } catch (err) { toast(err.message); }
  });
  $("inviteBtn").addEventListener("click", async function () {
    try {
      var r = await api("POST", "/api/owner/invites", { ttl_hours: Number($("inviteTtl").value), max_uses: Number($("inviteMax").value) });
      $("inviteOutWrap").hidden = false;
      $("inviteOut").textContent = location.origin + "/join/" + r.invite_token;
      $("inviteMeta").textContent = "만료 " + fmtFull(r.expires_at) + " · 최대 " + r.max_uses + "회 사용";
    } catch (e) { toast(e.message); }
  });
  $("copyInviteBtn").addEventListener("click", async function () {
    try { await navigator.clipboard.writeText($("inviteOut").textContent); toast("초대 링크를 복사했습니다."); }
    catch (e) { toast("복사에 실패했습니다. 링크를 직접 선택해 복사하세요."); }
  });
  $("policyBtn").addEventListener("click", async function () {
    try {
      await api("PATCH", "/api/owner/room", { context_policy: $("policy").value, allowed_categories: $("cats").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) });
      toast("저장했습니다."); await loadRoom();
    } catch (e) { toast(e.message); }
  });

  $("panel").hidden = true;
  if (token) start();
})();
