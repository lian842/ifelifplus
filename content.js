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
  let wizard = null; // { caseId, items, currentIndex, decisions }
  let initialReason = "";
  let activeBudget = null;

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
    return `<svg viewBox="0 0 340 340" aria-hidden="true"><circle fill="#D4D4D4" cx="170" cy="170" r="104"/><path transform="rotate(-40 107 140)" fill="#F5823A" d="M107 140L140.96 122.96L150.2 157.04Z"/></svg>`;
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
    stopInvestigatingTimer();
    dialogElements.root.hidden = true;
    document.documentElement.classList.remove("agent24-dialog-open");
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
    resumeAction = null;
    wizard = null;
    initialReason = "";
    activeBudget = null;
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
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function caseProgressHtml() {
    if (!wizard || wizard.items.length <= 1) return "";
    const item = wizard.items[wizard.currentIndex];
    return `
      <p class="agent24-hint">
        상품 ${wizard.currentIndex + 1}/${wizard.items.length} · ${escapeAttr(item.name)}
        ${item.quantity > 1 ? ` · ${item.quantity}개` : ""}
      </p>
    `;
  }

  function nextActionLabel(finalLabel) {
    return wizard && wizard.currentIndex < wizard.items.length - 1
      ? "다음 상품 판단"
      : finalLabel;
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
    return { remaining: 820000, monthlyFreeBudget: 820000 };
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
    dialogElements.dialog.dataset.mood = "waiting";
    const [items, budget] = await Promise.all([readCheckoutItems(), loadActiveBudget()]);
    if (!items.length) {
      renderExtractionFailure();
      return;
    }

    activeBudget = budget;
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
          <p class="agent24-concept-label">이번 달 여유금액 · ${formatWon(budget.remaining)}</p>
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
    wizard = { caseId: null, items, cases: [], decisions: [] };
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

    dialogElements.dialog.dataset.mood = "calm";
    dialogElements.screen.innerHTML = `
      <div class="agent24-batch-interview">
        <p class="agent24-kicker">한 번만 답해주세요</p>
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
      .map((entry) => {
        const result = entry.final;
        const verdict = result.verdict || "WARN";
        const reasons = (result.breakdown || [])
          .filter((item) => item.key !== "dark_pattern_detected")
          .map((item) => `<li>${escapeAttr(item.label)}</li>`)
          .join("");
        return `
          <article class="agent24-batch-feedback-card">
            <div>
              <span class="agent24-verdict-badge agent24-verdict-${verdict}">${VERDICT_LABELS[verdict] || verdict}</span>
              <strong>${escapeAttr(entry.item.name)}</strong>
            </div>
            <p>${escapeAttr(result.summary || "확인된 소비 조건을 다시 살펴보세요.")}</p>
            ${reasons ? `<ul>${reasons}</ul>` : ""}
          </article>`;
      })
      .join("");
    const hasHold = flagged.some((entry) =>
      ["HOLD", "STRONG_HOLD"].includes(entry.final.verdict),
    );

    dialogElements.dialog.dataset.mood = hasHold ? "tight" : "calm";
    dialogElements.screen.innerHTML = `
      <div class="agent24-batch-feedback">
        <p class="agent24-kicker">전체 상품 분석 완료</p>
        <h1 id="agent24-title">다시 볼 상품만 모았어요</h1>
        <p class="agent24-hint">문제가 확인되지 않은 상품은 제외했습니다.</p>
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
      renderBlockedCartScreen(
        holds.map((entry) => ({ name: entry.item.name, verdict: entry.final.verdict })),
      );
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

  async function startCurrentCase() {
    const item = wizard.items[wizard.currentIndex];
    const name = item.name;
    const price = Number(item.price) * Number(item.quantity || 1);
    dialogElements.dialog.dataset.mood = "thinking";
    dialogElements.screen.innerHTML = `
      <div class="agent24-analysis-wrap">
        <p class="agent24-kicker">가격과 조건을 맞춰보는 중</p>
        <h1 id="agent24-title">더 나은 선택을<br>살펴보고 있어요</h1>
        <p class="agent24-analysis-line">상품 정보를 정리하고 있어요</p>
      </div>`;
    const laterLabelTimer = setTimeout(() => {
      if (dialogElements?.screen) {
        const line = dialogElements.screen.querySelector(".agent24-analysis-line");
        if (line) line.textContent = "소비 기록과 예산을 함께 보고 있어요";
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

    wizard.caseId = result.case_id;

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
      ${caseProgressHtml()}
      <p>${escapeAttr(result.message || "판단할 근거가 없어 결제를 막지 않습니다.")}</p>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-parsefail-continue">${nextActionLabel("계속")}</button>
      </div>
    `;
    document.getElementById("agent24-parsefail-continue").onclick = () =>
      completeCurrentCase("accept", false, "PASS");
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
      ${caseProgressHtml()}
      <p>${escapeAttr(result.mode_reason || "")}</p>
      ${renderBudgetBlock(result.budget)}
      ${priceHtml}
      ${renderOffersBlock(
        { offers: pc.offers, not_buying_saves: result.budget?.product_price ?? 0 },
        { summary: pc.structural_alternative },
      )}
      ${pc.note ? `<p class="agent24-hint">${escapeAttr(pc.note)}</p>` : ""}
      ${result.agent_error ? `<p class="agent24-hint">일부 조사에 실패했지만 확인된 정보만으로 안내합니다.</p>` : ""}
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-priceonly-cancel">취소</button>
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-priceonly-buy">${nextActionLabel("결제하기")}</button>
      </div>
    `;

    document.getElementById("agent24-priceonly-cancel").onclick = () => closeDialog();
    document.getElementById("agent24-priceonly-buy").onclick = async () => {
      await completeCurrentCase("accept", false, "PASS");
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

    const optionsHtml = q.format === "choice"
      ? `<div class="agent24-options">${q.options.map((opt) => `
          <label class="agent24-option">
            <input type="radio" name="agent24-option" value="${escapeAttr(opt.id)}" />
            <span>${escapeAttr(opt.label)}</span><i>→</i>
          </label>`).join("")}</div>`
      : "";

    const freeTextNeeded = q.format === "text" || q.allow_free_text;

    dialogElements.dialog.dataset.mood = "calm";
    dialogElements.screen.innerHTML = `
      <div class="agent24-interview-wrap">
        <p class="agent24-kicker">짧은 인터뷰</p>
        <h1 id="agent24-title">${escapeAttr(q.text)}</h1>
        ${optionsHtml}
        ${freeTextNeeded ? `<div class="agent24-prompt agent24-interview-prompt">
          <textarea id="agent24-reason" rows="1" maxlength="220" placeholder="${escapeAttr(q.free_text_placeholder || "조금 더 알려주세요")}">${escapeAttr(initialReason)}</textarea>
        </div>` : ""}
        <button type="button" class="agent24-main-action" id="agent24-question-continue" disabled>더 나은 선택 찾아보기 <span>→</span></button>
        <button type="button" class="agent24-quiet-action" id="agent24-question-cancel">그냥 구매할게요</button>
      </div>`;

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
    textarea?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!continueBtn.disabled) continueBtn.click();
    });
    refreshEnabled();

    document.getElementById("agent24-question-cancel").onclick = () => closeDialog();
    continueBtn.onclick = () => {
      const selected = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
      const reason = textarea ? textarea.value.trim() : "";
      submitAnswer(selected, reason, true);
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
    dialogElements.dialog.dataset.mood = "thinking";
    dialogElements.screen.innerHTML = `
      <div class="agent24-analysis-wrap">
        <p class="agent24-kicker">당신에게 맞는 조건을 보는 중</p>
        <h1 id="agent24-title">더 나은 선택을<br>살펴보고 있어요</h1>
        <article class="agent24-tip-card">
          <div><span>지금 확인하는 것</span><em id="agent24-investigating-elapsed">0초</em></div>
          <h2 id="agent24-investigating-line">${INVESTIGATING_LINES[0]}</h2>
          <p>가격뿐 아니라 실제 구매 조건과 지금의 여유금액을 함께 확인해요.</p>
        </article>
      </div>`;
    let elapsed = 0;
    let lineIndex = 0;
    investigatingTimer = setInterval(() => {
      elapsed += 1;
      const elapsedEl = document.getElementById("agent24-investigating-elapsed");
      if (elapsedEl) elapsedEl.textContent = `${elapsed}초`;
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

  // 확인된 판매처를 링크와 함께 보여준다.
  // 링크 없는 가격은 사용자가 확인할 방법이 없어 아무 소용이 없다.
  // 못 찾았으면 못 찾았다고 말한다 — 현재 가격이 최저가라고 단정하지 않는다.
  function renderOffersBlock(savings, alternative) {
    const offers = savings?.offers || [];
    const altText = alternative?.summary ? escapeAttr(alternative.summary) : "";

    if (!offers.length) {
      return `
        <p class="agent24-hint">
          다른 판매처를 확인하지 못했습니다. 현재 가격이 최저가라고 단정하지는 않습니다.
        </p>
        ${altText ? `<p class="agent24-hint">${altText}</p>` : ""}
      `;
    }

    const rows = offers
      .map((o) => {
        const price = Number(o.price) || 0;
        const cheaper = price > 0 && price < (savings.not_buying_saves ?? 0);
        return `
        <p class="agent24-offer${cheaper ? " agent24-offer-cheaper" : ""}">
          <b>₩${price.toLocaleString()}</b> · ${escapeAttr(o.seller || "판매처 미상")}
          ${o.url ? ` <a href="${escapeAttr(o.url)}" target="_blank" rel="noreferrer">바로가기</a>` : ""}
          ${o.note ? ` <span class="agent24-offer-note">${escapeAttr(o.note)}</span>` : ""}
        </p>`;
      })
      .join("");

    return `
      <div class="agent24-offers">
        <p class="agent24-section-title">대안</p>
        ${rows}
        ${altText ? `<p class="agent24-offer-note">${altText}</p>` : ""}
      </div>
    `;
  }

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
      ${caseProgressHtml()}
      <p>${escapeAttr(result.summary || "")}</p>
      ${result.capped_reason ? `<p class="agent24-hint">${escapeAttr(result.capped_reason)}</p>` : ""}
      ${claimsHtml ? `<div class="agent24-claims"><p class="agent24-section-title">주장 분해</p>${claimsHtml}</div>` : ""}
      ${breakdownHtml ? `<div class="agent24-breakdown"><p class="agent24-section-title">판정 근거</p>${breakdownHtml}</div>` : ""}
      <p class="agent24-savings">
        안 사면 ₩${(savings.not_buying_saves ?? 0).toLocaleString()} 절약
        ${savings.cheaper_saves ? ` · 더 싼 곳으로 바꾸면 ₩${savings.cheaper_saves.toLocaleString()} 절약` : ""}
        ${savings.annual_saving ? ` · 대안으로 바꾸면 연간 ₩${savings.annual_saving.toLocaleString()}` : ""}
        ${savings.work_hours_saved ? ` · 노동 ${savings.work_hours_saved.toFixed(1)}시간` : ""}
      </p>
      ${renderOffersBlock(savings, result.alternative)}
      ${holdHtml}
      ${result.agent_error ? `<p class="agent24-hint">일부 조사에 실패했지만 확인된 정보만으로 판정했습니다.</p>` : ""}
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-verdict-accept">판정 수용</button>
        <button type="button" class="agent24-button agent24-button-secondary" id="agent24-verdict-override">그래도 지금 구매</button>
      </div>
    `;

    document.getElementById("agent24-verdict-accept").onclick = async () => {
      const blocksCheckout = verdict === "HOLD" || verdict === "STRONG_HOLD";
      await completeCurrentCase("accept", blocksCheckout, verdict);
    };
    document.getElementById("agent24-verdict-override").onclick = async () => {
      await completeCurrentCase("override", false, verdict);
    };
    focusFirst();
  }

  async function completeCurrentCase(action, blocksCheckout, verdict) {
    const item = wizard.items[wizard.currentIndex];
    wizard.decisions.push({
      caseId: wizard.caseId,
      action,
      blocksCheckout,
      verdict,
      name: item.name,
    });

    if (wizard.currentIndex < wizard.items.length - 1) {
      wizard.currentIndex += 1;
      await startCurrentCase();
      return;
    }

    const blocked = wizard.decisions.filter((decision) => decision.blocksCheckout);
    if (blocked.length) {
      for (const decision of blocked) {
        await resolveCase(decision.action, "", decision.caseId);
      }
      renderBlockedCartScreen(blocked);
      return;
    }

    for (const decision of wizard.decisions) {
      await resolveCase(decision.action, "", decision.caseId);
    }
    proceedWithOriginal();
  }

  function renderBlockedCartScreen(blocked) {
    dialogElements.screen.innerHTML = `
      <p class="agent24-label">AGENT24 · 전체 상품 판단 완료</p>
      <h2 id="agent24-title">결제를 진행하지 않았습니다</h2>
      <p>다음 상품의 보류 판정을 수용했어요.</p>
      <div class="agent24-claims">
        ${blocked
          .map(
            (decision) =>
              `<p class="agent24-claim">· ${escapeAttr(decision.name)} — ${VERDICT_LABELS[decision.verdict] || decision.verdict}</p>`,
          )
          .join("")}
      </div>
      <p class="agent24-hint">장바구니에서 해당 상품을 제외한 뒤 다시 결제해 주세요.</p>
      <div class="agent24-actions">
        <button type="button" class="agent24-button agent24-button-primary" id="agent24-cart-close">확인</button>
      </div>
    `;
    document.getElementById("agent24-cart-close").onclick = () => closeDialog();
    focusFirst();
  }

  async function resolveCase(action, reason = "", caseId = wizard.caseId) {
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
