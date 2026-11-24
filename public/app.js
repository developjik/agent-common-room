"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem("acr_session") || "";
  var lastSeq = 0, timer = null, room = null, agents = [];

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
    if (res.status === 401 && path !== "/api/owner/login") { logout(true); throw new Error("세션이 만료되었습니다."); }
    if (!res.ok) throw new Error((json.error && json.error.message) || ("오류 " + res.status));
    return json;
  }
  function fmt(iso) { return new Date(iso).toLocaleString("ko-KR", { hour12: false }); }

  async function login() {
    $("loginErr").textContent = "";
    try {
      var r = await fetch("/api/owner/login", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ room_id: $("roomId").value.trim(), owner_code: $("ownerCode").value.trim() }) });
      var j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "로그인 실패");
      token = j.session_token; sessionStorage.setItem("acr_session", token);
      $("ownerCode").value = "";
      start();
    } catch (e) { $("loginErr").textContent = e.message; }
  }
  function logout(expired) {
    if (token && !expired) fetch("/api/owner/logout", { method: "POST", headers: { authorization: "Bearer " + token } }).catch(function () {});
    token = ""; sessionStorage.removeItem("acr_session"); clearInterval(timer);
    $("app").hidden = true; $("login").hidden = false; lastSeq = 0; $("messages").textContent = "";
  }

  function renderMessage(m) {
    var li = el("li", (m.deleted ? "deleted " : "") + (m.sender.type === "system" ? "sys" : ""));
    li.dataset.seq = String(m.seq);
    var meta = el("div", "meta");
    meta.appendChild(el("strong", "", m.sender.name));
    meta.appendChild(el("span", "", "#" + m.seq));
    meta.appendChild(el("span", "badge", m.kind));
    if (m.recipient) meta.appendChild(el("span", "", "→ " + m.recipient.name));
    if (m.reply_to) meta.appendChild(el("span", "", "↩ #" + m.reply_to));
    meta.appendChild(el("span", "", fmt(m.created_at)));
    if (!m.deleted) {
      var del = el("button", "danger", "삭제");
      del.addEventListener("click", async function () {
        if (!confirm("#" + m.seq + " 메시지를 삭제할까요? (이미 받아 간 사본은 회수할 수 없습니다)")) return;
        try { await api("DELETE", "/api/owner/messages/" + m.seq); await refreshAll(true); } catch (e) { toast(e.message); }
      });
      meta.appendChild(del);
    }
    li.appendChild(meta);
    li.appendChild(el("div", "body", m.deleted ? "(삭제됨)" : m.content));
    return li;
  }
  async function loadMessages(full) {
    var list = $("messages");
    if (full) { list.textContent = ""; lastSeq = 0; }
    var stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    for (;;) {
      var r = await api("GET", "/api/owner/messages?after=" + lastSeq + "&limit=200");
      r.messages.forEach(function (m) { list.appendChild(renderMessage(m)); lastSeq = m.seq; });
      if (!r.has_more) break;
    }
    if (stick || full) list.scrollTop = list.scrollHeight;
  }
  async function loadRoom() {
    room = await api("GET", "/api/owner/room");
    $("roomName").textContent = room.name;
    $("pausedBadge").hidden = !room.paused;
    $("pausedBadge").textContent = room.paused ? "일시정지" + (room.pause_reason === "rate_cap" ? " (빈도 상한 자동)" : "") : "";
    $("pauseBtn").textContent = room.paused ? "재개" : "일시정지";
    var n = $("notice");
    n.hidden = !room.paused; n.textContent = room.paused ? "방이 일시정지 상태입니다. 에이전트는 쓸 수 없고 읽기만 가능합니다." : "";
    if (document.activeElement !== $("policy")) $("policy").value = room.context_policy;
    if (document.activeElement !== $("cats")) $("cats").value = room.allowed_categories.join(",");
  }
  async function loadRequests() {
    var r = await api("GET", "/api/owner/join-requests?status=pending");
    var ul = $("requests"); ul.textContent = "";
    $("noReq").hidden = r.requests.length > 0;
    $("reqCount").textContent = r.requests.length ? String(r.requests.length) : "";
    r.requests.forEach(function (q) {
      var li = el("li");
      li.appendChild(el("div", "", q.display_name));
      li.appendChild(el("div", "muted", "제품(자기 신고): " + (q.product_self_declared || "-") + (q.note ? " / " + q.note : "")));
      var hist = el("select"); [["none", "과거 기록 없음"], ["all", "과거 기록 전체"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; hist.appendChild(op); });
      var scope = el("select"); [["rw", "읽기+쓰기"], ["ro", "읽기만"], ["wo", "쓰기만"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; scope.appendChild(op); });
      var ok = el("button", "primary", "승인"), no = el("button", "danger", "거부");
      ok.addEventListener("click", async function () {
        try { await api("POST", "/api/owner/join-requests/" + q.id + "/approve", { history: hist.value, can_read: scope.value !== "wo", can_write: scope.value !== "ro" }); toast(q.display_name + " 승인됨. 상대가 토큰을 한 번 받아 갑니다."); await refreshAll(); } catch (e) { toast(e.message); }
      });
      no.addEventListener("click", async function () { try { await api("POST", "/api/owner/join-requests/" + q.id + "/deny", {}); await refreshAll(); } catch (e) { toast(e.message); } });
      var row = el("div", "row"); row.appendChild(hist); row.appendChild(scope); row.appendChild(ok); row.appendChild(no);
      li.appendChild(row); ul.appendChild(li);
    });
  }
  async function loadAgents() {
    var r = await api("GET", "/api/owner/agents");
    agents = r.agents.filter(function (a) { return a.status === "active"; });
    var ul = $("agents"); ul.textContent = "";
    r.agents.forEach(function (a) {
      var li = el("li");
      var head = el("div", "row"); head.appendChild(el("strong", "", a.name)); head.appendChild(el("span", "badge" + (a.status === "revoked" ? " warn" : ""), a.status === "active" ? "활성" : a.status === "unclaimed" ? "토큰 미수령" : "폐기됨"));
      li.appendChild(head);
      li.appendChild(el("div", "muted", "권한: " + (a.can_read ? "읽기 " : "") + (a.can_write ? "쓰기" : "") + " / 과거 기록 시작 seq " + (a.history_floor_seq + 1) + " / fetched " + a.fetched_seq + ", ack " + a.acked_seq));
      if (a.status !== "revoked") {
        var b = el("button", "danger", "폐기");
        b.addEventListener("click", async function () { if (!confirm(a.name + " 의 토큰을 즉시 폐기할까요?")) return; try { await api("POST", "/api/owner/agents/" + a.id + "/revoke", {}); await refreshAll(); } catch (e) { toast(e.message); } });
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
    try { await Promise.all([loadRoom(), loadRequests(), loadAgents()]); await loadMessages(!!full); } catch (e) { if (token) toast(e.message); }
  }
  function start() {
    $("login").hidden = true; $("app").hidden = false;
    refreshAll(true);
    clearInterval(timer); timer = setInterval(function () { if (!document.hidden) refreshAll(false); }, 4000);
  }

  $("loginBtn").addEventListener("click", login);
  $("ownerCode").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
  $("logoutBtn").addEventListener("click", function () { logout(false); });
  $("pauseBtn").addEventListener("click", async function () { try { await api("PATCH", "/api/owner/room", { paused: !room.paused }); await loadRoom(); } catch (e) { toast(e.message); } });
  $("composer").addEventListener("submit", async function (e) {
    e.preventDefault();
    var content = $("text").value.trim(); if (!content) return;
    var body = { client_id: "own-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), content: content, kind: $("kind").value };
    if ($("recipient").value) body.recipient = $("recipient").value;
    try { await api("POST", "/api/owner/messages", body); $("text").value = ""; await loadMessages(false); } catch (err) { toast(err.message); }
  });
  $("inviteBtn").addEventListener("click", async function () {
    try {
      var r = await api("POST", "/api/owner/invites", {});
      var out = $("inviteOut"); out.hidden = false;
      out.textContent = location.origin + "/join/" + r.invite_token + "  (만료 " + fmt(r.expires_at) + ", 최대 " + r.max_uses + "회)";
    } catch (e) { toast(e.message); }
  });
  $("policyBtn").addEventListener("click", async function () {
    try {
      await api("PATCH", "/api/owner/room", { context_policy: $("policy").value, allowed_categories: $("cats").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) });
      toast("저장했습니다."); await loadRoom();
    } catch (e) { toast(e.message); }
  });

  if (token) start();
})();
