(() => {
  "use strict";

  const ROOT_ID = "agent24-purchase-guard";
  const TIP_DURATION_MS = 6000;
  const SWIPE_OUT_MS = 280;
  const FALLBACK_TIPS = [
    {
      category: "청약",
      title: "청약 공고는 관심 지역별 알림으로 묶어두세요.",
      body: "공급 공고와 자격 기준은 수시로 달라져요. 관심 지역의 공고 알림을 켜두면 준비할 시간을 확보할 수 있어요.",
      source_label: "청약홈",
    },
    {
      category: "청년 금융",
      title: "청년 금융상품은 모집 공고를 먼저 확인해보세요.",
      body: "조건과 신청 기간이 있는 상품은 공식 공고 알림을 받아두는 편이 좋아요.",
      source_label: "서민금융진흥원 · 복지로",
    },
  ];

  let activeCard = null;
  let rotationTimer = null;
  let transitionTimer = null;
  let mountToken = 0;
  let scanScheduled = false;
  let tipsPromise = null;

  function requestTips() {
    if (tipsPromise) return tipsPromise;
    tipsPromise = new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "agent24:backend",
          method: "GET",
          path: "/api/tips?age=20&limit=3",
          timeoutMs: 5000,
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;
          const tips = !runtimeError && response?.ok && Array.isArray(response.data?.tips)
            ? response.data.tips
            : [];
          resolve(tips.length ? tips : FALLBACK_TIPS);
        },
      );
    });
    return tipsPromise;
  }

  function setTip(card, tip) {
    card.querySelector("[data-tip-category]").textContent = tip.category || "경제 습관";
    card.querySelector("[data-tip-title]").textContent = tip.title || "";
    card.querySelector("[data-tip-body]").textContent = tip.body || "";
    card.querySelector("[data-tip-source]").textContent = tip.source_label
      ? `출처 · ${tip.source_label}`
      : "";
  }

  function transitionToTip(card, tip) {
    const slide = card.querySelector(".agent24-tip-slide");
    if (!slide) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTip(card, tip);
      return;
    }

    clearTimeout(transitionTimer);
    slide.classList.add("is-leaving");
    transitionTimer = setTimeout(() => {
      if (!card.isConnected || card !== activeCard) return;
      setTip(card, tip);
      slide.classList.remove("is-leaving");
      slide.classList.add("is-entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => slide.classList.remove("is-entering"));
      });
      transitionTimer = null;
    }, SWIPE_OUT_MS);
  }

  function stopActiveTips() {
    clearInterval(rotationTimer);
    clearTimeout(transitionTimer);
    rotationTimer = null;
    transitionTimer = null;
    activeCard = null;
    mountToken += 1;
  }

  async function mountTips(analysisWrap) {
    let card = analysisWrap.querySelector("[data-agent24-financial-tips]");
    if (!card) {
      card = analysisWrap.querySelector(".agent24-tip-card") || document.createElement("article");
      card.classList.add("agent24-tip-card");
      card.dataset.agent24FinancialTips = "";
      card.setAttribute("aria-label", "20대를 위한 경제 팁");
      card.innerHTML = `
        <div class="agent24-tip-slide">
          <div class="agent24-tip-meta">
            <span>20대를 위한 경제 팁</span>
            <em data-tip-category></em>
          </div>
          <h2 data-tip-title></h2>
          <p data-tip-body></p>
          <small data-tip-source></small>
        </div>`;
      if (!card.parentElement) analysisWrap.append(card);
    }

    if (activeCard === card) return;
    stopActiveTips();
    activeCard = card;
    const token = ++mountToken;
    setTip(card, FALLBACK_TIPS[0]);

    const tips = await requestTips();
    if (token !== mountToken || card !== activeCard || !card.isConnected) return;
    let index = 0;
    setTip(card, tips[index]);
    rotationTimer = setInterval(() => {
      index = (index + 1) % tips.length;
      transitionToTip(card, tips[index]);
    }, TIP_DURATION_MS);
  }

  function scanForLoadingScreen() {
    scanScheduled = false;
    const root = document.getElementById(ROOT_ID);
    const analysisWrap = root && !root.hidden
      ? root.querySelector(".agent24-analysis-wrap")
      : null;
    if (!analysisWrap) {
      if (activeCard) stopActiveTips();
      return;
    }
    mountTips(analysisWrap);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(scanForLoadingScreen);
  }

  function observe() {
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", observe, { once: true });
      return;
    }
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    scheduleScan();
  }

  observe();
})();
