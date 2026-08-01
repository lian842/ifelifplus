const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { findSite, matchesPath } = require("../sites.js");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"),
);

const routeCases = [
  {
    id: "coupang",
    hostname: "www.coupang.com",
    trigger: "https://www.coupang.com/cartView.pang",
    checkout: "https://order.coupang.com/order/orderSheet.pang?item=1",
  },
  {
    id: "musinsa",
    hostname: "www.musinsa.com",
    trigger: "https://www.musinsa.com/order/cart",
    checkout: "https://www.musinsa.com/order/order_form",
  },
  {
    id: "29cm",
    hostname: "www.29cm.co.kr",
    trigger: "https://www.29cm.co.kr/order/cart",
    checkout: "https://www.29cm.co.kr/order/checkout",
  },
  {
    id: "amazon",
    hostname: "www.amazon.com",
    trigger: "https://www.amazon.com/gp/cart/view.html",
    checkout: "https://www.amazon.com/gp/buy/spc/handlers/display.html",
  },
  {
    id: "kream",
    hostname: "kream.co.kr",
    trigger: "https://kream.co.kr/products/547008",
    checkout: "https://kream.co.kr/buy/547008",
  },
  {
    id: "coupangeats",
    hostname: "web.coupangeats.com",
    trigger: "https://web.coupangeats.com/cart",
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
    trigger: "https://www.yogiyo.co.kr/mobile/#/cart/",
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

  assert.deepEqual(contentScript.js, ["sites.js", "content.js"]);
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

test("matches cart or purchase trigger routes", () => {
  for (const routeCase of routeCases) {
    if (!routeCase.trigger) {
      continue;
    }
    const site = findSite(routeCase.hostname);
    assert.equal(matchesPath(site.triggerPaths, routeCase.trigger), true);
  }
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

test("matches each site's checkout button wording", () => {
  assert.equal(findSite("www.coupang.com").checkoutWords.test("구매하기"), true);
  assert.equal(findSite("www.musinsa.com").checkoutWords.test("주문하기"), true);
  assert.equal(findSite("www.29cm.co.kr").checkoutWords.test("결제하기"), true);
  assert.equal(
    findSite("www.amazon.com").checkoutWords.test("Proceed to checkout"),
    true,
  );
  assert.equal(findSite("kream.co.kr").checkoutWords.test("즉시 구매"), true);
  assert.equal(findSite("kream.co.kr").checkoutWords.test("구매 입찰"), true);
  assert.equal(
    findSite("web.coupangeats.com").checkoutWords.test("배달 주문하기"),
    true,
  );
  assert.equal(findSite("order.baemin.com").checkoutWords.test("결제하기"), true);
  assert.equal(findSite("www.yogiyo.co.kr").checkoutWords.test("주문하기"), true);
});
