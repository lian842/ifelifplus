(function initializeAgent24Sites(root, factory) {
  const api = factory();
  root.Agent24Sites = api;

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const KOREAN_PAYMENT_WORDS =
    /(결제하기|결제\s*및\s*주문|주문\s*및\s*결제|주문\s*확정)/;
  const KOREAN_ORDER_WORDS =
    /(배달\s*주문하기|포장\s*주문하기|주문하기|주문\s*확인)/;

  const sites = [
    {
      id: "coupang",
      name: "쿠팡",
      hostname: /(^|\.)coupang\.com$/i,
      checkoutPaths: [
        /\/order\/orderSheet\.pang$/i,
        /\/order\/checkout(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      cartPaths: [/\/cartView\.pang$/i],
      cartCheckoutSelector: "a#btnPay.goPayment[role='button']",
      // Deliberately the shared KOREAN_PAYMENT_WORDS (NOT extended with
      // "바로구매") — "바로구매" on the product page is intentionally let
      // through untouched. The wizard should trigger exactly once, on the
      // order-sheet page's final "결제하기" button, not on the product
      // page too (that caused the wizard to show twice for the same
      // checkout). "구매하기"/"주문하기" stay excluded for the same reason
      // as before (pre-checkout navigation wording — see
      // tests/sites.test.js "allows checkout navigation wording...").
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: [],
      // Verified against a real coupang product page (2026-08-01):
      // document.title carries the product name ("<name> - 쿠팡!" pattern),
      // and the price sits inside an element whose class contains
      // "price-container" (seen as "price-container price-container-v2" —
      // matching on the substring rather than the exact modifier keeps this
      // working across that versioning). When a discounted price is shown
      // alongside the original, both numbers appear in the same container;
      // the discounted one is always the smaller number, so take the min.
      scrapeProduct() {
        const name = document.title.replace(/\s*-\s*쿠팡!?\s*$/, "").trim();
        const container = document.querySelector('[class*="price-container"]');
        let price = null;
        if (container) {
          const numbers = [...container.textContent.matchAll(/([\d,]+)\s*원/g)].map((m) =>
            Number(m[1].replace(/,/g, "")),
          );
          if (numbers.length) price = Math.min(...numbers);
        }
        return { name: name || null, price };
      },
      // Verified against Coupang's cart DOM (2026-08-02). Start from each
      // selected product checkbox and stop at the first ancestor containing
      // that product's price and quantity, so names and prices never get
      // paired by their unrelated page-wide order.
      scrapeCartItems() {
        const seenRows = new Set();
        const seenProducts = new Set();
        return Array.from(
          document.querySelectorAll('input[type="checkbox"][title]:checked'),
        ).flatMap((checkbox) => {
          let row = checkbox.parentElement;
          let levels = 0;
          while (
            row &&
            levels < 6 &&
            !(
              row.querySelector('[data-component-id="price-area"]') &&
              row.querySelector(".cart-quantity-input") &&
              row.querySelectorAll('[data-component-id="price-area"]').length === 1
            )
          ) {
            row = row.parentElement;
            levels += 1;
          }
          if (!row || levels >= 6) return [];
          if (seenRows.has(row)) return [];
          seenRows.add(row);

          const priceArea = row.querySelector('[data-component-id="price-area"]');
          const priceSpans = Array.from(priceArea.querySelectorAll("span"));
          const splitPriceNode = priceSpans.find((span) => {
            const value = span.textContent?.trim() || "";
            const unit = span.nextElementSibling?.textContent?.trim() || "";
            return /^[\d,]+$/.test(value) && unit === "원";
          });
          const combinedPriceNode = priceSpans.find((span) => {
            const value = span.textContent?.trim() || "";
            return (
              /^[\d,]+\s*원$/.test(value) &&
              !span.classList?.contains("twc-line-through") &&
              !span.closest?.(".twc-line-through")
            );
          });
          const priceText =
            splitPriceNode?.textContent || combinedPriceNode?.textContent || "";
          const price = Number(priceText.replace(/[^\d]/g, ""));
          const quantity = Number(row.querySelector(".cart-quantity-input")?.value) || 1;
          const name = checkbox.getAttribute("title")?.trim();
          const productHref = row
            .querySelector('a[href*="/vp/products/"]')
            ?.getAttribute("href");
          const productKey = `${productHref || name}|${price}|${quantity}`;

          if (!name || price <= 0 || seenProducts.has(productKey)) return [];
          seenProducts.add(productKey);
          return [{ name, price, quantity }];
        });
      },
    },
    {
      id: "musinsa",
      name: "무신사",
      hostname: /(^|\.)musinsa\.com$/i,
      checkoutPaths: [
        /\/order\/order_form\/?$/i,
        /\/order\/order-form\/?$/i,
        /\/order\/checkout(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: [],
    },
    {
      id: "29cm",
      name: "29CM",
      hostname: /(^|\.)29cm\.co\.kr$/i,
      checkoutPaths: [
        /\/order\/?$/i,
        /\/order\/(?:checkout|order-form|order_form|form|payment)(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: [],
    },
    {
      id: "11st",
      name: "11번가",
      hostname: /(^|\.)11st\.co\.kr$/i,
      checkoutPaths: [/\/pay\/OrderInfoAction\.tmall$/i],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: ["button#btnAccount.btn_order"],
      // Verified against 11st's real order sheet (2026-08-02). The final
      // payable amount is #FinalOrderPrice, while each product name is linked
      // from .prd_name. This scraper deliberately accepts exactly one product:
      // the supplied DOM does not expose a verified per-item price/quantity
      // pairing yet, so treating a multi-product total as one item's price
      // would produce a false analysis.
      scrapeProduct() {
        const productLinks = Array.from(
          document.querySelectorAll('.prd_name a[href*="/products/"]'),
        );
        if (productLinks.length !== 1) return { name: null, price: null };

        const link = productLinks[0];
        const logBody = link.getAttribute("data-log-body") || "";
        const loggedName = logBody.match(
          /["']product_name["']\s*:\s*["']([^"']+)["']/,
        )?.[1];
        const directText = Array.from(link.childNodes || [])
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent?.trim() || "")
          .filter(Boolean)
          .join(" ");
        const name = (loggedName || directText).trim();
        const priceText =
          document.querySelector("#FinalOrderPrice")?.textContent || "";
        const price = Number(priceText.replace(/[^\d]/g, ""));

        return {
          name: name || null,
          price: price > 0 ? price : null,
        };
      },
    },
    {
      id: "amazon",
      name: "Amazon",
      hostname: /(^|\.)amazon\.com$/i,
      checkoutPaths: [
        /\/checkout(?:\/|$)/i,
        /\/hz\/checkout(?:\/|$)/i,
        /\/gp\/buy(?:\/|$)/i,
        /\/buy\/checkout(?:\/|$)/i,
      ],
      paymentWords: /(place\s+(?:your\s+)?order|submit\s+order)/i,
      paymentSelectors: [
        "#placeYourOrder",
        "#placeYourOrder input",
        "#placeYourOrder button",
        "#submitOrderButtonId",
        "#submitOrderButtonId input",
        "#submitOrderButtonId button",
        "input[name='placeYourOrder']",
        "input[name='placeYourOrder1']",
        "[data-testid='place-your-order-action']",
      ],
    },
    {
      id: "kream",
      name: "KREAM",
      hostname: /(^|\.)kream\.co\.kr$/i,
      checkoutPaths: [
        /\/buy(?:\/|$)/i,
        /\/purchase(?:\/|$)/i,
        /\/order(?:\/|$)/i,
        /\/checkout(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: /(구매하기|주문하기)/,
      paymentSelectors: [],
    },
    {
      id: "coupangeats",
      name: "쿠팡이츠",
      hostname: /^web\.coupangeats\.com$/i,
      checkoutPaths: [
        /\/checkout(?:\/|$)/i,
        /\/order\/(?:confirm|checkout|payment)(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: [],
    },
    {
      id: "baemin",
      name: "배달의민족",
      hostname: /^order(?:-next)?\.baemin\.com$/i,
      checkoutPaths: [/^\/$/i, /^\/quick\/?$/i, /^\/family\/?$/i],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: [],
    },
    {
      id: "yogiyo",
      name: "요기요",
      hostname: /^(www\.)?yogiyo\.co\.kr$/i,
      checkoutPaths: [
        /\/checkout\/?$/i,
        /\/order\/(?:checkout|payment)(?:\/|$)/i,
        /\/payment(?:\/|$)/i,
      ],
      paymentWords: KOREAN_PAYMENT_WORDS,
      checkoutPaymentWords: KOREAN_ORDER_WORDS,
      paymentSelectors: [],
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

  function matchesPaymentText(site, text, url, baseUrl) {
    if (site.paymentWords.test(text)) {
      return true;
    }

    return Boolean(
      site.checkoutPaymentWords &&
        matchesPath(site.checkoutPaths, url, baseUrl) &&
        site.checkoutPaymentWords.test(text),
    );
  }

  return { findSite, matchesPath, matchesPaymentText, sites };
});
