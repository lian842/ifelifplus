const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  findSite,
  matchesPath,
  matchesPaymentText,
} = require("../sites.js");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"),
);

const routeCases = [
  {
    id: "coupang",
    hostname: "www.coupang.com",
    checkout: "https://order.coupang.com/order/orderSheet.pang?item=1",
  },
  {
    id: "musinsa",
    hostname: "www.musinsa.com",
    checkout: "https://www.musinsa.com/order/order_form",
  },
  {
    id: "29cm",
    hostname: "www.29cm.co.kr",
    checkout: "https://www.29cm.co.kr/order/checkout",
  },
  {
    id: "amazon",
    hostname: "www.amazon.com",
    checkout: "https://www.amazon.com/gp/buy/spc/handlers/display.html",
  },
  {
    id: "kream",
    hostname: "kream.co.kr",
    checkout: "https://kream.co.kr/buy/547008",
  },
  {
    id: "coupangeats",
    hostname: "web.coupangeats.com",
    checkout: "https://web.coupangeats.com/checkout",
  },
  {
    id: "baemin",
    hostname: "order.baemin.com",
    checkout: "https://order.baemin.com/",
  },
  {
    id: "yogiyo",
    hostname: "www.yogiyo.co.kr",
    checkout: "https://www.yogiyo.co.kr/mobile/#/checkout/",
  },
];

test("finds every supported shopping and delivery service", () => {
  for (const routeCase of routeCases) {
    assert.equal(findSite(routeCase.hostname)?.id, routeCase.id);
  }

  assert.equal(findSite("amazon.com")?.id, "amazon");
  assert.equal(findSite("order-next.baemin.com")?.id, "baemin");
  assert.equal(findSite("notamazon.com"), null);
});

test("loads the site config before the purchase guard on every host", () => {
  const contentScript = manifest.content_scripts[0];

  assert.equal(manifest.version, "0.4.0");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(contentScript.js, ["sites.js", "content.js", "tips.js"]);
  assert.deepEqual(contentScript.css, ["styles.css", "tips.css"]);
  assert.deepEqual(contentScript.matches, [
    "https://*.coupang.com/*",
    "https://*.musinsa.com/*",
    "https://*.29cm.co.kr/*",
    "https://*.amazon.com/*",
    "https://*.kream.co.kr/*",
    "https://web.coupangeats.com/*",
    "https://order.baemin.com/*",
    "https://order-next.baemin.com/*",
    "https://www.yogiyo.co.kr/*",
    "https://yogiyo.co.kr/*",
  ]);
});

test("matches checkout routes", () => {
  for (const routeCase of routeCases) {
    const site = findSite(routeCase.hostname);
    assert.equal(matchesPath(site.checkoutPaths, routeCase.checkout), true);
  }

  const baemin = findSite("order.baemin.com");
  assert.equal(matchesPath(baemin.checkoutPaths, "https://order.baemin.com/quick"), true);
  assert.equal(matchesPath(baemin.checkoutPaths, "https://order.baemin.com/family"), true);
});

test("recognizes Coupang's verified cart route and checkout control", () => {
  const coupang = findSite("cart.coupang.com");

  assert.equal(
    matchesPath(coupang.cartPaths, "https://cart.coupang.com/cartView.pang"),
    true,
  );
  assert.equal(coupang.cartCheckoutSelector, "a#btnPay.goPayment[role='button']");
  assert.equal(typeof coupang.scrapeCartItems, "function");
});

test("scrapes a selected Coupang cart row without mixing its fields", () => {
  const coupang = findSite("cart.coupang.com");
  const priceNode = {
    textContent: "39,920",
    nextElementSibling: { textContent: "원" },
  };
  const priceArea = {
    querySelectorAll(selector) {
      assert.equal(selector, "span");
      return [{ textContent: "24%", nextElementSibling: null }, priceNode];
    },
  };
  const quantityInput = { value: "2" };
  const row = {
    querySelector(selector) {
      if (selector === '[data-component-id="price-area"]') return priceArea;
      if (selector === ".cart-quantity-input") return quantityInput;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-component-id="price-area"]' ? [priceArea] : [];
    },
  };
  const checkbox = {
    parentElement: row,
    getAttribute(name) {
      return name === "title" ? "Machenike 메카닉 L9X1" : null;
    },
  };
  const previousDocument = global.document;
  global.document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'input[type="checkbox"][title]:checked');
      return [checkbox];
    },
  };

  try {
    assert.deepEqual(coupang.scrapeCartItems(), [
      { name: "Machenike 메카닉 L9X1", price: 39920, quantity: 2 },
    ]);
  } finally {
    global.document = previousDocument;
  }
});

test("does not count duplicate responsive Coupang cart rows", () => {
  const coupang = findSite("cart.coupang.com");
  const priceNode = {
    textContent: "39,920",
    nextElementSibling: { textContent: "원" },
  };
  const priceArea = {
    querySelectorAll() {
      return [{ textContent: "24%", nextElementSibling: null }, priceNode];
    },
  };
  const row = () => ({
    querySelector(selector) {
      if (selector === '[data-component-id="price-area"]') return priceArea;
      if (selector === ".cart-quantity-input") return { value: "1" };
      if (selector === 'a[href*="/vp/products/"]') {
        return { getAttribute: () => "/vp/products/123?vendorItemId=456" };
      }
      return null;
    },
    querySelectorAll() {
      return [priceArea];
    },
  });
  const checkbox = () => ({
    parentElement: row(),
    getAttribute() {
      return "중복 렌더링 상품";
    },
  });
  const previousDocument = global.document;
  global.document = { querySelectorAll: () => [checkbox(), checkbox()] };

  try {
    assert.deepEqual(coupang.scrapeCartItems(), [
      { name: "중복 렌더링 상품", price: 39920, quantity: 1 },
    ]);
  } finally {
    global.document = previousDocument;
  }
});

test("does not confuse browsing or history routes with checkout", () => {
  const negativeCases = [
    ["www.coupang.com", "https://www.coupang.com/vp/products/123"],
    ["www.musinsa.com", "https://www.musinsa.com/mypage/orders"],
    ["www.29cm.co.kr", "https://www.29cm.co.kr/order/cart"],
    ["www.amazon.com", "https://www.amazon.com/gp/buyagain"],
    ["kream.co.kr", "https://kream.co.kr/my/buying"],
    ["web.coupangeats.com", "https://web.coupangeats.com/share?storeId=1"],
    ["order.baemin.com", "https://order.baemin.com/payment/complete/123"],
    [
      "www.yogiyo.co.kr",
      "https://www.yogiyo.co.kr/mobile/#/checkout/thankyou!!/",
    ],
  ];

  for (const [hostname, url] of negativeCases) {
    const site = findSite(hostname);
    assert.equal(matchesPath(site.checkoutPaths, url), false);
  }
});

test("matches each site's final payment wording", () => {
  assert.equal(findSite("www.coupang.com").paymentWords.test("32,000원 결제하기"), true);
  assert.equal(findSite("www.musinsa.com").paymentWords.test("결제하기"), true);
  assert.equal(findSite("www.29cm.co.kr").paymentWords.test("주문 및 결제"), true);
  assert.equal(
    findSite("www.amazon.com").paymentWords.test("Place your order"),
    true,
  );
  assert.equal(findSite("kream.co.kr").paymentWords.test("결제하기"), true);
  assert.equal(
    findSite("web.coupangeats.com").paymentWords.test("결제하기"),
    true,
  );
  assert.equal(findSite("order.baemin.com").paymentWords.test("25,000원 결제하기"), true);
  assert.equal(findSite("www.yogiyo.co.kr").paymentWords.test("결제하기"), true);
});

test("allows checkout navigation wording before the payment screen", () => {
  const coupang = findSite("www.coupang.com");
  const amazon = findSite("www.amazon.com");
  const kream = findSite("kream.co.kr");

  assert.equal(coupang.paymentWords.test("구매하기"), false);
  assert.equal(coupang.paymentWords.test("주문하기"), false);
  assert.equal(amazon.paymentWords.test("Proceed to checkout"), false);
  assert.equal(kream.paymentWords.test("즉시 구매"), false);
  assert.equal(kream.paymentWords.test("구매 입찰"), false);
  assert.equal(kream.paymentWords.test("구매확정"), false);
});

test("treats ambiguous order buttons as payment only on checkout routes", () => {
  const yogiyo = findSite("www.yogiyo.co.kr");

  assert.equal(
    matchesPaymentText(
      yogiyo,
      "주문하기",
      "https://www.yogiyo.co.kr/mobile/#/cart/",
    ),
    false,
  );
  assert.equal(
    matchesPaymentText(
      yogiyo,
      "주문하기",
      "https://www.yogiyo.co.kr/mobile/#/checkout/",
    ),
    true,
  );
});
