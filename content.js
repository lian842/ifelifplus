(() => {
  "use strict";

  const ROOT_ID = "agent24-purchase-guard";
  const BACKEND_URL = "http://localhost:8000";
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
  let wizard = null; // { sessionId }

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

  // ---- Dialog shell -------------------------------------------------

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
    dialogElements.root.hidden = true;
    document.documentElement.classList.remove("agent24-dialog-open");
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
    resumeAction = null;
    wizard = null;
  }

  function proceedWithOriginal() {
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

  // ---- Static fallback (used if the backend is unreachable at any point) -------------------------------------------------

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

  // ---- Backend calls (short timeout, fall back to static on any failure) -------------------------------------------------

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
      await startCheckout(name, price);
    };
    focusFirst();
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;");
  }

  async function startCheckout(name, price) {
    dialogElements.screen.innerHTML = `<p>확인하는 중입니다...</p>`;
    let result;
    try {
      result = await callBackend(
        "/api/checkout",
        {
          product_name: name,
          price,
          category: guessCategory(name),
          timestamp: new Date().toISOString(),
        },
        8000,
      );
    } catch {
      renderStaticFallback();
      return;
    }
    wizard = { sessionId: result.session_id };
    renderInfoScreen(result);
  }

  // ---- Screen 1: budget info + reason -------------------------------------------------

  function renderInfoScreen(result) {
    const b = result.budget;
    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · ${currentSite.name}</p>
      <h2 id="agent24-title">결제 전 확인</h2>
      <p>${escapeAttr(result.message)}</p>
      <p class="agent24-budget">이번 달 자유소비 예산 ₩${b.monthly_budget.toLocaleString()} 중 이 결제는 ${b.purchase_pct_of_budget}%를 차지합니다. 결제 후 남는 돈: ₩${b.remaining_budget_after.toLocaleString()}</p>
      <label class="agent24-field">왜 지금 이 결제가 필요하신가요?
        <textarea id="agent24-reason" rows="2" placeholder="간단히 적어주세요"></textarea>
      </label>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-info-cancel">취소</button>
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-info-continue" disabled>계속</button>
      </div>
    `;
    const textarea = document.getElementById("agent24-reason");
    const continueBtn = document.getElementById("agent24-info-continue");
    textarea.addEventListener("input", () => {
      continueBtn.disabled = textarea.value.trim().length < 2;
    });
    document.getElementById("agent24-info-cancel").onclick = () => closeDialog();
    continueBtn.onclick = () => submitReason(textarea.value.trim());
    focusFirst();
  }

  async function submitReason(reason) {
    dialogElements.screen.innerHTML = `<p>확인하는 중입니다...</p>`;
    let interpretation;
    try {
      interpretation = await callBackend(`/api/checkout/${wizard.sessionId}/reason`, { reason }, 8000);
    } catch {
      renderStaticFallback();
      return;
    }
    renderOfferScreen(interpretation);
  }

  // ---- Screen 2: offer alternative -------------------------------------------------

  function renderOfferScreen(interpretation) {
    dialogElements.screen.innerHTML = `
      <p class="agent24-label">이유: ${escapeAttr(interpretation.reason_summary)}</p>
      <p>${escapeAttr(interpretation.offer_message)}</p>
      <p class="agent24-offer-prompt">${escapeAttr(interpretation.offer_prompt)}</p>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-offer-no">아니요</button>
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-offer-yes">예, 보여주세요</button>
      </div>
    `;
    document.getElementById("agent24-offer-yes").onclick = () => chooseAlternative(true);
    document.getElementById("agent24-offer-no").onclick = () => chooseAlternative(false);
    focusFirst();
  }

  async function chooseAlternative(wantAlternative) {
    if (wantAlternative) {
      dialogElements.screen.innerHTML = `<p>대안을 찾는 중입니다 (실시간 웹검색)...</p>`;
    }
    let result;
    try {
      result = await callBackend(
        `/api/checkout/${wizard.sessionId}/alternatives`,
        { want_alternative: wantAlternative },
        25000,
      );
    } catch {
      renderStaticFallback();
      return;
    }
    renderResolutionScreen(result);
  }

  // ---- Screen 3: alternatives + final resolution -------------------------------------------------

  function renderResolutionScreen(result) {
    const savings = result.savings_if_no_purchase.amount;
    let altHtml = "";
    if (result.planning_used && result.alternatives.length) {
      altHtml = `
        <p class="agent24-alt-source">대안 출처: ${result.source === "web_search" ? "실시간 웹검색" : result.source}</p>
        <div class="agent24-alt-cards">
          ${result.alternatives
            .map(
              (alt, i) => `
            <div class="agent24-alt-card">
              <p class="agent24-alt-name">${escapeAttr(alt.name)}</p>
              <p class="agent24-alt-price">₩${alt.price != null ? alt.price.toLocaleString() : "?"}</p>
              <p class="agent24-alt-note">${escapeAttr(alt.note)}</p>
              ${alt.savings_vs_original != null ? `<p class="agent24-alt-savings">이걸로 하면 ₩${alt.savings_vs_original.toLocaleString()} 절약</p>` : ""}
              <p class="agent24-alt-disclaimer">정보 제공용이며 자동으로 구매되지 않습니다.</p>
              <button type="button" class="agent24-button agent24-button-secondary agent24-alt-buy-btn" data-index="${i}" data-url="${alt.source_url || ""}">이 대안으로 이동</button>
            </div>
          `,
            )
            .join("")}
        </div>
      `;
    }

    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · ${currentSite.name}</p>
      <h2 id="agent24-title">최종 선택</h2>
      <p>지금 사지 않으면 ₩${savings.toLocaleString()}을 아낄 수 있어요.</p>
      ${altHtml}
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-resolve-cancel">결제 취소</button>
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-resolve-original">그래도 원래 상품 결제</button>
      </div>
    `;

    document.getElementById("agent24-resolve-original").onclick = () => resolveSession("buy_original");
    document.getElementById("agent24-resolve-cancel").onclick = () => resolveSession("cancel");
    dialogElements.screen.querySelectorAll(".agent24-alt-buy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.url;
        if (url) window.open(url, "_blank");
        resolveSession("buy_alternative", Number(btn.dataset.index));
      });
    });
    focusFirst();
  }

  async function resolveSession(decision, alternativeIndex) {
    try {
      await callBackend(
        `/api/checkout/${wizard.sessionId}/resolve`,
        { decision, alternative_index: alternativeIndex ?? null },
        8000,
      );
    } catch {
      // Even if logging the resolution fails, still honor the user's choice below.
    }

    if (decision === "buy_original") {
      proceedWithOriginal();
    } else {
      closeDialog();
    }
  }

  // ---- Interception -------------------------------------------------

  function interceptClick(event) {
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

  document.addEventListener("click", interceptClick, true);
  document.addEventListener("submit", interceptSubmit, true);
  document.addEventListener("keydown", handleKeydown, true);
})();
