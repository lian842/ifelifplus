(() => {
  "use strict";

  const ROOT_ID = "agent24-purchase-guard";
  const { findSite, matchesPaymentText } = globalThis.Agent24Sites;
  const currentSite = findSite(location.hostname);

  if (!currentSite) {
    return;
  }

  const allowedControls = new WeakSet();
  const allowedForms = new WeakSet();

  let dialogElements = null;
  let resumeAction = null;
  let previouslyFocused = null;

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
          <h2 id="agent24-title">잠깐, 정말 결제할까요?</h2>
          <p id="agent24-description">
            지금 결제를 완료하려고 해요. 결제를 취소하거나 확인 후 계속 진행할 수 있어요.
          </p>
          <div class="agent24-actions">
            <button type="button" class="agent24-button agent24-button-primary" data-agent24-cancel>
              결제 취소
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

    const { onContinue } = options;
    const dialog = buildDialog();

    resumeAction = onContinue || null;
    previouslyFocused = document.activeElement;
    dialog.root.hidden = false;
    document.documentElement.classList.add("agent24-dialog-open");
    requestAnimationFrame(() => dialog.primaryButton.focus());
  }

  function closeDialog(shouldContinue) {
    if (!dialogElements || dialogElements.root.hidden) {
      return;
    }

    const action = shouldContinue ? resumeAction : null;
    dialogElements.root.hidden = true;
    document.documentElement.classList.remove("agent24-dialog-open");
    resumeAction = null;

    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
    previouslyFocused = null;

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
    openDialog({ onContinue: () => replayControl(control) });
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
    openDialog({ onContinue: () => replayForm(form, event.submitter) });
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
})();
