(() => {
  "use strict";

  const ROOT_ID = "agent24-purchase-guard";
  const BACKEND_URL = "http://localhost:8787";
  const { findSite, matchesPaymentText } = globalThis.Agent24Sites;
  const currentSite = findSite(location.hostname);

  if (!currentSite) {
    return;
  }

  const CATEGORY_KEYWORDS = [
    [/후드|맨투맨|자켓|코트|바지|청바지|신발|스니커즈|가디건|니트|의류|패션/i, "패션"],
    [/마우스|키보드|이어폰|헤드폰|충전기|케이블|노트북|모니터|전자/i, "전자기기"],
    [/조명|스탠드|가구|침구|주방|생활/i, "생활용품"],
    [/음식|간식|과자|음료|식품|식재료/i, "식비"],
  ];

  function guessCategory(name) {
    if (!name) return "기타";
    for (const [pattern, category] of CATEGORY_KEYWORDS) {
      if (pattern.test(name)) return category;
    }
    return "기타";
  }

  const allowedControls = new WeakSet();
  const allowedForms = new WeakSet();

  let dialogElements = null;
  let resumeAction = null;
  let previouslyFocused = null;
  let wizard = null; // { caseId }

  function getControlText(control) {
    return [
      control.innerText,
      control.textContent,
      control.value,
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getInteractiveControl(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    return target.closest(
      'button, a[href], input[type="submit"], input[type="button"], [role="button"]',
    );
  }

  function isPaymentControl(control) {
    if (!control || control.closest(`#${ROOT_ID}`)) {
      return false;
    }

    const text = getControlText(control);
    const matchesSelector = currentSite.paymentSelectors.some((selector) =>
      control.matches(selector),
    );
    const matchesPaymentWording = matchesPaymentText(
      currentSite,
      text,
      location.href,
      location.href,
    );

    return matchesSelector || matchesPaymentWording;
  }

  function formLooksLikePayment(submitter) {
    return isPaymentControl(submitter);
  }

  // ---- Dialog shell (unchanged) -------------------------------------------------

  function buildDialog() {
    if (dialogElements) {
      return dialogElements;
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.hidden = true;
    root.innerHTML = `
      <div class="agent24-backdrop" data-agent24-cancel></div>
      <section
        class="agent24-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="agent24-title"
      >
        <div class="agent24-accent" aria-hidden="true"></div>
        <div class="agent24-content" id="agent24-screen"></div>
      </section>
    `;

    root.querySelector(".agent24-backdrop").addEventListener("click", () => closeDialog());
    document.documentElement.append(root);

    dialogElements = { root, screen: root.querySelector("#agent24-screen") };
    return dialogElements;
  }

  function openDialog() {
    if (!document.documentElement) {
      document.addEventListener("readystatechange", openDialog, { once: true });
      return;
    }
    const dialog = buildDialog();
    previouslyFocused = document.activeElement;
    dialog.root.hidden = false;
    document.documentElement.classList.add("agent24-dialog-open");
    focusFirst();
  }

  function closeDialog() {
    if (!dialogElements || dialogElements.root.hidden) {
      return;
    }
    stopInvestigatingTimer();
    dialogElements.root.hidden = true;
    document.documentElement.classList.remove("agent24-dialog-open");
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
    resumeAction = null;
    wizard = null;
  }

  // ---- Cross-page-navigation bypass -------------------------------------------------
  // The WeakSet-based allowedControls/allowedForms mechanism only survives within a
  // single page's JS context — it lets the replayed click through immediately, but a
  // real checkout flow often continues onto a NEW page (e.g. Coupang's order-sheet
  // page) with its OWN "결제하기" button, which is a completely fresh DOM/JS context
  // where that WeakSet is empty again. Without this, the wizard re-triggers on every
  // page of the same checkout flow. sessionStorage survives navigation within the same
  // tab, so a short time-boxed bypass here covers "the rest of this same checkout."

  const BYPASS_KEY = "agent24_bypass_until";
  const BYPASS_WINDOW_MS = 5 * 60 * 1000;

  function armBypass() {
    try {
      sessionStorage.setItem(BYPASS_KEY, String(Date.now() + BYPASS_WINDOW_MS));
    } catch {
      // best-effort; if storage is unavailable, the wizard may re-trigger on the
      // next page, which is a degraded-but-safe fallback, not a hard failure.
    }
  }

  function isBypassActive() {
    try {
      return Date.now() < Number(sessionStorage.getItem(BYPASS_KEY) || 0);
    } catch {
      return false;
    }
  }

  function proceedWithOriginal() {
    armBypass();
    resumeAction?.();
    closeDialog();
  }

  function getFocusable() {
    if (!dialogElements) return [];
    return Array.from(
      dialogElements.screen.querySelectorAll(
        'button:not(:disabled), textarea, input:not(:disabled), a[href], [role="button"]',
      ),
    );
  }

  function focusFirst() {
    requestAnimationFrame(() => getFocusable()[0]?.focus());
  }

  function handleKeydown(event) {
    if (!dialogElements || dialogElements.root.hidden) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = getFocusable();
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex - 1 + focusable.length) % focusable.length
      : (currentIndex + 1) % focusable.length;
    event.preventDefault();
    focusable[nextIndex].focus();
  }

  // ---- Static fallback (unchanged — used if the backend is unreachable at any point) -------------------------------------------------

  function renderStaticFallback() {
    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · ${currentSite.name}</p>
      <h2 id="agent24-title">잠깐, 정말 결제할까요?</h2>
      <p>지금 결제를 완료하려고 해요. 결제를 취소하거나 확인 후 계속 진행할 수 있어요.</p>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-fallback-cancel">결제 취소</button>
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-fallback-continue">그래도 계속</button>
      </div>
    `;
    document.getElementById("agent24-fallback-cancel").onclick = () => closeDialog();
    document.getElementById("agent24-fallback-continue").onclick = () => proceedWithOriginal();
    focusFirst();
  }

  // ---- Backend calls (unchanged signature, new base URL/timeouts) -------------------------------------------------

  async function callBackend(path, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BACKEND_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`backend ${path} returned ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function escapeAttr(str) {
    return String(str ?? "").replace(/"/g, "&quot;");
  }

  // ---- /api/observe — fired once at page load, independent of the checkout click -------------------------------------------------
  // So the server can compute dwell_minutes (checkout_at - detected_at) later.
  // Fire-and-forget; failures are ignored.

  function fireObserveOnce() {
    let attempts = 0;
    const tryObserve = () => {
      attempts += 1;
      let scraped = null;
      try {
        scraped = currentSite.scrapeProduct?.();
      } catch {
        // best-effort
      }
      if (scraped?.name || attempts >= 5) {
        if (scraped?.name) {
          callBackend(
            "/api/observe",
            {
              profile_id: "B",
              product: {
                name: scraped.name,
                price: scraped.price ?? 0,
                category: guessCategory(scraped.name),
              },
            },
            5000,
          ).catch(() => {});
        }
        return;
      }
      setTimeout(tryObserve, 1000);
    };
    tryObserve();
  }

  // ---- DOM signal collection for /api/case -------------------------------------------------

  function labelFor(input) {
    if (input.labels && input.labels.length) return input.labels[0].textContent.trim();
    const aria = input.getAttribute("aria-label");
    if (aria) return aria.trim();
    const wrapping = input.closest("label");
    return wrapping ? wrapping.textContent.trim() : null;
  }

  function collectSignals() {
    const page_text = (document.body?.innerText || "").slice(0, 20000);

    const preselected_inputs = Array.from(
      document.querySelectorAll('input[type="checkbox"]:checked, input[type="radio"]:checked'),
    )
      .map(labelFor)
      .filter(Boolean)
      .slice(0, 20);

    const countdown_timers = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (t.length > 0 && t.length < 40 && /\d{1,2}:\d{2}(:\d{2})?/.test(t)) {
          countdown_timers.push(t);
          if (countdown_timers.length >= 10) break;
        }
      }
    }

    return { page_text, dom_signals: { preselected_inputs, countdown_timers } };
  }

  // ---- Screen 0: confirm scraped (or manually entered) product info -------------------------------------------------

  function renderProductConfirmScreen() {
    let scraped = { name: null, price: null };
    try {
      scraped = currentSite.scrapeProduct?.() || scraped;
    } catch {
      // scraping is best-effort; fall through to blank/manual fields
    }

    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · ${currentSite.name}</p>
      <h2 id="agent24-title">결제하려는 상품이 맞나요?</h2>
      <p class="agent24-hint">자동으로 읽어온 값이에요. 다르면 직접 고쳐주세요.</p>
      <label class="agent24-field">상품명
        <input type="text" id="agent24-product-name" value="${scraped.name ? escapeAttr(scraped.name) : ""}" />
      </label>
      <label class="agent24-field">가격(원)
        <input type="number" id="agent24-product-price" value="${scraped.price ?? ""}" />
      </label>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-product-cancel">취소</button>
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-product-continue">확인</button>
      </div>
    `;

    document.getElementById("agent24-product-cancel").onclick = () => closeDialog();
    document.getElementById("agent24-product-continue").onclick = async () => {
      const name = document.getElementById("agent24-product-name").value.trim();
      const price = Number(document.getElementById("agent24-product-price").value);
      if (!name || !price || price <= 0) return;
      await startCase(name, price);
    };
    focusFirst();
  }

  // ---- /api/case — the checkout-click trigger, branches 3 ways -------------------------------------------------

  async function startCase(name, price) {
    dialogElements.screen.innerHTML = `<p>확인하는 중입니다...</p>`;
    const laterLabelTimer = setTimeout(() => {
      if (dialogElements?.screen) {
        dialogElements.screen.innerHTML = `<p>최저가를 찾는 중입니다...</p>`;
      }
    }, 1500);

    const { page_text, dom_signals } = collectSignals();
    let result;
    try {
      result = await callBackend(
        "/api/case",
        {
          profile_id: "B",
          product: { name, price, category: guessCategory(name) },
          page_text,
          dom_signals,
          payment_method_bnpl: false,
        },
        130000,
      );
    } catch {
      clearTimeout(laterLabelTimer);
      renderStaticFallback();
      return;
    }
    clearTimeout(laterLabelTimer);

    wizard = { caseId: result.case_id };

    if (result.parse_failed) {
      renderParseFailedScreen(result);
    } else if (result.mode === "price_only") {
      renderPriceOnlyScreen(result);
    } else {
      renderQuestionScreen(result);
    }
  }

  function renderParseFailedScreen(result) {
    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · ${currentSite.name}</p>
      <h2 id="agent24-title">상품 정보를 확인하지 못했어요</h2>
      <p>${escapeAttr(result.message || "판단할 근거가 없어 결제를 막지 않습니다.")}</p>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-parsefail-continue">계속</button>
      </div>
    `;
    document.getElementById("agent24-parsefail-continue").onclick = () => proceedWithOriginal();
    focusFirst();
  }

  // ---- Shared render helpers for budget / dark patterns -------------------------------------------------

  function renderBudgetBlock(b) {
    if (!b) return "";
    return `
      <p class="agent24-budget">
        이번 달 남은 자유예산 ₩${(b.remaining ?? 0).toLocaleString()} 중 이 결제는 ₩${(b.product_price ?? 0).toLocaleString()}이며,
        결제 후 남는 돈: ₩${(b.after_purchase ?? 0).toLocaleString()} (급여일까지 D-${b.days_until_payday ?? "?"})
        ${b.upcoming_total ? `<br/>예정 지출 ₩${b.upcoming_total.toLocaleString()}까지 반영하면: ₩${(b.after_upcoming ?? 0).toLocaleString()}` : ""}
      </p>
    `;
  }

  // 다크패턴 탐지 결과는 팝업에 표시하지 않는다.
  // 탐지 자체는 백엔드에서 계속 수행되고 위험 점수(+1)에도 반영되지만,
  // 화면에 나열하지는 않는다. 응답의 result.dark_patterns 는 그대로 내려온다.

  // ---- price_only screen (input 0회 — investigation already ran server-side) -------------------------------------------------

  function renderPriceOnlyScreen(result) {
    const pc = result.price_check || {};
    let priceHtml;
    if (pc.searched && pc.cheaper_found) {
      priceHtml = `
        <p class="agent24-price-found">✅ 더 싼 곳이 있습니다 · ₩${(pc.best_price ?? 0).toLocaleString()} (₩${(pc.saving ?? 0).toLocaleString()} 절약)</p>
        <p class="agent24-price-seller">판매처: ${escapeAttr(pc.seller || "확인됨")}${pc.source_url ? ` · <a href="${escapeAttr(pc.source_url)}" target="_blank">근거</a>` : ""}</p>
      `;
    } else {
      priceHtml = `<p>${pc.searched ? "더 싼 곳을 찾지 못했습니다. 최저가라고 단정하지 않습니다." : "가격 비교를 수행하지 못했습니다."}</p>`;
    }

    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · 심문 없음 · 마찰 없음</p>
      <h2 id="agent24-title">가격만 확인했습니다</h2>
      <p>${escapeAttr(result.mode_reason || "")}</p>
      ${renderBudgetBlock(result.budget)}
      ${priceHtml}
      ${pc.note ? `<p class="agent24-hint">${escapeAttr(pc.note)}</p>` : ""}
      ${result.agent_error ? `<p class="agent24-hint">일부 조사에 실패했지만 확인된 정보만으로 안내합니다.</p>` : ""}
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-priceonly-cancel">취소</button>
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-priceonly-buy">결제하기</button>
      </div>
    `;

    document.getElementById("agent24-priceonly-cancel").onclick = () => closeDialog();
    document.getElementById("agent24-priceonly-buy").onclick = async () => {
      await resolveCase("accept");
      proceedWithOriginal();
    };
    focusFirst();
  }

  // ---- challenge screen: question + alternatives yes/no (the ONE user input round trip) -------------------------------------------------

  function renderQuestionScreen(result) {
    const q = result.question || {
      format: "text",
      text: "왜 지금 사야 합니까?",
      options: [],
      allow_free_text: true,
      free_text_placeholder: "",
    };

    const optionsHtml =
      q.format === "choice"
        ? `
      <div class="agent24-options">
        ${q.options
          .map(
            (opt) => `
          <label class="agent24-option">
            <input type="checkbox" name="agent24-option" value="${escapeAttr(opt.id)}" />
            ${escapeAttr(opt.label)}
          </label>
        `,
          )
          .join("")}
      </div>
    `
        : "";

    const freeTextNeeded = q.format === "text" || q.allow_free_text;

    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · 결제 직전 개입</p>
      <h2 id="agent24-title">${escapeAttr(q.text)}</h2>
      ${renderBudgetBlock(result.budget)}
      ${optionsHtml}
      ${
        freeTextNeeded
          ? `<label class="agent24-field">${q.format === "text" ? "" : "또는 직접 적어주세요"}
        <textarea id="agent24-reason" rows="2" placeholder="${escapeAttr(q.free_text_placeholder || "간단히 적어주세요")}"></textarea>
      </label>`
          : ""
      }
      <label class="agent24-yesno">
        <input type="checkbox" id="agent24-want-alt" checked />
        ${escapeAttr(result.alternatives_prompt || "다른 가격이나 대안 상품을 찾아드릴까요?")}
      </label>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-question-cancel">결제 취소</button>
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-question-continue" disabled>조사 시작</button>
      </div>
    `;

    const continueBtn = document.getElementById("agent24-question-continue");
    const textarea = document.getElementById("agent24-reason");
    const checkboxes = Array.from(dialogElements.screen.querySelectorAll('input[name="agent24-option"]'));

    function refreshEnabled() {
      const anyChecked = checkboxes.some((cb) => cb.checked);
      const hasText = textarea && textarea.value.trim().length > 0;
      continueBtn.disabled = !(anyChecked || hasText);
    }
    checkboxes.forEach((cb) => cb.addEventListener("change", refreshEnabled));
    textarea?.addEventListener("input", refreshEnabled);
    refreshEnabled();

    document.getElementById("agent24-question-cancel").onclick = () => closeDialog();
    continueBtn.onclick = () => {
      const selected = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
      const reason = textarea ? textarea.value.trim() : "";
      const wantAlt = document.getElementById("agent24-want-alt").checked;
      submitAnswer(selected, reason, wantAlt);
    };
    focusFirst();
  }

  // ---- Investigating screen (20-40s typical, up to ~120s) -------------------------------------------------

  let investigatingTimer = null;
  const INVESTIGATING_LINES = [
    "예산을 확인하고 있어요",
    "비슷한 상품을 찾고 있어요",
    "이전 구매 이력을 살펴보고 있어요",
    "가격을 비교하고 있어요",
  ];

  function renderInvestigatingScreen() {
    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · 자율 조사 진행 중</p>
      <h2 id="agent24-title">플래닝 모드</h2>
      <p id="agent24-investigating-line">${INVESTIGATING_LINES[0]}</p>
      <p class="agent24-hint" id="agent24-investigating-elapsed">0초 경과</p>
    `;
    let elapsed = 0;
    let lineIndex = 0;
    investigatingTimer = setInterval(() => {
      elapsed += 1;
      const elapsedEl = document.getElementById("agent24-investigating-elapsed");
      if (elapsedEl) elapsedEl.textContent = `${elapsed}초 경과`;
      if (elapsed % 6 === 0) {
        lineIndex = (lineIndex + 1) % INVESTIGATING_LINES.length;
        const lineEl = document.getElementById("agent24-investigating-line");
        if (lineEl) lineEl.textContent = INVESTIGATING_LINES[lineIndex];
      }
    }, 1000);
  }

  function stopInvestigatingTimer() {
    if (investigatingTimer) {
      clearInterval(investigatingTimer);
      investigatingTimer = null;
    }
  }

  async function submitAnswer(selectedOptionIds, reason, wantAlternatives) {
    renderInvestigatingScreen();
    let result;
    try {
      result = await callBackend(
        `/api/case/${wizard.caseId}/answer`,
        { selected_option_ids: selectedOptionIds, reason, want_alternatives: wantAlternatives },
        130000,
      );
    } catch {
      stopInvestigatingTimer();
      renderStaticFallback();
      return;
    }
    stopInvestigatingTimer();
    renderVerdictScreen(result);
  }

  // ---- Verdict screen -------------------------------------------------

  const VERDICT_LABELS = { PASS: "통과", WARN: "주의", HOLD: "보류", STRONG_HOLD: "강력 보류" };
  const CLAIM_STATUS_LABELS = {
    supported: "확인됨",
    refuted: "반박됨",
    unverifiable: "확인불가",
    unverified: "미확인",
  };

  function renderVerdictScreen(result) {
    const verdict = result.verdict || "PASS";
    const savings = result.savings || {};

    // 판정 근거는 항목 이름만 보여준다. 점수는 표기하지 않는다.
    // 다크패턴 항목은 화면에서 제외한다(탐지·채점은 백엔드에서 계속 이루어진다).
    const breakdownHtml = (result.breakdown || [])
      .filter((b) => b.key !== "dark_pattern_detected")
      .map((b) => `<p class="agent24-score-item">· ${escapeAttr(b.label)}</p>`)
      .join("");

    const claimsHtml = (result.claims || [])
      .map(
        (c) => `
      <p class="agent24-claim">· [${escapeAttr(c.type)}] ${escapeAttr(c.text)} → <b>${CLAIM_STATUS_LABELS[c.status] || c.status}</b></p>
    `,
      )
      .join("");

    const holdHtml =
      verdict === "HOLD" || verdict === "STRONG_HOLD"
        ? `<p class="agent24-hold-notice">재검토 예약: ${escapeAttr(result.release_at || "")} — 이 시각이 되면 입력 없이 스스로 다시 확인합니다.</p>`
        : "";

    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · 규칙 엔진 판정</p>
      <p class="agent24-verdict-badge agent24-verdict-${verdict}">${VERDICT_LABELS[verdict] || verdict}</p>
      <p>${escapeAttr(result.summary || "")}</p>
      ${result.capped_reason ? `<p class="agent24-hint">${escapeAttr(result.capped_reason)}</p>` : ""}
      ${claimsHtml ? `<div class="agent24-claims"><p class="agent24-section-title">주장 분해</p>${claimsHtml}</div>` : ""}
      ${breakdownHtml ? `<div class="agent24-breakdown"><p class="agent24-section-title">판정 근거</p>${breakdownHtml}</div>` : ""}
      <p class="agent24-savings">
        안 사면 ₩${(savings.not_buying_saves ?? 0).toLocaleString()} 절약
        ${savings.cheaper_saves ? ` · 더 싼 곳으로 바꾸면 ₩${savings.cheaper_saves.toLocaleString()} 절약` : ""}
        ${savings.work_hours_saved ? ` · 노동 ${savings.work_hours_saved.toFixed(1)}시간` : ""}
      </p>
      ${result.follow_up_question ? `<p class="agent24-followup">${escapeAttr(result.follow_up_question)}</p>` : ""}
      ${holdHtml}
      ${result.agent_error ? `<p class="agent24-hint">일부 조사에 실패했지만 확인된 정보만으로 판정했습니다.</p>` : ""}
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-verdict-accept">판정 수용</button>
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-verdict-override">그래도 지금 구매</button>
      </div>
    `;

    document.getElementById("agent24-verdict-accept").onclick = async () => {
      await resolveCase("accept");
      if (verdict === "PASS" || verdict === "WARN") {
        proceedWithOriginal();
      } else {
        closeDialog();
      }
    };
    document.getElementById("agent24-verdict-override").onclick = async () => {
      await resolveCase("override");
      proceedWithOriginal();
    };
    focusFirst();
  }

  async function resolveCase(action, reason = "") {
    try {
      await callBackend(`/api/case/${wizard.caseId}/resolve`, { action, reason }, 8000);
    } catch {
      // Even if logging the resolution fails, still honor the user's choice at the call site.
    }
  }

  // ---- Interception (unchanged) -------------------------------------------------

  function interceptClick(event) {
    if (isBypassActive()) {
      return;
    }

    const control = getInteractiveControl(event.target);
    if (!control) {
      return;
    }

    if (allowedControls.has(control)) {
      allowedControls.delete(control);
      if (control.form instanceof HTMLFormElement) {
        allowedForms.add(control.form);
      }
      return;
    }

    if (!isPaymentControl(control)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    resumeAction = () => replayControl(control);
    openDialog();
    renderProductConfirmScreen();
  }

  function interceptSubmit(event) {
    if (isBypassActive()) {
      return;
    }

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    if (allowedForms.has(form)) {
      allowedForms.delete(form);
      return;
    }

    if (!formLooksLikePayment(event.submitter)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    resumeAction = () => replayForm(form, event.submitter);
    openDialog();
    renderProductConfirmScreen();
  }

  function replayControl(control) {
    if (!control.isConnected) {
      return;
    }
    allowedControls.add(control);
    control.click();
  }

  function replayForm(form, submitter) {
    if (!form.isConnected) {
      return;
    }
    allowedForms.add(form);
    form.requestSubmit(submitter || undefined);
  }

  fireObserveOnce();

  document.addEventListener("click", interceptClick, true);
  document.addEventListener("submit", interceptSubmit, true);
  document.addEventListener("keydown", handleKeydown, true);
})();
