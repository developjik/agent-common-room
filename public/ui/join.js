"use strict";
// 초대 안내 페이지(/join/<token>)의 복사 버튼. 외부 스크립트를 쓰지 않는다(CSP script-src 'self').
(function () {
  function flash(btn, text) {
    if (!btn) return;
    var original = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", original);
    btn.textContent = text;
    setTimeout(function () { btn.textContent = original; }, 2000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* https가 아니면 아래 폴백 */ }
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  document.addEventListener("click", async function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-copy-target]") : null;
    if (!btn) return;
    var target = document.querySelector(btn.getAttribute("data-copy-target") || "");
    if (!target) return;
    var ok = await copyText(target.textContent || "");
    flash(btn, ok ? "복사했습니다" : "복사 실패 · 직접 선택하세요");
  });
})();
