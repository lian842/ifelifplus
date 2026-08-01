(() => {
  "use strict";

  const ROOT_ID = "agent24-purchase-guard";
  const { findSite, matchesPath } = globalThis.Agent24Sites;
  const currentSite = findSite(location.hostname);

  if (!currentSite) {
    return;
  }

  const BYPASS_KEY = `agent24CheckoutBypassUntil:${currentSite.id}`;

  const allowedControls = new WeakSet();
  const allowedForms = new WeakSet();

  let dialogElements = null;
  let resumeAction = null;
  let cancelAction = null;
  let previouslyFocused = null;
  let lastObservedUrl = location.href;
  let routeCheckInProgress = false;

  function matchesCurrentPath(patterns, url = location.href) {
    return matchesPath(patterns, url, location.href);
  }

  function isTriggerPage() {
    return matchesCurrentPath(currentSite.triggerPaths);
  }

  function isCheckoutPage() {
    return matchesCurrentPath(currentSite.checkoutPaths);
  }

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

  function isCheckoutControl(control) {
    if (!control || control.closest(`#${ROOT_ID}`)) {
      return false;
    }

    const matchesSelector = currentSite.checkoutSelectors.some((selector) =>
      control.matches(selector),
    );
    const href = control.getAttribute("href");
    const linksToCheckout =
      href && matchesCurrentPath(currentSite.checkoutPaths, href);

    return (
      matchesSelector ||
      linksToCheckout ||
      currentSite.checkoutWords.test(getControlText(control))
    );
  }

  function formLooksLikeCheckout(form, submitter) {
    const action = form.getAttribute("action") || "";
    return (
      matchesCurrentPath(currentSite.checkoutPaths, action) ||
      isCheckoutControl(submitter)
    );
  }

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
        aria-describedby="agent24-description"
      >
        <div class="agent24-accent" aria-hidden="true"></div>
        <div class="agent24-content">
          <p class="agent24-label">AGENT24 · ${currentSite.name}</p>
          <h2 id="agent24-title">잠깐, 결제하려는 게 맞나요?</h2>
          <p id="agent24-description">
            ${currentSite.description}
          </p>
          <div class="agent24-actions">
            <button type="button" class="agent24-button agent24-button-primary" data-agent24-cancel>
              ${currentSite.cancelLabel}
            </button>
            <button type="button" class="agent24-button agent24-button-secondary" data-agent24-continue>
              그래도 계속
            </button>
          </div>
        </div>
      </section>
    `;

    root.querySelectorAll("[data-agent24-cancel]").forEach((element) => {
      element.addEventListener("click", () => closeDialog(false));
    });
    root
      .querySelector("[data-agent24-continue]")
      .addEventListener("click", () => closeDialog(true));

    document.documentElement.append(root);

    dialogElements = {
      root,
      primaryButton: root.querySelector(".agent24-button-primary"),
      continueButton: root.querySelector("[data-agent24-continue]"),
    };

    return dialogElements;
  }

  function openDialog(options = {}) {
    if (!document.documentElement) {
      document.addEventListener("readystatechange", () => openDialog(options), {
        once: true,
      });
      return;
    }

    const { onContinue, onCancel } = options;
    const dialog = buildDialog();

    resumeAction = onContinue || null;
    cancelAction = onCancel || null;
    previouslyFocused = document.activeElement;
    dialog.root.hidden = false;
    document.documentElement.classList.add("agent24-dialog-open");
    requestAnimationFrame(() => dialog.primaryButton.focus());
  }

  async function armCheckoutBypass() {
    const expiresAt = Date.now() + 30_000;
    await chrome.storage.local.set({ [BYPASS_KEY]: expiresAt });
  }

  async function consumeCheckoutBypass() {
    const stored = await chrome.storage.local.get(BYPASS_KEY);
    const expiresAt = Number(stored[BYPASS_KEY] || 0);

    if (expiresAt > Date.now()) {
      await chrome.storage.local.remove(BYPASS_KEY);
      return true;
    }

    if (expiresAt) {
      await chrome.storage.local.remove(BYPASS_KEY);
    }
    return false;
  }

  async function closeDialog(shouldContinue) {
    if (!dialogElements || dialogElements.root.hidden) {
      return;
    }

    const action = shouldContinue ? resumeAction : cancelAction;
    dialogElements.root.hidden = true;
    document.documentElement.classList.remove("agent24-dialog-open");
    resumeAction = null;
    cancelAction = null;

    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
    previouslyFocused = null;

    if (shouldContinue) {
      await armCheckoutBypass();
    }

    action?.();
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

  function interceptClick(event) {
    if (!isTriggerPage() && !currentSite.controlAnywhere) {
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

    if (!isCheckoutControl(control)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    openDialog({ onContinue: () => replayControl(control) });
  }

  function interceptSubmit(event) {
    if (!isTriggerPage() && !currentSite.controlAnywhere) {
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

    if (!formLooksLikeCheckout(form, event.submitter)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    openDialog({ onContinue: () => replayForm(form, event.submitter) });
  }

  function returnToShopping() {
    if (history.length > 1) {
      history.back();
      return;
    }
    location.assign(currentSite.returnUrl);
  }

  async function guardCheckoutRoute() {
    if (!isCheckoutPage() || routeCheckInProgress) {
      return;
    }

    routeCheckInProgress = true;
    try {
      if (await consumeCheckoutBypass()) {
        return;
      }

      openDialog({
        onContinue: () => {},
        onCancel: returnToShopping,
      });
    } finally {
      routeCheckInProgress = false;
    }
  }

  function handleKeydown(event) {
    if (!dialogElements || dialogElements.root.hidden) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog(false);
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = [dialogElements.primaryButton, dialogElements.continueButton];
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex - 1 + focusable.length) % focusable.length
      : (currentIndex + 1) % focusable.length;

    event.preventDefault();
    focusable[nextIndex].focus();
  }

  document.addEventListener("click", interceptClick, true);
  document.addEventListener("submit", interceptSubmit, true);
  document.addEventListener("keydown", handleKeydown, true);

  guardCheckoutRoute();
  window.setInterval(() => {
    if (location.href === lastObservedUrl) {
      return;
    }
    lastObservedUrl = location.href;
    guardCheckoutRoute();
  }, 500);
})();
