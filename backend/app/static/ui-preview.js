(() => {
  "use strict";

  const mark = `
    <svg viewBox="0 0 340 340" aria-hidden="true">
      <circle fill="#D4D4D4" cx="170" cy="170" r="104"/>
      <g class="agent24-eye-orbit"><g transform="rotate(-40 107 140)">
        <path class="agent24-mark-eye" fill="#F5823A" d="M107 140L140.96 122.96L150.2 157.04Z"/>
      </g></g>
    </svg>`;

  const arrowButton = `<button type="button" aria-label="계속" disabled><span>→</span></button>`;
  const ticker = `
    <span>Skyworth FHD FAST IPS 180Hz 게이밍 모니터 · 109,000원</span>
    <span>녹스 게이밍 헤드셋 NX-502 · 37,900원</span>`;

  function contextScreen(kind) {
    const state = {
      remaining: { amount: "13,640", message: "이 구매 후에는 이만큼만 남아요" },
      zero: { amount: "0", message: "이 구매로 이번 달 여유금액을 모두 써요" },
      shortage: { amount: "131,360", message: "이 구매에는 이만큼 더 필요해요" },
    }[kind];
    return `
      <div class="agent24-context">
        <section class="agent24-balance">
          <p class="agent24-concept-label">이번 달 여유금액 · 160,540원</p>
          <h1 id="agent24-title"><span class="agent24-amount-number">${state.amount}</span><span class="agent24-amount-unit">원</span></h1>
          <p class="agent24-concept-result"><strong>${state.message}</strong></p>
        </section>
        <div class="agent24-purchase-line"><div class="agent24-purchase-track">
          <div class="agent24-purchase-group">${ticker}</div><div class="agent24-purchase-group" aria-hidden="true">${ticker}</div>
        </div></div>
        <div class="agent24-prompt"><textarea rows="1" placeholder="이 구매, 어떤 마음에서 시작됐나요?"></textarea>${arrowButton}</div>
        <button type="button" class="agent24-quiet-action">그냥 구매할게요</button>
      </div>`;
  }

  const screens = {
    "context-remaining": () => contextScreen("remaining"),
    "context-zero": () => contextScreen("zero"),
    "context-shortage": () => contextScreen("shortage"),
    loading: () => `
      <div class="agent24-analysis-wrap">
        <p class="agent24-kicker">장바구니 전체 분석</p>
        <h1 id="agent24-title">모든 상품을<br>함께 살펴보고 있어요</h1>
        <p class="agent24-analysis-line">답변과 소비 기록을 한 번에 비교하고 있어요</p>
        <article class="agent24-tip-card" data-agent24-financial-tips>
          <div class="agent24-tip-slide">
            <div class="agent24-tip-meta"><span>20대를 위한 경제 팁</span><em>청약</em></div>
            <h2>청약 공고는 관심 지역별 알림으로 묶어두세요.</h2>
            <p>공급 공고와 자격 기준은 수시로 달라져요. 관심 지역의 공식 알림을 켜두면 준비할 시간을 확보할 수 있어요.</p>
            <small>청약홈</small>
          </div>
        </article>
      </div>`,
    interview: () => `
      <div class="agent24-batch-interview">
        <h1 id="agent24-title">상품별로 짧게 확인할게요</h1>
        <div class="agent24-batch-question-list">
          <section class="agent24-batch-question">
            <p class="agent24-batch-product">Skyworth FHD FAST IPS 180Hz 게이밍 모니터</p>
            <h2>이번 구매를 결정한 이유는?</h2>
            <div class="agent24-options">
              <label class="agent24-option"><input type="radio" name="preview-a"><span>기존 제품이 고장 나서</span><i>→</i></label>
              <label class="agent24-option"><input type="radio" name="preview-a" checked><span>업무·게임 환경을 개선하려고</span><i>→</i></label>
              <label class="agent24-option"><input type="radio" name="preview-a"><span>지금 가격이 좋아서</span><i>→</i></label>
            </div>
          </section>
          <section class="agent24-batch-question">
            <p class="agent24-batch-product">녹스 게이밍 헤드셋 NX-502</p>
            <h2>지금 이 제품이 필요한 가장 큰 이유는?</h2>
            <div class="agent24-options">
              <label class="agent24-option"><input type="radio" name="preview-b" checked><span>음질과 마이크 개선</span><i>→</i></label>
              <label class="agent24-option"><input type="radio" name="preview-b"><span>기존 장비 문제</span><i>→</i></label>
              <label class="agent24-option"><input type="radio" name="preview-b"><span>7.1채널 기능</span><i>→</i></label>
            </div>
          </section>
        </div>
        <button type="button" class="agent24-main-action">한 번에 분석하기 <span>→</span></button>
        <button type="button" class="agent24-quiet-action">그냥 구매할게요</button>
      </div>`,
    result: () => `
      <div class="agent24-batch-feedback">
        <h1 id="agent24-title">잠깐, 2개 상품만 다시 볼까요?</h1>
        <p class="agent24-hint">나머지는 특별한 문제를 찾지 못했어요.</p>
        <div class="agent24-batch-feedback-list">
          <article class="agent24-batch-feedback-card">
            <div class="agent24-feedback-card-head"><strong>Skyworth FHD FAST IPS 180Hz 게이밍 모니터</strong><span class="agent24-verdict-badge">강력 보류</span></div>
            <p>현재 보유 제품의 고장 여부가 확인되지 않았고, 이번 달 여유금액보다 구매 부담이 커요.</p>
            <details><summary>판단 근거 3개</summary><ul><li>이번 달 자유 예산 초과</li><li>가격·희소성 주장 검증 실패</li><li>구체적인 사용 시점 제시</li></ul></details>
          </article>
          <article class="agent24-batch-feedback-card">
            <div class="agent24-feedback-card-head"><strong>녹스 게이밍 헤드셋 NX-502</strong><span class="agent24-verdict-badge">강력 보류</span></div>
            <p>최근 동일 모델 구매 기록이 있어 현재 보유·사용 여부를 먼저 확인하는 편이 좋아요.</p>
            <details><summary>판단 근거 2개</summary><ul><li>최근 30일 내 유사 구매</li><li>예정 지출 반영 후 잔액 부족</li></ul></details>
          </article>
        </div>
        <div class="agent24-actions"><button type="button" class="agent24-button agent24-button-primary">추천대로 멈추기</button><button type="button" class="agent24-button agent24-button-secondary">그래도 모두 구매</button></div>
      </div>`,
    "extraction-error": () => `
      <div class="agent24-empty">
        <p class="agent24-kicker">상품 정보를 읽지 못했어요</p>
        <h1 id="agent24-title">확인되지 않은 금액으로<br>판단하지 않을게요.</h1>
        <button type="button" class="agent24-main-action">다시 확인 <span>→</span></button>
        <button type="button" class="agent24-quiet-action">그냥 구매할게요</button>
      </div>`,
    "backend-error": () => `
      <div class="agent24-empty agent24-fallback">
        <p class="agent24-kicker">연결이 잠시 늦어지고 있어요</p>
        <h1 id="agent24-title">분석을 이어가지<br>못했어요.</h1>
        <p class="agent24-fallback-copy">구매 판단을 대신 만들지 않고, 확인된 화면으로 돌아갈게요.</p>
        <button type="button" class="agent24-main-action">다시 확인 <span>→</span></button>
        <button type="button" class="agent24-quiet-action">그냥 구매할게요</button>
      </div>`,
  };

  const params = new URLSearchParams(location.search);
  const screen = params.get("screen") || "context-shortage";
  const render = screens[screen] || screens["context-shortage"];
  const mood = screen === "loading" ? "thinking" : screen === "context-shortage" ? "negative" : "calm";
  const brandState = screen === "loading" ? "thinking" : "restored";
  const brandCopy = screen === "context-remaining" || screen === "context-zero" || screen === "context-shortage"
    ? "현명한 소비를 도와드려요" : "현명한 소비를 도와드릴게요";

  document.getElementById("preview-root").innerHTML = `
    <div id="agent24-purchase-guard" class="agent24-preview">
      <div class="agent24-backdrop"></div>
      <section class="agent24-dialog" data-mood="${mood}" data-brand-state="${brandState}">
        <div class="agent24-atmosphere" aria-hidden="true"><i></i><i></i></div>
        <div class="agent24-brand" aria-hidden="true"><div class="agent24-float">${mark}</div><span>${brandCopy}</span></div>
        <button class="agent24-icon-button" type="button" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
        <main class="agent24-main" id="agent24-screen">${render()}</main>
      </section>
    </div>`;
})();
