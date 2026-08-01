(() => {
  "use strict";

  const ROOT_ID = "agent24-purchase-guard";
  const BACKEND_URL = "http://localhost:8787";
  const { findSite, matchesPath, matchesPaymentText } = globalThis.Agent24Sites;
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

  const VERDICT_LABELS = {
    PASS: "문제 없음",
    WARN: "한 번 더 확인",
    HOLD: "잠시 보류",
    STRONG_HOLD: "강력 보류",
  };

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
  let brandRestoreTimer = null;
  let resumeAction = null;
  let previouslyFocused = null;
  let wizard = null; // { items, cases }
  let initialReason = "";

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

  function formatWon(value) {
    return `${new Intl.NumberFormat("ko-KR").format(Number(value) || 0)}원`;
  }

  function formatBalanceAmount(value) {
    const number = new Intl.NumberFormat("ko-KR").format(Math.abs(Number(value) || 0));
    return `<span class="agent24-amount-number">${number}</span><span class="agent24-amount-unit">원</span>`;
  }

  function lianMark() {
    return `<svg viewBox="0 0 340 340" aria-hidden="true"><rect width="340" height="340" rx="72" fill="#fffdf8"/><circle fill="#D4D4D4" cx="170" cy="170" r="104"/><path transform="rotate(-40 107 140)" fill="#F5823A" d="M107 140L140.96 122.96L150.2 157.04Z"/></svg>`;
  }

  function lianBareMark() {
    return `<svg viewBox="0 0 340 340" aria-hidden="true"><circle fill="#D4D4D4" cx="170" cy="170" r="104"/><g class="agent24-eye-orbit"><g transform="rotate(-40 107 140)"><path class="agent24-mark-eye" fill="#F5823A" d="M107 140L140.96 122.96L150.2 157.04Z"/></g></g></svg>`;
  }

  function enterBrandThinking() {
    clearTimeout(brandRestoreTimer);
    dialogElements.dialog.dataset.brandState = "thinking";
  }

  function restoreBrand() {
    const copy = dialogElements.dialog.querySelector(".agent24-brand span");
    if (copy) copy.textContent = "현명한 소비를 도와드릴게요";
    dialogElements.dialog.dataset.brandState = "returning";
    clearTimeout(brandRestoreTimer);
    brandRestoreTimer = setTimeout(() => {
      if (dialogElements?.dialog) dialogElements.dialog.dataset.brandState = "restored";
    }, 760);
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
      <div class="agent24-backdrop"></div>
      <div class="agent24-intro-logo" aria-hidden="true">${lianMark()}</div>
      <section class="agent24-dialog" role="dialog" aria-modal="true" aria-labelledby="agent24-title">
        <div class="agent24-atmosphere" aria-hidden="true"><i></i><i></i></div>
        <div class="agent24-brand" aria-hidden="true">
          <div class="agent24-float">${lianBareMark()}</div>
          <span>현명한 소비를 도와드려요</span>
        </div>
        <button class="agent24-icon-button" type="button" data-agent24-dismiss aria-label="닫기">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
        </button>
        <main class="agent24-main" id="agent24-screen"></main>
        <div class="agent24-live" aria-live="polite" aria-atomic="true"></div>
      </section>`;

    root.querySelector("[data-agent24-dismiss]").addEventListener("click", () => closeDialog());
    document.documentElement.append(root);

    dialogElements = {
      root,
      dialog: root.querySelector(".agent24-dialog"),
      screen: root.querySelector("#agent24-screen"),
      live: root.querySelector(".agent24-live"),
    };
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
    initialReason = "";
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
  const BYPASS_WINDOW_MS = 10 * 1000;
  const CART_ITEMS_KEY = "agent24_coupang_cart_items";
  const CART_ITEMS_TTL_MS = 10 * 60 * 1000;

  function isCartPage() {
    return Boolean(
      currentSite.cartPaths &&
        matchesPath(currentSite.cartPaths, location.href, location.href),
    );
  }

  function isCartCheckoutControl(control) {
    return Boolean(
      isCartPage() &&
        currentSite.cartCheckoutSelector &&
        control?.matches(currentSite.cartCheckoutSelector),
    );
  }

  async function saveCartItems(control) {
    const items = currentSite.scrapeCartItems?.() || [];
    if (!items.length) {
      await chrome.storage.local.remove(CART_ITEMS_KEY);
      return;
    }
    const countMatch = getControlText(control).match(/총\s*(\d+)\s*개\s*상품/);
    const itemCount = countMatch ? Number(countMatch[1]) : null;
    await chrome.storage.local.set({
      [CART_ITEMS_KEY]: { savedAt: Date.now(), itemCount, items },
    });
  }

  async function loadCartItems() {
    if (currentSite.id !== "coupang" || isCartPage()) {
      return { items: [], itemCount: null };
    }
    try {
      const stored = (await chrome.storage.local.get(CART_ITEMS_KEY))[CART_ITEMS_KEY];
      if (
        !stored ||
        Date.now() - Number(stored.savedAt) > CART_ITEMS_TTL_MS ||
        !Array.isArray(stored.items)
      ) {
        await chrome.storage.local.remove(CART_ITEMS_KEY);
        return { items: [], itemCount: null };
      }
      return {
        items: stored.items.filter(
          (item) => item?.name && Number(item.price) > 0 && Number(item.quantity) > 0,
        ),
        itemCount: Number(stored.itemCount) > 0 ? Number(stored.itemCount) : null,
      };
    } catch {
      return { items: [], itemCount: null };
    }
  }

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
    chrome.storage.local.remove(CART_ITEMS_KEY).catch(() => {});
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
    clearTimeout(brandRestoreTimer);
    dialogElements.dialog.dataset.brandState = "hidden";
    dialogElements.dialog.dataset.mood = "calm";
    dialogElements.screen.innerHTML = `
      <div class="agent24-empty agent24-fallback">
        <p class="agent24-kicker">연결이 잠시 늦어지고 있어요</p>
        <h1 id="agent24-title">분석을 이어가지<br>못했어요.</h1>
        <p class="agent24-fallback-copy">구매 판단을 대신 만들지 않고, 확인된 화면으로 돌아갈게요.</p>
        <button type="button" class="agent24-main-action" id="agent24-fallback-retry">다시 확인 <span>→</span></button>
        <button type="button" class="agent24-quiet-action" id="agent24-fallback-continue">그냥 구매할게요</button>
      </div>
    `;
    document.getElementById("agent24-fallback-retry").onclick = () => renderPurchaseContextScreen();
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
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---- /api/observe — fired once at page load, independent of the checkout click -------------------------------------------------
  // So the server can compute dwell_minutes (checkout_at - detected_at) later.
  // Fire-and-forget; failures are ignored.

  function fireObserveOnce() {
    if (isCartPage()) {
      return;
    }
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

  async function loadActiveBudget() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/profiles`);
      if (!response.ok) throw new Error(`profiles returned ${response.status}`);
      const data = await response.json();
      const profile = data.profiles?.find((candidate) => candidate.profile_id === data.default);
      if (profile) {
        return {
          remaining: Number(profile.remaining),
          monthlyFreeBudget: Number(profile.monthly_free_budget),
        };
      }
    } catch {
      // The visual shell remains usable with demo memory while the local backend starts.
    }
    return { remaining: 160540, monthlyFreeBudget: 300000 };
  }

  async function readCheckoutItems() {
    const { items: cartItems } = await loadCartItems();
    if (cartItems.length) return cartItems;

    try {
      const item = currentSite.scrapeProduct?.();
      if (item?.name && Number(item.price) > 0) {
        return [{ name: item.name, price: Number(item.price), quantity: 1 }];
      }
    } catch {
      // The explicit error state below is safer than inventing a checkout amount.
    }
    return [];
  }

  function renderExtractionFailure() {
    clearTimeout(brandRestoreTimer);
    dialogElements.dialog.dataset.brandState = "hidden";
    dialogElements.dialog.dataset.mood = "waiting";
    dialogElements.screen.innerHTML = `
      <div class="agent24-empty">
        <p class="agent24-kicker">상품 정보를 읽지 못했어요</p>
        <h1 id="agent24-title">확인되지 않은 금액으로<br>판단하지 않을게요.</h1>
        <button type="button" class="agent24-main-action" id="agent24-extraction-retry">다시 확인 <span>→</span></button>
        <button type="button" class="agent24-quiet-action" id="agent24-extraction-continue">그냥 구매할게요</button>
      </div>`;
    document.getElementById("agent24-extraction-retry").onclick = () => renderPurchaseContextScreen();
    document.getElementById("agent24-extraction-continue").onclick = () => proceedWithOriginal();
    focusFirst();
  }

  async function renderPurchaseContextScreen() {
    clearTimeout(brandRestoreTimer);
    const brandCopy = dialogElements.dialog.querySelector(".agent24-brand span");
    if (brandCopy) brandCopy.textContent = "현명한 소비를 도와드려요";
    delete dialogElements.dialog.dataset.brandState;
    dialogElements.dialog.dataset.mood = "waiting";
    const [items, budget] = await Promise.all([readCheckoutItems(), loadActiveBudget()]);
    if (!items.length) {
      renderExtractionFailure();
      return;
    }

    const total = items.reduce(
      (sum, item) => sum + Number(item.price) * Number(item.quantity || 1),
      0,
    );
    const after = budget.remaining - total;
    const balanceMessage = after < 0
      ? "이 구매에는 이만큼 더 필요해요"
      : after === 0
        ? "이 구매로 이번 달 여유금액을 모두 써요"
        : "이 구매 후에는 이만큼만 남아요";
    const ticker = items
      .map((item) => `<span>${escapeAttr(item.name)} · ${formatWon(Number(item.price) * Number(item.quantity || 1))}</span>`)
      .join("");

    dialogElements.dialog.dataset.mood = after < 0
      ? "negative"
      : after < budget.remaining * 0.25
        ? "tight"
        : "calm";
    dialogElements.dialog.dataset.balance = after < 0
      ? "shortage"
      : after === 0
        ? "zero"
        : "remaining";
    dialogElements.screen.innerHTML = `
      <div class="agent24-context">
        <section class="agent24-balance">
          <p class="agent24-concept-label">이번 달 여유금액: ${formatWon(budget.remaining)}</p>
          <h1 id="agent24-title" aria-label="${formatWon(Math.abs(after))}">${formatBalanceAmount(after)}</h1>
          <p class="agent24-concept-result"><strong>${balanceMessage}</strong></p>
        </section>
        <div class="agent24-purchase-line" aria-label="구매 상품과 가격">
          <div class="agent24-purchase-track">
            <div class="agent24-purchase-group">${ticker}</div>
            <div class="agent24-purchase-group" aria-hidden="true">${ticker}</div>
          </div>
        </div>
        <div class="agent24-prompt">
          <textarea id="agent24-initial-reason" rows="1" maxlength="220" aria-label="구매 이유" placeholder="왜 이 상품을 사고 싶나요?"></textarea>
          <button type="button" id="agent24-start-case" aria-label="계속" disabled><span>→</span></button>
        </div>
        <button type="button" class="agent24-quiet-action" id="agent24-context-continue">그냥 구매할게요</button>
      </div>`;

    const reason = document.getElementById("agent24-initial-reason");
    const start = document.getElementById("agent24-start-case");
    reason.addEventListener("input", () => {
      start.disabled = reason.value.trim().length === 0;
    });
    reason.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!start.disabled) start.click();
    });
    start.onclick = () => {
      initialReason = reason.value.trim();
      if (initialReason) beginCaseQueue(items);
    };
    document.getElementById("agent24-context-continue").onclick = () => proceedWithOriginal();
    focusFirst();
  }


  async function beginCaseQueue(items) {
    wizard = { items, cases: [] };
    renderBatchThinkingScreen("상품별 질문을 준비하고 있어요");

    const { page_text, dom_signals } = collectSignals();
    try {
      wizard.cases = await Promise.all(
        items.map(async (item) => {
          const result = await callBackend(
            "/api/case",
            {
              profile_id: "B",
              product: {
                name: item.name,
                price: Number(item.price) * Number(item.quantity || 1),
                category: guessCategory(item.name),
              },
              page_text,
              dom_signals,
              payment_method_bnpl: false,
            },
            130000,
          );
          return { item, caseId: result.case_id, initial: result };
        }),
      );
    } catch {
      renderStaticFallback();
      return;
    }

    const challenges = wizard.cases.filter(
      (entry) => !entry.initial.parse_failed && entry.initial.mode !== "price_only",
    );
    if (challenges.length) {
      renderBatchQuestionScreen(challenges);
    } else {
      await submitBatchAnswers();
    }
  }

  function renderBatchThinkingScreen(line) {
    enterBrandThinking();
    dialogElements.dialog.dataset.mood = "thinking";
    dialogElements.screen.innerHTML = `
      <div class="agent24-analysis-wrap">
        <p class="agent24-kicker">장바구니 전체 분석</p>
        <h1 id="agent24-title">모든 상품을<br>함께 살펴보고 있어요</h1>
        <p class="agent24-analysis-line">${escapeAttr(line)}</p>
      </div>`;
  }

  function renderBatchQuestionScreen(challenges) {
    const questionsHtml = challenges
      .map((entry, index) => {
        const q = entry.initial.question || {
          format: "text",
          text: "이 상품을 사는 이유는 무엇인가요?",
          options: [],
          allow_free_text: true,
          free_text_placeholder: "짧게 알려주세요",
        };
        const optionsHtml =
          q.format === "choice"
            ? `<div class="agent24-options">${q.options
                .map(
                  (option) => `
                    <label class="agent24-option">
                      <input type="radio" name="agent24-option-${index}" value="${escapeAttr(option.id)}" />
                      <span>${escapeAttr(option.label)}</span><i>→</i>
                    </label>`,
                )
                .join("")}</div>`
            : "";
        const freeTextNeeded = q.format === "text" || q.allow_free_text;
        return `
          <section class="agent24-batch-question" data-agent24-case-id="${escapeAttr(entry.caseId)}">
            <p class="agent24-batch-product">${escapeAttr(entry.item.name)}</p>
            <h2>${escapeAttr(q.text)}</h2>
            ${optionsHtml}
            ${
              freeTextNeeded
                ? `<textarea data-agent24-batch-reason rows="1" maxlength="160" placeholder="${escapeAttr(q.free_text_placeholder || "짧게 알려주세요")}">${escapeAttr(initialReason)}</textarea>`
                : ""
            }
          </section>`;
      })
      .join("");

    restoreBrand();
    dialogElements.dialog.dataset.mood = "calm";
    dialogElements.screen.innerHTML = `
      <div class="agent24-batch-interview">
        <h1 id="agent24-title">상품별로 짧게 확인할게요</h1>
        <div class="agent24-batch-question-list">${questionsHtml}</div>
        <button type="button" class="agent24-main-action" id="agent24-batch-submit" disabled>한 번에 분석하기 <span>→</span></button>
        <button type="button" class="agent24-quiet-action" id="agent24-batch-cancel">그냥 구매할게요</button>
      </div>`;

    const submit = document.getElementById("agent24-batch-submit");
    const rows = Array.from(
      dialogElements.screen.querySelectorAll("[data-agent24-case-id]"),
    );
    const refreshBatchSubmit = () => {
      submit.disabled = rows.some((row) => {
        const selected = row.querySelector('input[type="radio"]:checked');
        const reason = row.querySelector("[data-agent24-batch-reason]");
        return !selected && !reason?.value.trim();
      });
    };
    rows.forEach((row) => {
      row.querySelectorAll('input[type="radio"]').forEach((input) =>
        input.addEventListener("change", refreshBatchSubmit),
      );
      row
        .querySelector("[data-agent24-batch-reason]")
        ?.addEventListener("input", refreshBatchSubmit);
    });
    refreshBatchSubmit();

    document.getElementById("agent24-batch-cancel").onclick = () => proceedWithOriginal();
    submit.onclick = () => submitBatchAnswers();
    focusFirst();
  }

  async function submitBatchAnswers() {
    const answerRows = new Map(
      Array.from(dialogElements.screen.querySelectorAll("[data-agent24-case-id]")).map(
        (row) => [row.dataset.agent24CaseId, row],
      ),
    );
    renderBatchThinkingScreen("답변과 소비 기록을 한 번에 비교하고 있어요");

    try {
      await Promise.all(
        wizard.cases.map(async (entry) => {
          if (entry.initial.parse_failed || entry.initial.mode === "price_only") {
            entry.final = entry.initial;
            return;
          }
          const row = answerRows.get(entry.caseId);
          const selectedOptionIds = row
            ? Array.from(row.querySelectorAll('input[type="radio"]:checked')).map(
                (input) => input.value,
              )
            : [];
          const reason =
            row?.querySelector("[data-agent24-batch-reason]")?.value.trim() ||
            initialReason;
          entry.final = await callBackend(
            `/api/case/${entry.caseId}/answer`,
            { selected_option_ids: selectedOptionIds, reason, want_alternatives: true },
            130000,
          );
        }),
      );
    } catch {
      renderStaticFallback();
      return;
    }

    const flagged = wizard.cases.filter(
      (entry) => entry.final?.verdict && entry.final.verdict !== "PASS",
    );
    if (!flagged.length) {
      await resolveBatchCases(false);
      return;
    }
    renderBatchFeedbackScreen(flagged);
  }

  function renderBatchFeedbackScreen(flagged) {
    const cardsHtml = flagged
      .map((entry, index) => {
        const result = entry.final;
        const verdict = result.verdict || "WARN";
        return `
          <article class="agent24-batch-feedback-card">
            <div class="agent24-feedback-card-head">
              <strong>${escapeAttr(entry.item.name)}</strong>
              <span class="agent24-verdict-badge agent24-verdict-${verdict}">${VERDICT_LABELS[verdict] || verdict}</span>
            </div>
            <div class="agent24-feedback-summary">
              <p id="agent24-feedback-summary-${index}">${escapeAttr(result.summary || "확인된 소비 조건을 다시 살펴보세요.")}</p>
              <button type="button" aria-expanded="false" aria-controls="agent24-feedback-summary-${index}" hidden>더 보기</button>
            </div>
          </article>`;
      })
      .join("");
    const hasHold = flagged.some((entry) =>
      ["HOLD", "STRONG_HOLD"].includes(entry.final.verdict),
    );

    restoreBrand();
    dialogElements.dialog.dataset.mood = hasHold ? "tight" : "calm";
    dialogElements.screen.innerHTML = `
      <div class="agent24-batch-feedback">
        <h1 id="agent24-title">잠깐, ${flagged.length}개 상품만 다시 볼까요?</h1>
        <p class="agent24-hint">나머지는 특별한 문제를 찾지 못했어요.</p>
        <div class="agent24-batch-feedback-list">${cardsHtml}</div>
        <div class="agent24-actions">
          <button type="button" class="agent24-button agent24-button-primary" id="agent24-batch-accept">${hasHold ? "추천대로 멈추기" : "확인하고 결제하기"}</button>
          <button type="button" class="agent24-button agent24-button-secondary" id="agent24-batch-override">그래도 모두 구매</button>
        </div>
      </div>`;

    document.getElementById("agent24-batch-accept").onclick = () =>
      resolveBatchCases(hasHold);
    document.getElementById("agent24-batch-override").onclick = () =>
      resolveBatchCases(false, true);
    requestAnimationFrame(() => {
      dialogElements.screen.querySelectorAll(".agent24-feedback-summary").forEach((summary) => {
        const copy = summary.querySelector("p");
        const toggle = summary.querySelector("button");
        if (!copy || !toggle || copy.scrollHeight <= copy.clientHeight + 1) return;
        toggle.hidden = false;
        toggle.onclick = () => {
          const expanded = summary.classList.toggle("is-expanded");
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.textContent = expanded ? "접기" : "더 보기";
        };
      });
    });
    focusFirst();
  }

  async function resolveBatchCases(blockCheckout, overrideFlagged = false) {
    const flagged = wizard.cases.filter(
      (entry) => entry.final?.verdict && entry.final.verdict !== "PASS",
    );
    const holds = flagged.filter((entry) =>
      ["HOLD", "STRONG_HOLD"].includes(entry.final.verdict),
    );

    if (blockCheckout) {
      await Promise.all(holds.map((entry) => resolveCase("accept", "", entry.caseId)));
      closeDialog();
      return;
    }

    await Promise.all(
      wizard.cases.map((entry) =>
        resolveCase(
          overrideFlagged && entry.final?.verdict !== "PASS" ? "override" : "accept",
          "",
          entry.caseId,
        ),
      ),
    );
    proceedWithOriginal();
  }

  async function resolveCase(action, reason = "", caseId) {
    try {
      await callBackend(`/api/case/${caseId}/resolve`, { action, reason }, 8000);
    } catch {
      // Even if logging the resolution fails, still honor the user's choice at the call site.
    }
  }

  // ---- Interception (unchanged) -------------------------------------------------

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

    if (isCartCheckoutControl(control)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      saveCartItems(control)
        .catch(() => {})
        .finally(() => replayControl(control));
      return;
    }

    if (isBypassActive()) {
      return;
    }

    if (!isPaymentControl(control)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    resumeAction = () => replayControl(control);
    openDialog();
    renderPurchaseContextScreen();
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
    renderPurchaseContextScreen();
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
