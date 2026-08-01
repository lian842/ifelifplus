"""쇼핑몰 어댑터 레지스트리.

DOM 파싱은 확장 프로그램(content script)이 한다. 백엔드가 아는 것은
"어느 사이트에서 왔는가"와 "그 사이트의 가격을 어떻게 해석해야 하는가"뿐이다.

이렇게 나눠두면 새 쇼핑몰 지원은 확장 쪽 셀렉터 추가 + 여기 한 줄로 끝난다.
백엔드 로직은 사이트를 몰라도 된다.
"""

from __future__ import annotations

import os
from typing import Any

# 환율은 데모용 고정값이다. 실시간 환율 API를 붙이지 않은 것은 의도적이다 —
# 이 값이 판정을 바꾸는 경우(해외 고가 구매)에는 화면에 '추정'이라고 표시한다.
USD_KRW = float(os.getenv("ULYSSES_USD_KRW", "1380"))
JPY_KRW = float(os.getenv("ULYSSES_JPY_KRW", "9.2"))

RATES: dict[str, float] = {"KRW": 1.0, "USD": USD_KRW, "JPY": JPY_KRW}

SITES: list[dict[str, Any]] = [
    {"id": "coupang",  "name": "쿠팡",        "hosts": ["coupang.com"],          "currency": "KRW",
     "note": "로켓배송 여부로 실구매가가 달라진다. 와우회원가 표기 주의"},
    {"id": "musinsa",  "name": "무신사",      "hosts": ["musinsa.com"],          "currency": "KRW",
     "note": "쿠폰 적용가와 표기가가 다르다"},
    {"id": "29cm",     "name": "29CM",        "hosts": ["29cm.co.kr"],           "currency": "KRW"},
    {"id": "kream",    "name": "KREAM",       "hosts": ["kream.co.kr"],          "currency": "KRW",
     "note": "체결가 기준. 수수료·배송비 별도"},
    {"id": "amazon",   "name": "Amazon.com",  "hosts": ["amazon.com"],           "currency": "USD",
     "note": "관세·배송비 별도. 원화 환산은 추정치다"},
    {"id": "naver",    "name": "네이버쇼핑",  "hosts": ["shopping.naver.com", "smartstore.naver.com"], "currency": "KRW"},
    {"id": "gmarket",  "name": "G마켓",       "hosts": ["gmarket.co.kr"],        "currency": "KRW"},
    {"id": "11st",     "name": "11번가",      "hosts": ["11st.co.kr"],           "currency": "KRW"},
    {"id": "coupangeats", "name": "쿠팡이츠", "hosts": ["coupangeats.com"],      "currency": "KRW",
     "note": "배달 주문. 배달비·최소주문금액이 총액을 바꾼다"},
    {"id": "baemin",   "name": "배달의민족",  "hosts": ["baemin.com"],           "currency": "KRW"},
    {"id": "yogiyo",   "name": "요기요",      "hosts": ["yogiyo.co.kr"],         "currency": "KRW"},
    {"id": "demo",     "name": "바로마켓(목업)", "hosts": ["localhost", "127.0.0.1"], "currency": "KRW"},
]


def find_site(url_or_host: str | None) -> dict[str, Any] | None:
    if not url_or_host:
        return None
    h = url_or_host.lower()
    for site in SITES:
        if any(host in h for host in site["hosts"]):
            return site
    return None


def resolve(url: str | None, price: int, currency: str | None = None) -> dict[str, Any]:
    """상품 URL에서 사이트를 식별하고 가격을 원화로 정규화한다.

    모르는 쇼핑몰이어도 실패하지 않는다. site=None으로 두고 그대로 진행한다.
    처음 보는 사이트에서 죽지 않는 것이 이 함수의 존재 이유다.
    """
    site = find_site(url)
    cur = (currency or (site or {}).get("currency") or "KRW").upper()
    rate = RATES.get(cur, 1.0)
    krw = int(round(price * rate))
    return {
        "site_id": (site or {}).get("id"),
        "site_name": (site or {}).get("name") or "알 수 없는 쇼핑몰",
        "site_note": (site or {}).get("note"),
        "known_site": site is not None,
        "currency": cur,
        "price_original": price,
        "price_krw": krw,
        "converted": cur != "KRW",
        "rate_used": rate if cur != "KRW" else None,
        "conversion_note": (f"{cur} 기준 가격을 고정 환율 {rate:g}원으로 환산한 추정치입니다."
                            if cur != "KRW" else None),
    }


def public_list() -> list[dict[str, Any]]:
    """확장 프로그램·프론트엔드가 지원 목록을 조회할 때 쓴다."""
    return [{"id": s["id"], "name": s["name"], "hosts": s["hosts"],
             "currency": s["currency"], "note": s.get("note")} for s in SITES]
