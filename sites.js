(function initializeAgent24Sites(root, factory) {
  const api = factory();
  root.Agent24Sites = api;

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const sites = [
    {
      id: "coupang",
      name: "쿠팡",
      hostname: /(^|\.)coupang\.com$/i,
      triggerPaths: [/\/cartView\.pang$/i, /\/cart(?:\/|$)/i],
      checkoutPaths: [
        /\/order\/orderSheet\.pang$/i,
        /\/order\/checkout(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      checkoutWords: /(구매하기|주문하기|결제하기)/,
      checkoutSelectors: [],
      returnUrl: "https://www.coupang.com/cartView.pang",
      cancelLabel: "장바구니로 돌아가기",
      description:
        "지금 결제 화면으로 이동하려고 해요. 장바구니로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "musinsa",
      name: "무신사",
      hostname: /(^|\.)musinsa\.com$/i,
      triggerPaths: [
        /\/order\/cart\/?$/i,
        /\/app\/cart\/?$/i,
        /\/cart\/?$/i,
      ],
      checkoutPaths: [
        /\/order\/order_form\/?$/i,
        /\/order\/order-form\/?$/i,
        /\/order\/checkout(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      checkoutWords: /(구매하기|주문하기|결제하기)/,
      checkoutSelectors: [],
      returnUrl: "https://www.musinsa.com/order/cart",
      cancelLabel: "장바구니로 돌아가기",
      description:
        "지금 주문서로 이동하려고 해요. 장바구니로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "29cm",
      name: "29CM",
      hostname: /(^|\.)29cm\.co\.kr$/i,
      triggerPaths: [/\/order\/cart\/?$/i, /\/cart\/?$/i],
      checkoutPaths: [
        /\/order\/?$/i,
        /\/order\/(?:checkout|order-form|order_form|form|payment)(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      checkoutWords: /(구매하기|주문하기|결제하기)/,
      checkoutSelectors: [],
      returnUrl: "https://www.29cm.co.kr/order/cart",
      cancelLabel: "장바구니로 돌아가기",
      description:
        "지금 주문서로 이동하려고 해요. 장바구니로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "amazon",
      name: "Amazon",
      hostname: /(^|\.)amazon\.com$/i,
      triggerPaths: [
        /\/gp\/cart\/view\.html$/i,
        /\/gp\/aw\/c(?:\/|$)/i,
        /\/cart(?:\/|$)/i,
      ],
      checkoutPaths: [
        /\/checkout(?:\/|$)/i,
        /\/hz\/checkout(?:\/|$)/i,
        /\/gp\/buy(?:\/|$)/i,
        /\/buy\/checkout(?:\/|$)/i,
      ],
      checkoutWords:
        /(proceed\s+to\s+checkout|go\s+to\s+checkout|checkout|place\s+your\s+order)/i,
      checkoutSelectors: [
        "#sc-buy-box-ptc-button input",
        "#sc-buy-box-ptc-button button",
        "input[name='proceedToRetailCheckout']",
        "input[name='proceedToCheckout']",
        "[data-feature-id='proceed-to-checkout-action']",
      ],
      returnUrl: "https://www.amazon.com/gp/cart/view.html",
      cancelLabel: "장바구니로 돌아가기",
      description:
        "지금 Amazon 결제 화면으로 이동하려고 해요. 장바구니로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "kream",
      name: "KREAM",
      hostname: /(^|\.)kream\.co\.kr$/i,
      triggerPaths: [/\/products\/\d+(?:\/|$)/i],
      checkoutPaths: [
        /\/buy(?:\/|$)/i,
        /\/purchase(?:\/|$)/i,
        /\/order(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      checkoutWords: /(즉시\s*구매(?:하기)?|구매\s*입찰|결제하기)/,
      checkoutSelectors: [],
      controlAnywhere: true,
      returnUrl: "https://kream.co.kr/",
      cancelLabel: "상품으로 돌아가기",
      description:
        "지금 구매 절차를 계속하려고 해요. 상품으로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "coupangeats",
      name: "쿠팡이츠",
      hostname: /^web\.coupangeats\.com$/i,
      triggerPaths: [
        /\/cart(?:\/|$)/i,
        /\/basket(?:\/|$)/i,
        /\/order(?:\/|$)/i,
      ],
      checkoutPaths: [
        /\/checkout(?:\/|$)/i,
        /\/order\/(?:confirm|checkout|payment)(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      checkoutWords:
        /(배달\s*주문하기|포장\s*주문하기|주문하기|결제하기|주문\s*확인)/,
      checkoutSelectors: [],
      controlAnywhere: true,
      returnUrl: "https://web.coupangeats.com/",
      cancelLabel: "메뉴로 돌아가기",
      description:
        "지금 음식 주문을 계속하려고 해요. 메뉴로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "baemin",
      name: "배달의민족",
      hostname: /^order(?:-next)?\.baemin\.com$/i,
      triggerPaths: [],
      checkoutPaths: [/^\/$/i, /^\/quick\/?$/i, /^\/family\/?$/i],
      checkoutWords: /(주문하기|결제하기|주문\s*확인)/,
      checkoutSelectors: [],
      returnUrl: "https://www.baemin.com/",
      cancelLabel: "메뉴로 돌아가기",
      description:
        "지금 배달 주문서로 이동하려고 해요. 메뉴로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
    {
      id: "yogiyo",
      name: "요기요",
      hostname: /^(www\.)?yogiyo\.co\.kr$/i,
      triggerPaths: [/\/cart\/?$/i],
      checkoutPaths: [
        /\/checkout\/?$/i,
        /\/order\/(?:checkout|payment)(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      checkoutWords: /(배달\s*주문하기|포장\s*주문하기|주문하기|결제하기)/,
      checkoutSelectors: [],
      returnUrl: "https://www.yogiyo.co.kr/mobile/",
      cancelLabel: "메뉴로 돌아가기",
      description:
        "지금 요기요 결제 화면으로 이동하려고 해요. 메뉴로 돌아가거나 확인 후 계속 진행할 수 있어요.",
    },
  ];

  function findSite(hostname) {
    return sites.find((site) => site.hostname.test(hostname)) || null;
  }

  function matchesPath(patterns, url, baseUrl = "https://example.com/") {
    try {
      const parsedUrl = new URL(url, baseUrl);
      const routes = [parsedUrl.pathname];
      const hashRoute = parsedUrl.hash.slice(1).split("?")[0];

      if (hashRoute.startsWith("/")) {
        routes.push(hashRoute);
      }

      return routes.some((route) =>
        patterns.some((pattern) => pattern.test(route)),
      );
    } catch {
      return false;
    }
  }

  return { findSite, matchesPath, sites };
});
