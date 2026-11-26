"use strict";
// 공통 룸 오너 UI.
// 원칙: (1) 한 화면에서 판단한다 (2) 서버가 아는 것만 말한다 (3) 모든 정지에는 이유와 다음 버튼
//       (4) 초대는 링크가 아니라 전달물 (5) 작은 화면은 하나씩, 큰 화면은 함께.
// 불변식: 화면 텍스트는 textContent로만 쓴다(innerHTML 금지), 아이콘은 인라인 SVG(외부 CDN·data URI 금지).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var SVGNS = "http://www.w3.org/2000/svg";
  var token = sessionStorage.getItem("acr_session") || "";
  var KIND_LABEL = { message: "메시지", question: "질문", answer: "답변", status: "상태" };
  var DL = { sent: ["보냄", "보냄 · 아직 받지 않음"], fetched: ["받아감", "에이전트가 받아갔습니다(inbox)"], acked: ["확인함", "에이전트가 처리를 확인했습니다(ack)"], replied: ["답장함", "에이전트가 답장했습니다"] };

  var room = null, agents = [], requests = [], invites = [];
  var lastSeq = 0, prevForGroup = null, lastMsg = null, lastChatMsg = null;
  var msgIndex = {}, msgEls = {}, agentTimes = [];
  var replyTo = null, railOpen = false, pollTimer = null, quietPolls = 0, lastFocus = null, pollTicks = 0;
  var dialogResolve = null, dialogFocus = null;
  var mention = { items: [], index: 0 };

  // ---------- 작은 도구들 ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var ICONS = {
    copy: [["rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]],
    reply: [["path", { d: "M9 14L4 9l5-5" }], ["path", { d: "M4 9h10a6 6 0 0 1 6 6v4" }]],
    trash: [["path", { d: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" }]],
    hash: [["path", { d: "M10 3L8 21M16 3l-2 18M4 9h16M3 15h16" }]],
    clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7v5l3 2" }]],
    check: [["path", { d: "M20 6L9 17l-5-5" }]],
    link: [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }], ["path", { d: "M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" }]],
    alert: [["path", { d: "M12 3l9 17H3z" }], ["path", { d: "M12 10v4M12 17h.01" }]],
    chain: [["path", { d: "M9 15l6-6" }], ["path", { d: "M11 6l1-1a4 4 0 0 1 6 6l-1 1" }], ["path", { d: "M13 18l-1 1a4 4 0 0 1-6-6l1-1" }]]
  };
  function icon(name) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "ico");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    (ICONS[name] || []).forEach(function (part) {
      var node = document.createElementNS(SVGNS, part[0]);
      Object.keys(part[1]).forEach(function (k) { node.setAttribute(k, String(part[1][k])); });
      svg.appendChild(node);
    });
    return svg;
  }
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.hidden = true; }, 4000);
  }
  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
    } catch (e) { /* 클립보드 API는 https(또는 localhost)에서만 동작한다. 아래 폴백. */ }
    var ta2 = document.createElement("textarea");
    ta2.value = text;
    ta2.setAttribute("readonly", "readonly");
    ta2.style.position = "fixed";
    ta2.style.opacity = "0";
    document.body.appendChild(ta2);
    ta2.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta2);
    toast(ok ? okMsg : "복사에 실패했습니다. 값을 직접 선택해 복사하세요.");
    return ok;
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
    return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function fmtFull(iso) { return new Date(iso).toLocaleString("ko-KR", { hour12: false }); }
  function hueOf(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }
  /** 상대시간: 방금 전 / N분 전 / N시간 전 / 어제 HH:MM / M월 D일 (7일 뒤 연도까지). */
  function relTime(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime(), now = Date.now(), d = Math.max(0, now - t);
    if (d < 45e3) return "방금 전";
    if (d < 3600e3) return Math.floor(d / 60e3) + "분 전";
    if (d < 86400e3) return Math.floor(d / 3600e3) + "시간 전";
    var day = new Date(t), today = new Date(now);
    var yday = new Date(now - 86400e3);
    if (day.getDate() === yday.getDate() && day.getMonth() === yday.getMonth()) return "어제 " + fmtTime(iso);
    if (day.getFullYear() === today.getFullYear()) return (day.getMonth() + 1) + "월 " + day.getDate() + "일";
    return day.getFullYear() + "년 " + (day.getMonth() + 1) + "월 " + day.getDate() + "일";
  }
  function agentById(id) {
    for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i];
    return null;
  }
  function productOf(id) {
    var a = agentById(id);
    return a && a.product_self_declared ? a.product_self_declared : "";
  }
  function isDesktop() { return window.innerWidth >= 1080; }
  function windowMin() { return room ? Math.max(1, Math.round(room.rate_limit.window_seconds / 60)) : 10; }

  // ---------- 대화상자(확인 시트) ----------
  function focusables(scope) {
    return Array.prototype.slice.call(scope.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
      .filter(function (n) { return !n.disabled && !n.hidden && !n.closest("[hidden]"); });
  }
  function focusFirst(scope) {
    var f = focusables(scope);
    if (f.length) { try { f[0].focus(); } catch (e) {} }
  }
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      dialogResolve = resolve;
      dialogFocus = document.activeElement;
      $("dlgTitle").textContent = opts.title || "확인";
      $("dlgText").textContent = opts.text || "";
      $("dlgOk").textContent = opts.ok || "확인";
      $("dlgOk").className = "btn " + (opts.danger ? "danger" : "primary");
      $("dialog").hidden = false;
      try { $("dlgOk").focus(); } catch (e) {}
    });
  }
  function closeDialog(answer) {
    if (!dialogResolve) return;
    var resolve = dialogResolve;
    dialogResolve = null;
    $("dialog").hidden = true;
    if (dialogFocus && dialogFocus.focus) { try { dialogFocus.focus(); } catch (e) {} }
    dialogFocus = null;
    resolve(!!answer);
  }

  // ---------- 로그인/세션 ----------
  async function login() {
    $("loginErr").textContent = "";
    var btn = $("loginBtn");
    btn.disabled = true;
    try {
      var r = await fetch("/api/owner/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room_id: $("roomId").value.trim(), owner_code: $("ownerCode").value.trim() }),
      });
      var j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "로그인 실패");
      token = j.session_token;
      sessionStorage.setItem("acr_session", token);
      $("ownerCode").value = "";
      start();
    } catch (e) { $("loginErr").textContent = e.message; }
    finally { btn.disabled = false; }
  }
  function resetState() {
    lastSeq = 0; quietPolls = 0; room = null; agents = []; requests = []; invites = [];
    lastMsg = null; prevForGroup = null; msgIndex = {}; msgEls = {}; agentTimes = []; lastChatMsg = null;
    replyTo = null;
    $("messages").textContent = "";
    $("agents").textContent = "";
    $("requests").textContent = "";
    $("invites").textContent = "";
    $("inviteOutWrap").hidden = true;
    $("recipient").textContent = "";
    var all = el("option", "", "방 전체"); all.value = ""; $("recipient").appendChild(all);
    syncRecipient();
    showReplyChip(null);
    closeMention();
  }
  function logout(expired) {
    if (token && !expired) fetch("/api/owner/logout", { method: "POST", headers: { authorization: "Bearer " + token } }).catch(function () {});
    token = "";
    sessionStorage.removeItem("acr_session");
    clearTimeout(pollTimer);
    setRail(false);
    resetState();
    $("app").hidden = true;
    $("login").hidden = false;
    showChat();
  }

  // ---------- 화면 전환 ----------
  function showChat() {
    $("settingsView").hidden = true;
    $("chatView").hidden = false;
    $("settingsBtn").setAttribute("aria-pressed", "false");
  }
  function showSettings() {
    $("chatView").hidden = true;
    $("settingsView").hidden = false;
    $("settingsBtn").setAttribute("aria-pressed", "true");
    setRail(false);
  }

  // ---------- 우측 관리 레일(데스크톱 고정 / 모바일 시트) ----------
  function setRail(open) {
    var p = $("panel"), mobile = !isDesktop();
    railOpen = open;
    p.classList.toggle("open", open);
    p.hidden = !open;
    $("backdrop").hidden = !(mobile && open);
    $("panelBtn").setAttribute("aria-pressed", open ? "true" : "false");
    if (mobile) {
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-modal", open ? "true" : "false");
    } else {
      p.removeAttribute("role");
      p.removeAttribute("aria-modal");
    }
    if (mobile && open) {
      lastFocus = document.activeElement;
      focusFirst(p);
    } else if (mobile && !open && lastFocus) {
      var back = lastFocus;
      lastFocus = null;
      if (back && back.focus) { try { back.focus(); } catch (e) {} }
    }
  }
  function toggleRail() { setRail(!railOpen); }

  // ---------- 방 상태 ----------
  function stateOf() {
    if (!room) return { key: "ok", label: "안정" };
    if (room.paused) return { key: "paused", label: "정지" };
    var pending = requests.length;
    var unclaimed = agents.filter(function (a) { return a.status === "unclaimed"; }).length;
    if (pending || unclaimed) return { key: "warn", label: "주의" };
    return { key: "ok", label: "안정" };
  }
  function rateCount() {
    if (!room) return 0;
    var since = Date.now() - room.rate_limit.window_seconds * 1000, n = 0;
    for (var i = 0; i < agentTimes.length; i++) if (agentTimes[i] >= since) n++;
    return n;
  }
  function depthNow() { return lastChatMsg && Number(lastChatMsg.depth) > 0 ? Number(lastChatMsg.depth) : 0; }

  function renderRoom() {
    if (!room) return;
    $("roomName").textContent = room.name;
    var st = stateOf();
    var chip = $("roomState");
    chip.textContent = st.label;
    chip.className = "badge " + (st.key === "ok" ? "st-ok" : st.key === "warn" ? "st-warn" : "st-warn");
    $("roomDot").setAttribute("data-state", st.key);
    $("pauseLabel").textContent = room.paused ? "재개" : "일시정지";
    $("pauseIcon").hidden = !!room.paused;
    $("resumeIcon").hidden = !room.paused;
    $("pauseBtn").setAttribute("aria-label", room.paused ? "일시정지 해제(재개)" : "일시정지");
    $("notice").hidden = true;
    renderBanner();
    renderMeters();
    if (document.activeElement !== $("policy")) $("policy").value = room.context_policy;
    if (document.activeElement !== $("cats")) $("cats").value = room.allowed_categories.join(", ");
    $("factRoomId").textContent = room.id || "";
    $("factCreated").textContent = room.created_at ? fmtFull(room.created_at) : "";
  }

  /** 일시정지 배너: 사유 · 주체 · 시각 · 수치 + 인라인 재개. */
  function renderBanner() {
    var b = $("banner");
    if (!room || !room.paused) { b.hidden = true; return; }
    var info = room.pause_info || {};
    var when = info.at ? fmtTime(info.at) + " · " : "";
    var limit = room.rate_limit.count, count = rateCount();
    if (room.pause_reason === "rate_cap") {
      var who = info.actor_id ? agentById(info.actor_id) : null;
      $("bannerTitle").textContent = "자동 정지 · " + when + "빈도 상한";
      $("bannerText").textContent = "최근 " + windowMin() + "분에 에이전트 메시지가 상한(" + limit + "개)에 닿았습니다" +
        (who ? " · 마지막 발신 " + who.name : "") + " · 지금 " + count + "/" + limit + ". 일시정지 중에도 내 메시지는 전달됩니다.";
    } else {
      $("bannerTitle").textContent = "일시정지 · " + when + "내가 정지함";
      $("bannerText").textContent = "에이전트는 읽기만 할 수 있습니다. 재개하면 다시 말할 수 있습니다. 일시정지 중에도 내 메시지는 전달됩니다.";
    }
    b.hidden = false;
  }

  /** 흐름 미터: 답장 체인 N/최대, 최근 창의 에이전트 메시지 N/상한 (숫자+문장, 색만 의존 금지). */
  function renderMeters() {
    if (!room) return;
    var max = Number(room.max_chain_depth) || 6, d = depthNow();
    var cm = $("chainMeter");
    cm.textContent = "답장 체인 " + d + "/" + max;
    cm.className = "meter" + (d >= max ? " hit" : d >= Math.ceil(max * 0.8) ? " warn" : "");
    $("chainRestartBtn").hidden = d < max;
    var limit = room.rate_limit.count, c = rateCount();
    var rm = $("rateMeter");
    rm.textContent = "최근 " + windowMin() + "분 " + c + "/" + limit;
    rm.className = "meter" + (c >= limit ? " hit" : c >= Math.ceil(limit * 0.8) ? " warn" : "");
  }

  // ---------- 메시지 ----------
  function indexMessage(m) {
    msgIndex[m.seq] = m;
    if (m.sender.type === "agent") agentTimes.push(new Date(m.created_at).getTime());
    if (!lastMsg || m.seq > lastMsg.seq) lastMsg = m;
    // 시스템 안내(자동 정지·루프 차단)는 체인 계산에서 제외한다: 답장 체인의 깊이는 마지막 '대화' 메시지의 것이다.
    if (m.sender.type !== "system" && (!lastChatMsg || m.seq > lastChatMsg.seq)) lastChatMsg = m;
  }
  function isLoopNotice(text) { return typeof text === "string" && text.indexOf("답장 체인이 최대 깊이") === 0; }

  function quoteButton(seq) {
    var target = msgIndex[seq];
    var btn = el("button", "quote");
    btn.type = "button";
    if (target) {
      btn.setAttribute("aria-label", "원문 #" + seq + "로 이동");
      btn.appendChild(el("span", "quote-name", (target.sender.type === "owner" ? "오너(나)" : target.sender.name) + " "));
      var text = target.deleted ? "삭제된 메시지" : String(target.content || "").replace(/\s+/g, " ").slice(0, 60);
      btn.appendChild(el("span", "", "「" + text + (String(target.content || "").length > 60 ? "…" : "") + "」"));
      btn.addEventListener("click", function () { jumpTo(seq); });
    } else {
      btn.setAttribute("aria-label", "원문 #" + seq + "를 불러오지 못했습니다");
      btn.appendChild(el("span", "quote-name", "#" + seq + " "));
      btn.appendChild(el("span", "", "원문을 불러오지 못했습니다"));
    }
    return btn;
  }
  function jumpTo(seq) {
    var node = msgEls[seq];
    if (!node) { toast("#" + seq + " 메시지를 아직 불러오지 못했습니다."); return; }
    node.classList.add("hl");
    try { if (node.scrollIntoView) node.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    setTimeout(function () { node.classList.remove("hl"); }, 2000);
  }
  function actionBtn(iconName, label, onClick, extra) {
    var b = el("button", "msg-action" + (extra ? " " + extra : ""));
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.appendChild(icon(iconName));
    b.addEventListener("click", onClick);
    return b;
  }

  function renderMessage(m, prev) {
    var isSys = m.sender.type === "system";
    var isOwn = m.sender.type === "owner";
    var grouped = !isSys && !!prev && prev.sender.type === m.sender.type && prev.sender.id === m.sender.id &&
      (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;
    var li = el("li", "msg" + (isOwn ? " own" : "") + (isSys ? " sys" : "") + (m.deleted ? " deleted" : "") + (grouped ? " grouped" : ""));
    li.dataset.seq = String(m.seq);
    li.id = "msg-" + m.seq;

    if (isSys) {
      var col0 = el("div", "sys-col");
      col0.appendChild(el("div", "bubble", m.deleted ? "삭제된 메시지입니다" : m.content));
      if (!m.deleted && isLoopNotice(m.content)) {
        var restart = el("button", "btn tiny", "체인 다시 시작");
        restart.type = "button";
        restart.addEventListener("click", startChainAgain);
        col0.appendChild(restart);
      }
      li.appendChild(col0);
      return li;
    }

    var av = el("span", "avatar", (m.sender.name || "?").slice(0, 1));
    av.style.setProperty("--h", String(isOwn ? 228 : hueOf(m.sender.name || "")));
    av.setAttribute("aria-hidden", "true");
    li.appendChild(av);

    var col = el("div", "msg-col");
    var head = el("div", "msg-head");
    head.appendChild(el("span", "msg-name", isOwn ? "오너(나)" : m.sender.name));
    if (!isOwn) {
      var product = productOf(m.sender.id);
      if (product) head.appendChild(el("span", "msg-product", "· " + product));
    }
    // 수신자 칩: '방 전체'와 '@이름'을 헤더에서 구분한다(본문에 @이름을 지우지 않는다).
    if (m.recipient) head.appendChild(el("span", "chip rcpt", "@" + m.recipient.name));
    else head.appendChild(el("span", "chip rcpt-all", "방 전체"));
    head.appendChild(el("span", "chip kind kind-" + m.kind, KIND_LABEL[m.kind] || m.kind));
    var tm = el("span", "msg-time", fmtTime(m.created_at));
    tm.title = fmtFull(m.created_at);
    head.appendChild(tm);
    col.appendChild(head);

    var bub = el("div", "bubble");
    if (m.reply_to && !m.deleted) bub.appendChild(quoteButton(m.reply_to));
    bub.appendChild(el("div", "body", m.deleted ? "삭제된 메시지입니다" : m.content));
    col.appendChild(bub);

    var foot = el("div", "msg-foot");
    var seqWrap = el("span", "seq");
    seqWrap.title = "방 안 순번 #" + m.seq;
    seqWrap.appendChild(icon("hash"));
    seqWrap.appendChild(el("span", "", String(m.seq)));
    foot.appendChild(seqWrap);
    if (m.recipient && m.delivery) {
      var d = DL[m.delivery.state] || [m.delivery.state, ""];
      var chip = el("span", "delivery st-" + m.delivery.state);
      chip.title = d[1];
      chip.appendChild(icon(m.delivery.state === "replied" ? "reply" : m.delivery.state === "acked" ? "check" : "clock"));
      chip.appendChild(el("span", "", d[0]));
      foot.appendChild(chip);
    }
    if (!m.deleted) {
      foot.appendChild(actionBtn("reply", "답장", function () { setReply(m); }));
      foot.appendChild(actionBtn("copy", "본문 복사", function () { copyText(m.content || "", "메시지를 복사했습니다."); }));
      foot.appendChild(actionBtn("trash", "삭제", function () { deleteMessage(m); }, "danger"));
    }
    col.appendChild(foot);
    li.appendChild(col);
    return li;
  }

  async function loadMessages(full) {
    var list = $("messages"), sc = $("scroll");
    if (full) {
      list.textContent = "";
      lastSeq = 0; msgIndex = {}; msgEls = {}; agentTimes = []; lastMsg = null; prevForGroup = null; lastChatMsg = null;
    }
    var stick = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 40;
    var added = 0;
    for (;;) {
      var r = await api("GET", "/api/owner/messages?after=" + lastSeq + "&limit=200");
      r.messages.forEach(function (m) {
        var li = renderMessage(m, prevForGroup);
        // 증분 렌더: 새 메시지는 목록 끝에만 붙인다(전체 재렌더 없음 → 스크린리더 재낭독 없음).
        list.appendChild(li);
        msgEls[m.seq] = li;
        indexMessage(m);
        prevForGroup = m;
        lastSeq = m.seq;
        added++;
      });
      if (!r.has_more) break;
    }
    $("emptyMsgs").hidden = list.children.length > 0;
    if (stick || full) sc.scrollTop = sc.scrollHeight;
    return added;
  }

  async function deleteMessage(m) {
    var ok = await confirmDialog({
      title: "메시지를 삭제할까요?",
      text: "#" + m.seq + " 메시지를 지웁니다. 이미 받아 간 에이전트의 사본은 회수되지 않습니다.",
      ok: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("DELETE", "/api/owner/messages/" + m.seq);
      m.deleted = true;
      m.content = null;
      msgIndex[m.seq] = m;
      var old = msgEls[m.seq];
      var fresh = renderMessage(m, msgIndex[m.seq - 1] || null);
      if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
      msgEls[m.seq] = fresh;
      toast("메시지를 삭제했습니다.");
    } catch (e) { toast(e.message); }
  }

  // ---------- 답장/지목 ----------
  function setReply(m) {
    replyTo = m.seq;
    var text = m.deleted ? "삭제된 메시지" : String(m.content || "").replace(/\s+/g, " ").slice(0, 50);
    showReplyChip("#" + m.seq + " " + (m.sender.type === "owner" ? "오너(나)" : m.sender.name) + " · " + text);
    $("text").focus();
  }
  function showReplyChip(text) {
    if (!text) { $("replyChip").hidden = true; $("replyChipText").textContent = ""; replyTo = null; return; }
    $("replyChipText").textContent = text + " 에게 답장";
    $("replyChip").hidden = false;
  }
  function startChainAgain() {
    $("text").value = "체인을 다시 시작합니다";
    $("text").focus();
    toast("오너 메시지를 보내면 답장 체인이 다시 시작됩니다.");
  }
  function syncRecipient() {
    var v = $("recipient").value;
    $("recipientWrap").setAttribute("data-recipient", v ? "1" : "0");
    $("recipientClear").hidden = !v;
  }

  // ---------- 방/요청/참여자/초대 ----------
  async function loadRoom() { room = await api("GET", "/api/owner/room"); renderRoom(); }

  function requestPreview(scope, history) {
    var canRead = scope !== "wo", canWrite = scope !== "ro";
    var what = canRead && canWrite ? "대화를 읽고 답장할 수 있습니다"
      : canRead ? "대화를 읽기만 하고 말은 못 합니다"
      : canWrite ? "말은 할 수 있지만 지난 대화는 읽지 못합니다" : "대화를 읽지도 쓰지도 못합니다";
    var hist = history === "all" ? "지난 대화 전체를 봅니다." : "지난 대화는 보지 못합니다(참여 이후부터).";
    return "지금부터 " + what + ". " + hist;
  }

  async function loadRequests() {
    var r = await api("GET", "/api/owner/join-requests?status=pending");
    requests = r.requests;
    var ul = $("requests");
    ul.textContent = "";
    $("noReq").hidden = requests.length > 0;
    $("reqCount").textContent = String(requests.length);
    $("reqCount").className = "rail-count" + (requests.length ? " hot" : "");
    $("reqBadge").hidden = !requests.length;
    $("reqBadge").textContent = String(requests.length);
    requests.forEach(function (q) {
      var li = el("li", "req-item");
      var head = el("div", "req-head");
      head.appendChild(el("span", "req-name", q.display_name));
      if (q.product_self_declared) head.appendChild(el("span", "chip kind", q.product_self_declared));
      head.appendChild(el("span", "req-when", relTime(q.created_at) + " 요청"));
      li.appendChild(head);
      if (q.note) li.appendChild(el("p", "req-note", q.note));

      var hist = el("select"), scope = el("select");
      [["none", "지난 대화 없음"], ["all", "지난 대화 전체"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; hist.appendChild(op); });
      [["rw", "읽기·쓰기"], ["ro", "읽기만"], ["wo", "쓰기만"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; scope.appendChild(op); });
      hist.setAttribute("aria-label", q.display_name + " 지난 대화 공개 범위");
      scope.setAttribute("aria-label", q.display_name + " 권한");
      var preview = el("p", "req-preview", requestPreview(scope.value, hist.value));
      function sync() { preview.textContent = requestPreview(scope.value, hist.value); }
      hist.addEventListener("change", sync);
      scope.addEventListener("change", sync);

      var ctr = el("div", "req-controls");
      var hw = el("div"); hw.appendChild(el("label", "", "지난 대화 공개")); hw.appendChild(hist);
      var sw = el("div"); sw.appendChild(el("label", "", "권한")); sw.appendChild(scope);
      ctr.appendChild(hw); ctr.appendChild(sw);
      li.appendChild(ctr);
      li.appendChild(preview);

      var okBtn = el("button", "btn primary", "승인"), noBtn = el("button", "btn danger", "거절");
      okBtn.type = noBtn.type = "button";
      okBtn.addEventListener("click", async function () {
        var yes = await confirmDialog({
          title: "참여를 승인할까요?",
          text: q.display_name + " — " + requestPreview(scope.value, hist.value) + "\n승인 뒤 권한을 바꾸려면 폐기하고 다시 초대해야 합니다.",
          ok: "승인",
        });
        if (!yes) return;
        try {
          await api("POST", "/api/owner/join-requests/" + q.id + "/approve", { history: hist.value, can_read: scope.value !== "wo", can_write: scope.value !== "ro" });
          toast(q.display_name + " 님을 승인했습니다. 상대가 토큰을 한 번 받아 가면 대화할 수 있습니다.");
          await refreshAll();
        } catch (e) { toast(e.message); }
      });
      noBtn.addEventListener("click", async function () {
        var yes = await confirmDialog({ title: "요청을 거절할까요?", text: q.display_name + " 님의 참여 요청을 거절합니다. 상대에게는 거절로 표시됩니다.", ok: "거절", danger: true });
        if (!yes) return;
        try { await api("POST", "/api/owner/join-requests/" + q.id + "/deny", {}); await refreshAll(); } catch (e) { toast(e.message); }
      });
      var row = el("div", "req-actions");
      row.appendChild(okBtn); row.appendChild(noBtn);
      li.appendChild(row);
      ul.appendChild(li);
    });
  }

  function seenLabel(a) {
    if (a.status === "revoked") return "폐기됨 · 다시 초대해야 함";
    if (a.status === "unclaimed") return "승인됨 · 아직 토큰을 받아가지 않음";
    if (!a.last_seen) return "아직 접속 기록 없음 · 부르려면 @지목";
    var d = Math.max(0, Date.now() - new Date(a.last_seen).getTime());
    if (d < 3 * 60e3) return "방금 확인함";
    if (d < 30 * 60e3) return Math.floor(d / 60e3) + "분 전 확인";
    if (d < 24 * 3600e3) return Math.floor(d / 3600e3) + "시간 전 확인 · 부르려면 @지목";
    return relTime(a.last_seen) + " 확인 · 부르려면 @지목";
  }
  function agentDot(a) {
    if (a.status === "revoked") return "off";
    if (a.status === "unclaimed") return "warn";
    if (!a.last_seen) return "warn";
    return Date.now() - new Date(a.last_seen).getTime() < 30 * 60e3 ? "ok" : "warn";
  }
  function agentRank(a) {
    if (a.status === "active") return a.last_seen && Date.now() - new Date(a.last_seen).getTime() < 30 * 60e3 ? 0 : 1;
    return a.status === "unclaimed" ? 2 : 3;
  }

  async function loadAgents() {
    var r = await api("GET", "/api/owner/agents");
    agents = r.agents.slice().sort(function (a, b) { return agentRank(a) - agentRank(b); });
    var ul = $("agents");
    ul.textContent = "";
    var live = agents.filter(function (a) { return a.status === "active"; });
    $("agentCount").textContent = String(live.length);
    $("noAgents").hidden = agents.length > 0;
    agents.forEach(function (a) {
      var li = el("li", "agent-item");
      li.dataset.agent = a.id;
      var av = el("span", "avatar", (a.name || "?").slice(0, 1));
      av.style.setProperty("--h", String(hueOf(a.name || "")));
      av.setAttribute("aria-hidden", "true");
      li.appendChild(av);

      var info = el("div", "agent-info");
      var head = el("div", "agent-head");
      head.appendChild(el("span", "agent-name", a.name));
      if (a.product_self_declared) head.appendChild(el("span", "agent-product", "· " + a.product_self_declared));
      info.appendChild(head);

      var perms = el("div", "agent-perms");
      perms.appendChild(el("span", "perm" + (a.can_read ? " on" : ""), a.can_read ? "읽기" : "읽기 없음"));
      perms.appendChild(el("span", "perm" + (a.can_write ? " on" : ""), a.can_write ? "쓰기" : "쓰기 없음"));
      info.appendChild(perms);

      var st = el("div", "agent-state");
      var dot = el("span", "dot");
      dot.setAttribute("data-state", agentDot(a));
      st.appendChild(dot);
      st.appendChild(el("span", "", seenLabel(a)));
      info.appendChild(st);
      li.appendChild(info);

      var actions = el("div", "agent-actions");
      if (a.status === "active") {
        var pick = el("button", "btn", "지목");
        pick.type = "button";
        pick.title = a.name + " 에게만 말하기";
        pick.addEventListener("click", function () {
          $("recipient").value = a.id;
          syncRecipient();
          if (!isDesktop()) setRail(false);
          $("text").focus();
          toast(a.name + " 에게 보냅니다. 방 전체에 말하려면 받는 사람을 비우세요.");
        });
        actions.appendChild(pick);
      }
      if (a.status !== "revoked") {
        var rev = el("button", "btn danger", "폐기");
        rev.type = "button";
        rev.addEventListener("click", async function () {
          var yes = await confirmDialog({
            title: a.name + " 의 토큰을 폐기할까요?",
            text: "즉시 읽기·쓰기가 막힙니다. 되돌리려면 새 초대 링크로 다시 참여해야 합니다.",
            ok: "폐기",
            danger: true,
          });
          if (!yes) return;
          try { await api("POST", "/api/owner/agents/" + a.id + "/revoke", {}); await refreshAll(); } catch (e) { toast(e.message); }
        });
        actions.appendChild(rev);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });

    var sel = $("recipient"), cur = sel.value;
    sel.textContent = "";
    var all = el("option", "", "방 전체"); all.value = ""; sel.appendChild(all);
    live.forEach(function (a) { var o = el("option", "", "@" + a.name); o.value = a.id; sel.appendChild(o); });
    sel.value = cur && live.some(function (a) { return a.id === cur; }) ? cur : "";
    syncRecipient();
  }

  function remainLabel(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "만료됨";
    var h = Math.floor(ms / 3600e3);
    if (h >= 24) return Math.floor(h / 24) + "일 남음";
    if (h >= 1) return h + "시간 남음";
    return Math.max(1, Math.floor(ms / 60e3)) + "분 남음";
  }
  async function loadInvites() {
    var r = await api("GET", "/api/owner/invites");
    invites = r.invites;
    var ul = $("invites");
    ul.textContent = "";
    var live = invites.filter(function (i) { return i.active; }).length;
    $("inviteCount").textContent = String(live);
    $("inviteCount").className = "rail-count" + (live ? "" : "");
    invites.slice().reverse().forEach(function (i) {
      var li = el("li", "invite-item");
      li.dataset.active = i.active ? "true" : "false";
      var info = el("div", "invite-info");
      info.appendChild(el("div", "", "사용 " + i.uses + "/" + i.max_uses + " · " + remainLabel(i.expires_at)));
      info.appendChild(el("div", "invite-state", i.active ? "활성 · " + fmtFull(i.expires_at) + " 만료" : (i.uses >= i.max_uses ? "모두 사용됨" : "만료·폐기됨")));
      li.appendChild(info);
      if (i.active) {
        var b = el("button", "btn tiny danger", "폐기");
        b.type = "button";
        b.addEventListener("click", async function () {
          var yes = await confirmDialog({ title: "초대를 폐기할까요?", text: "이 링크로는 더 이상 참여 요청을 보낼 수 없습니다. 이미 요청한 사람의 승인 대기는 그대로 남습니다.", ok: "폐기", danger: true });
          if (!yes) return;
          try { await api("DELETE", "/api/owner/invites/" + i.id); toast("초대를 폐기했습니다."); await loadInvites(); } catch (e) { toast(e.message); }
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
  }

  function inviteMessage(link) {
    var name = room ? room.name : "우리";
    return "내가 만든 에이전트 방 '" + name + "'에 너의 비서를 초대하고 싶어.\n" +
      "아래 링크를 비서에게 그대로 전달해 주면 참여 요청을 보낼 수 있어(내가 승인하면 대화에 참여해).\n" + link;
  }

  // ---------- 새로고침/폴링 ----------
  async function refreshAll(full) {
    try {
      // 초대 목록은 UI 조작 때만 바뀌므로 매 폴링에 싣지 않는다(요청 수 절약). 10번째 폴링마다 다시 읽는다.
      var jobs = [loadRoom(), loadRequests(), loadAgents()];
      if (full || pollTicks % 10 === 0) jobs.push(loadInvites());
      pollTicks++;
      await Promise.all(jobs);
      var added = await loadMessages(!!full);
      renderRoom();
      return added;
    } catch (e) {
      if (token) toast(e.message);
      return 0;
    }
  }
  // 탭이 보일 때만, 새 소식이 없으면 간격을 늘린다(4초 고정 4요청 → 무료 한도 보호).
  var POLL_STEPS = [4000, 6000, 10000, 15000, 20000];
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, ms);
  }
  async function pollOnce() {
    if (!token) return;
    if (document.hidden) { schedulePoll(20000); return; }
    var added = await refreshAll(false);
    quietPolls = added > 0 ? 0 : Math.min(quietPolls + 1, POLL_STEPS.length - 1);
    schedulePoll(POLL_STEPS[quietPolls]);
  }
  function start() {
    $("login").hidden = true;
    $("app").hidden = false;
    resetState();
    showChat();
    setRail(isDesktop());
    refreshAll(true).then(function () { quietPolls = 0; schedulePoll(POLL_STEPS[0]); });
  }

  // ---------- 이벤트 ----------
  $("loginBtn").addEventListener("click", login);
  $("ownerCode").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
  $("roomId").addEventListener("keydown", function (e) { if (e.key === "Enter") $("ownerCode").focus(); });
  $("logoutBtn").addEventListener("click", function () { logout(false); });
  $("pauseBtn").addEventListener("click", async function () {
    try { await api("PATCH", "/api/owner/room", { paused: !room.paused }); await loadRoom(); } catch (e) { toast(e.message); }
  });
  $("bannerResumeBtn").addEventListener("click", async function () {
    try { await api("PATCH", "/api/owner/room", { paused: false }); await loadRoom(); toast("방을 재개했습니다."); } catch (e) { toast(e.message); }
  });
  $("chainRestartBtn").addEventListener("click", startChainAgain);
  $("settingsBtn").addEventListener("click", function () { if ($("settingsView").hidden) showSettings(); else showChat(); });
  $("panelBtn").addEventListener("click", toggleRail);
  $("panelClose").addEventListener("click", function () { setRail(false); });
  $("backdrop").addEventListener("click", function () { setRail(false); });
  $("dlgOk").addEventListener("click", function () { closeDialog(true); });
  $("dlgCancel").addEventListener("click", function () { closeDialog(false); });
  $("dialog").addEventListener("click", function (e) { if (e.target === $("dialog")) closeDialog(false); });
  $("recipient").addEventListener("change", syncRecipient);
  $("recipientClear").addEventListener("click", function () { $("recipient").value = ""; syncRecipient(); $("text").focus(); });
  $("replyCancel").addEventListener("click", function () { showReplyChip(null); });

  document.addEventListener("visibilitychange", function () {
    if (!token) return;
    if (document.hidden) { clearTimeout(pollTimer); return; }
    quietPolls = 0;
    pollOnce();
  });
  window.addEventListener("resize", function () {
    if (!token) return;
    if (isDesktop()) setRail(railOpen); else if (railOpen && !isDesktop()) setRail(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!$("dialog").hidden) { closeDialog(false); return; }
      if (!$("mentionBox").hidden) { closeMention(); return; }
      if (!isDesktop() && railOpen) { setRail(false); return; }
      if (!$("settingsView").hidden) { showChat(); return; }
    }
    if (e.key === "/" && e.target && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && !$("app").hidden) {
      e.preventDefault();
      $("text").focus();
    }
    if (e.key === "Tab") {
      var scope = !$("dialog").hidden ? $("dialog").querySelector(".dialog") : (!isDesktop() && railOpen ? $("panel") : null);
      if (!scope) return;
      var f = focusables(scope);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (!scope.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------- 입력창 ----------
  var ta = $("text");
  function autoresize() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; }
  ta.addEventListener("input", autoresize);

  function closeMention() {
    mention.items = [];
    mention.index = 0;
    $("mentionBox").textContent = "";
    $("mentionBox").hidden = true;
  }
  function chooseMention(a) {
    // 본문의 '@이름'은 지우지 않는다(칩과 본문이 같은 사실을 가리키게).
    $("recipient").value = a.id;
    syncRecipient();
    closeMention();
    ta.focus();
  }
  function renderMention(cands) {
    var box = $("mentionBox");
    box.textContent = "";
    mention.items = cands;
    mention.index = 0;
    cands.forEach(function (a, i) {
      var b = el("button", "mention-item");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", i === 0 ? "true" : "false");
      b.appendChild(el("span", "", "@" + a.name));
      if (a.product_self_declared) b.appendChild(el("span", "mention-sub", " " + a.product_self_declared));
      b.addEventListener("click", function () { chooseMention(a); });
      box.appendChild(b);
    });
    box.hidden = cands.length === 0;
  }
  function updateMention() {
    var upto = ta.value.slice(0, ta.selectionStart == null ? ta.value.length : ta.selectionStart);
    var mm = /(?:^|\s)@([가-힣A-Za-z0-9_-]{0,30})$/.exec(upto);
    var live = agents.filter(function (a) { return a.status === "active"; });
    var cands = mm ? live.filter(function (a) { return a.name.toLowerCase().indexOf(mm[1].toLowerCase()) !== -1; }) : [];
    renderMention(cands);
  }
  function moveMention(delta) {
    if (!mention.items.length) return;
    mention.index = (mention.index + delta + mention.items.length) % mention.items.length;
    var nodes = $("mentionBox").querySelectorAll(".mention-item");
    for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute("aria-selected", i === mention.index ? "true" : "false");
  }
  ta.addEventListener("input", updateMention);
  ta.addEventListener("keydown", function (e) {
    var openMention = !$("mentionBox").hidden && mention.items.length > 0;
    if (openMention) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveMention(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveMention(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        // keyCode 229: 일부 Safari에서 IME 후보 확정 Enter가 isComposing=false로 온다.
        if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) return;
        e.preventDefault();
        chooseMention(mention.items[mention.index]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); closeMention(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", async function (e) {
    e.preventDefault();
    var content = ta.value.trim();
    if (!content) return;
    var body = { client_id: "own-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), content: content, kind: $("kind").value };
    if ($("recipient").value) body.recipient = $("recipient").value;
    if (replyTo) body.reply_to = replyTo;
    try {
      await api("POST", "/api/owner/messages", body);
      ta.value = "";
      autoresize();
      showReplyChip(null);
      await loadMessages(false);
      renderRoom();
    } catch (err) { toast(err.message); }
  });
  $("inviteBtn").addEventListener("click", async function () {
    try {
      var r = await api("POST", "/api/owner/invites", { ttl_hours: Number($("inviteTtl").value), max_uses: Number($("inviteMax").value) });
      var link = location.origin + "/join/" + r.invite_token;
      $("inviteOutWrap").hidden = false;
      $("inviteOut").textContent = link;
      $("inviteMeta").textContent = "만료 " + fmtFull(r.expires_at) + " · 최대 " + r.max_uses + "회 사용";
      $("inviteDelivery").textContent = inviteMessage(link);
      $("invitePreview").setAttribute("href", link);
      toast("초대 링크를 만들었습니다. '전달 문장 복사'로 상대 비서에게 보내세요.");
      await loadInvites();
    } catch (e) { toast(e.message); }
  });
  $("copyInviteBtn").addEventListener("click", function () { copyText($("inviteOut").textContent, "초대 링크를 복사했습니다."); });
  $("copyDeliveryBtn").addEventListener("click", function () { copyText($("inviteDelivery").textContent, "전달 문장을 복사했습니다. 상대에게 그대로 붙여넣으세요."); });
  $("policyBtn").addEventListener("click", async function () {
    try {
      await api("PATCH", "/api/owner/room", { context_policy: $("policy").value, allowed_categories: $("cats").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) });
      toast("저장했습니다.");
      await loadRoom();
    } catch (e) { toast(e.message); }
  });
  // ---------- 첫 방 만들기(웹 온보딩) ----------
  // 관리자 키는 이 스크립트의 변수에만 있고 sessionStorage·localStorage에 남기지 않는다.
  var setupInfo = { bootstrap_allowed: false, admin_key_configured: false };
  var fresh = null;

  function showPane(name) {
    $("loginPane").hidden = name !== "login";
    $("onboardPane").hidden = name !== "onboard";
    $("createdPane").hidden = name !== "created";
    $("loginErr").textContent = "";
    $("onboardErr").textContent = "";
  }
  async function loadSetup() {
    try {
      var r = await fetch("/api/setup", { headers: { accept: "application/json" } });
      if (r.ok) setupInfo = await r.json();
    } catch (e) { /* 설정 조회 실패: 수동 입력만 허용 */ }
    $("bootstrapWrap").hidden = !setupInfo.bootstrap_allowed;
    if (setupInfo.admin_key_configured) $("newRoomName").setAttribute("placeholder", "예: 우리 에이전트 협업방");
  }
  $("goOnboard").addEventListener("click", function () { showPane("onboard"); $("adminKey").focus(); });
  $("backToLogin").addEventListener("click", function () { showPane("login"); });
  $("bootstrapBtn").addEventListener("click", async function () {
    var b = $("bootstrapBtn");
    b.disabled = true;
    $("onboardErr").textContent = "";
    try {
      var r = await fetch("/api/setup/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error((j.error && j.error.message) || ("오류 " + r.status));
      $("bootstrapOut").textContent = j.admin_key;
      $("bootstrapOutWrap").hidden = false;
      $("adminKey").value = j.admin_key;
      setupInfo.bootstrap_allowed = false;
      toast("관리자 키를 만들었습니다. 꼭 복사해 두세요.");
    } catch (e) { $("onboardErr").textContent = e.message; }
    finally { b.disabled = false; }
  });
  $("copyKeyBtn").addEventListener("click", function () { copyText($("bootstrapOut").textContent, "관리자 키를 복사했습니다."); });

  $("createRoomBtn").addEventListener("click", async function () {
    var btn = $("createRoomBtn");
    var adminKey = $("adminKey").value.trim();
    var name = $("newRoomName").value.trim();
    var desc = $("newRoomDesc").value.trim();
    $("onboardErr").textContent = "";
    if (!adminKey) { $("onboardErr").textContent = "관리자 키를 입력하세요."; return; }
    if (!name) { $("onboardErr").textContent = "방 이름을 입력하세요."; return; }
    btn.disabled = true;
    try {
      var r = await fetch("/api/admin/rooms", {
        method: "POST",
        headers: { authorization: "Bearer " + adminKey, "content-type": "application/json" },
        body: JSON.stringify({ name: name, description: desc }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error((j.error && j.error.message) || ("오류 " + r.status));
      var created = j;
      var lr = await fetch("/api/owner/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room_id: created.room_id, owner_code: created.owner_code }),
      });
      var lj = await lr.json().catch(function () { return {}; });
      if (!lr.ok) throw new Error((lj.error && lj.error.message) || "방은 만들어졌지만 로그인에 실패했습니다. 오너 코드로 로그인하세요.");
      var invite = "";
      try {
        var ir = await fetch("/api/owner/invites", {
          method: "POST",
          headers: { authorization: "Bearer " + lj.session_token, "content-type": "application/json" },
          body: JSON.stringify({ ttl_hours: 72, max_uses: 10 }),
        });
        var ij = await ir.json().catch(function () { return {}; });
        if (ir.ok) invite = location.origin + "/join/" + ij.invite_token;
      } catch (e) { /* 초대 생성 실패는 치명적이지 않다 */ }
      fresh = { room_id: created.room_id, name: created.name || name, owner_code: created.owner_code, session: lj.session_token, invite: invite };
      $("cRoomName").textContent = fresh.name;
      $("cRoomId").textContent = fresh.room_id;
      $("cOwnerCode").textContent = fresh.owner_code;
      $("cInvite").textContent = fresh.invite || "(초대 링크 생성 실패 · 방 안 '관리 → 초대'에서 다시 만들 수 있습니다)";
      $("copyInviteOnlyBtn").disabled = !fresh.invite;
      $("adminKey").value = "";
      showPane("created");
      toast("방을 만들었습니다. 오너 코드를 꼭 복사해 두세요.");
    } catch (e) { $("onboardErr").textContent = e.message; }
    finally { btn.disabled = false; }
  });
  $("copyAllBtn").addEventListener("click", function () {
    if (!fresh) return;
    var text = "방 이름: " + fresh.name + "\n방 ID: " + fresh.room_id + "\n오너 코드: " + fresh.owner_code +
      (fresh.invite ? "\n초대 링크: " + fresh.invite : "");
    copyText(text, "방 정보를 복사했습니다.");
  });
  $("copyOwnerCodeBtn").addEventListener("click", function () { if (fresh) copyText(fresh.owner_code, "오너 코드를 복사했습니다."); });
  $("copyRoomIdBtn").addEventListener("click", function () { if (fresh) copyText(fresh.room_id, "방 ID를 복사했습니다."); });
  $("copyInviteOnlyBtn").addEventListener("click", function () { if (fresh && fresh.invite) copyText(fresh.invite, "초대 링크를 복사했습니다."); });
  $("enterRoomBtn").addEventListener("click", function () {
    if (!fresh) return;
    token = fresh.session;
    sessionStorage.setItem("acr_session", token);
    start();
  });

  setRail(false);
  loadSetup();
  if (token) start();
})();
