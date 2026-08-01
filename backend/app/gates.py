"""Gate — 개입 여부가 아니라 **개입 방식**을 정하는 결정론적 분기.

이 에이전트는 어떤 구매도 그냥 통과시키지 않는다. 팝업은 항상 뜬다.
다만 팝업이 하는 일이 다르다.

  price_only : 심문하지 않는다. 사용자 입력 0회. 에이전트가 곧바로 최저가·대안만 조사한다.
               의약품, 생필품, 소액, 이례성 없는 구매가 여기 온다. 마찰은 절대 걸지 않는다.
  challenge  : "왜 지금 사야 합니까?" 1회 입력을 받고 자율 조사 후 규칙 엔진이 판정한다.
               마찰(보류)이 걸릴 수 있다.

의약품에 마찰을 거는 것은 위험하다. 그래서 no_friction으로 잠근다.
하지만 개입 자체를 포기하지는 않는다 — 같은 약이 더 싼 곳이 있다는 사실은 알려줄 수 있다.
"""

from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------------------
# 카테고리 휴리스틱 — 키워드로 끝나면 LLM을 부르지 않는다.
# 키워드에 걸리지 않으면 classifier.py 가 모델에게 한 번 물어본다.
# --------------------------------------------------------------------------

MEDICAL_KEYWORDS = [
    "약", "의약", "처방", "타이레놀", "게보린", "진통제", "해열", "감기약", "소화제",
    "밴드", "붕대", "소독", "마스크", "체온계", "혈압계", "혈당", "인슐린", "링거",
    "콘택트렌즈", "렌즈세정", "임신테스트", "생리대", "탐폰", "기저귀", "보청기",
    "휠체어", "목발", "파스", "연고", "안약", "영양제", "비타민", "홍삼", "유산균",
    "medicine", "pharmacy", "prescription", "bandage", "thermometer", "insulin",
]

ESSENTIAL_KEYWORDS = [
    "생수", "물 2l", "쌀", "계란", "우유", "두부", "김치", "라면", "식빵", "채소",
    "과일", "고기", "휴지", "화장지", "물티슈", "세제", "샴푸", "치약", "칫솔",
    "비누", "쓰레기봉투", "식용유", "소금", "설탕", "간장",
    "water", "rice", "milk", "eggs", "toilet paper", "detergent", "toothpaste",
]

CATEGORY_HINTS: list[tuple[str, list[str]]] = [
    ("water", ["생수", "삼다수", "아이시스", "백산수", "evian", "bottled water", "생수 2l"]),
    ("tumbler", ["텀블러", "보온병", "물병", "tumbler", "thermos"]),
    ("shoes", ["운동화", "러닝화", "스니커즈", "구두", "샌들", "shoes", "sneaker"]),
    ("headphones", ["헤드폰", "이어폰", "에어팟", "버즈", "headphone", "earbud", "airpods"]),
    ("laptop", ["노트북", "맥북", "그램", "laptop", "macbook"]),
    ("phone", ["아이폰", "갤럭시", "스마트폰", "iphone", "galaxy"]),
    ("clothing", ["티셔츠", "셔츠", "니트", "코트", "패딩", "바지", "원피스", "자켓", "후드"]),
    ("bag", ["가방", "백팩", "크로스백", "토트백", "backpack"]),
    ("cosmetics", ["화장품", "쿠션", "립스틱", "에센스", "선크림", "토너"]),
    ("food", ["과자", "초콜릿", "커피", "음료", "간식", "밀키트", "치킨", "피자"]),
    ("game", ["게임", "닌텐도", "플스", "스팀", "ps5", "switch"]),
    ("furniture", ["책상", "의자", "선반", "소파", "침대", "조명"]),
]

HIGH_VALUE_THRESHOLD = 500_000
TRIVIAL_PRICE = 5_000


def _norm(*parts: str | None) -> str:
    return " ".join(p for p in parts if p).lower()


def guess_category(name: str | None, hint: str | None = None) -> str | None:
    text = _norm(name, hint)
    for cat, words in CATEGORY_HINTS:
        if any(w in text for w in words):
            return cat
    return None


def looks_medical(name: str | None, hint: str | None = None) -> bool:
    text = _norm(name, hint)
    return any(w in text for w in MEDICAL_KEYWORDS)


# 브랜드명만 적힌 상품("제주 삼다수")은 키워드에 안 걸린다. 카테고리에서도 파생시킨다.
ESSENTIAL_CATEGORIES = {"water", "food"}


def looks_essential(name: str | None, hint: str | None = None) -> bool:
    text = _norm(name, hint)
    if any(w in text for w in ESSENTIAL_KEYWORDS):
        return True
    return guess_category(name, hint) in ESSENTIAL_CATEGORIES


# --------------------------------------------------------------------------
# 다크패턴 탐지 (DOM 텍스트 휴리스틱)
# 공정위가 2025-02-14 시행 전자상거래법으로 금지한 유형 + 긴급성 조작
# --------------------------------------------------------------------------

# 각 유형이 무엇으로 확정되는지를 함께 적는다.
#   text : 페이지에 그 문구가 있다는 것까지만 사실이다
#   dom  : 확정하려면 DOM 상태(체크박스 checked 등)를 봐야 한다
#   flow : 확정하려면 해지·취소 절차를 실제로 밟아봐야 한다. 우리는 못 한다
#
# 문구를 봤다는 것과 그 행위가 실제로 일어났다는 것은 다르다.
# "정기배송 신청"이라는 글자가 있다고 체크박스가 켜져 있는 것은 아니다.
DARK_PATTERN_RULES: list[tuple[str, str, list[str]]] = [
    ("긴급성 조작", "text",
     [r"재고\s*\d+\s*개", r"품절\s*임박", r"마감\s*임박", r"오늘\s*(만|종료)",
      r"\d+\s*분\s*남", r"\d{2}:\d{2}:\d{2}", r"only \d+ left", r"ends today"]),
    ("반복간섭", "text",
     [r"지금\s*가입", r"다시\s*보지\s*않기", r"놓치지\s*마세요", r"마지막\s*기회"]),
    ("특정옵션 사전선택", "dom",
     [r"자동\s*결제", r"추가\s*보증", r"멤버십\s*자동", r"정기\s*배송\s*신청"]),
    ("숨은 갱신", "text",
     [r"첫\s*달\s*무료", r"무료\s*체험", r"자동\s*연장", r"이후\s*월\s*\d",
      r"free trial", r"auto[- ]?renew"]),
    ("순차공개 가격책정", "text",
     [r"배송비\s*별도", r"결제\s*시\s*추가", r"옵션\s*추가금", r"\+\s*\d+원\s*추가"]),
    ("취소·탈퇴 방해", "flow",
     [r"고객센터\s*문의\s*후\s*해지", r"전화로만\s*취소"]),
]

# 확장 프로그램이 DOM에서 직접 관찰해 보내주는 신호. 이게 있어야 dom 유형이 확정된다.
DOM_SIGNAL_TYPES = {
    "preselected_inputs": "특정옵션 사전선택",
    "countdown_timers": "긴급성 조작",
}


def detect_dark_patterns(page_text: str | None,
                         dom_signals: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """페이지에서 눈속임 설계를 탐지한다.

    page_text만 있으면 '그런 문구가 있다'까지가 사실이고, 그 이상을 주장하지 않는다.
    확장 프로그램이 dom_signals(실제 체크된 input 목록 등)를 보내주면 그때 확정한다.
    """
    dom_signals = dom_signals or {}
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    if page_text:
        text = re.sub(r"\s+", " ", page_text)[:20000]
        for label, basis, patterns in DARK_PATTERN_RULES:
            for pat in patterns:
                m = re.search(pat, text, re.IGNORECASE)
                if m and label not in seen:
                    seen.add(label)
                    found.append({
                        "type": label,
                        "evidence": m.group(0).strip(),
                        "basis": basis,
                        # 문구를 봤다는 것 자체는 사실이지만, 그 문구가 주장하는 내용
                        # (재고가 정말 3개인지, 체크박스가 정말 켜져 있는지)은 확인 못 했다.
                        "confirmed": False,
                        "note": {
                            "text": "페이지에 이 문구가 있다는 것까지만 확인했습니다. 주장의 진위는 확인할 수 없습니다.",
                            "dom": "문구만 확인했습니다. 실제로 사전 선택되어 있는지는 확장 프로그램의 DOM 신호가 있어야 확정됩니다.",
                            "flow": "문구만 확인했습니다. 실제 해지 절차는 확인할 수 없습니다.",
                        }[basis],
                    })
                    break

    # DOM에서 직접 관찰된 것은 확정으로 올린다.
    for key, label in DOM_SIGNAL_TYPES.items():
        observed = dom_signals.get(key) or []
        if not observed:
            continue
        existing = next((f for f in found if f["type"] == label), None)
        evidence = ", ".join(str(o) for o in observed[:3]) if isinstance(observed, list) else str(observed)
        if existing:
            existing.update({"confirmed": True, "basis": "dom", "evidence": evidence,
                             "note": "확장 프로그램이 DOM에서 직접 관찰했습니다."})
        else:
            found.append({"type": label, "evidence": evidence, "basis": "dom",
                          "confirmed": True, "note": "확장 프로그램이 DOM에서 직접 관찰했습니다."})
    return found


# --------------------------------------------------------------------------
# 개입 방식 분기
# --------------------------------------------------------------------------

def decide_mode(case: dict[str, Any], profile: dict[str, Any],
                classification: dict[str, Any]) -> dict[str, Any]:
    """어떤 팝업을 띄울지 결정한다. '팝업을 띄울지'는 결정하지 않는다 — 항상 띄운다."""
    price = int(case["product"].get("price") or 0)
    free_budget = int(profile["monthly_free_budget"])
    remaining = free_budget - int(profile["spent_this_month"])
    dwell = int(case.get("dwell_minutes") or 0)
    same_cat_30d = classification.get("same_category_30d", 0)

    # 의약품 — 개입은 하되 마찰은 절대 금지. 건강 관련 결정을 지연시키지 않는다.
    if classification.get("is_medical"):
        return {
            "mode": "price_only",
            "no_friction": True,
            "gate": 0,
            "reason": "건강·의료 관련 구매입니다. 구매를 지연시키지 않고 가격 정보만 확인합니다.",
        }

    unusual_reasons = []
    if price > remaining:
        unusual_reasons.append("잔여 예산 초과")
    if price >= HIGH_VALUE_THRESHOLD:
        unusual_reasons.append("고가 상품")
    if price > free_budget * 0.05:
        unusual_reasons.append("월 자유 예산의 5% 초과")
    if same_cat_30d > 0:
        unusual_reasons.append(f"최근 30일 내 같은 카테고리 구매 {same_cat_30d}건")
    if dwell < 1440:
        unusual_reasons.append(f"발견 후 {dwell}분 만에 결제")
    if case.get("dark_patterns"):
        unusual_reasons.append("페이지에서 다크패턴 탐지")
    if case.get("retry_of"):
        unusual_reasons.append("보류 판정 후 재시도")

    # 소액은 심문할 가치가 없다. 그래도 최저가는 확인해준다.
    if price <= TRIVIAL_PRICE and same_cat_30d == 0:
        return {
            "mode": "price_only",
            "no_friction": True,
            "gate": 1,
            "reason": f"{price:,}원. 예산에 유의미한 영향이 없어 가격 정보만 확인합니다.",
        }

    if not unusual_reasons:
        return {
            "mode": "price_only",
            "no_friction": True,
            "gate": 1,
            "reason": "예산 내이고, 최근 유사 구매가 없으며, 24시간 이상 검토한 구매입니다. "
                      "심문하지 않고 더 싼 곳만 확인합니다.",
        }

    return {
        "mode": "challenge",
        # 생필품은 심문은 하되 지연은 시키지 않는다. 대안 제시까지가 한계다.
        "no_friction": bool(classification.get("is_essential")),
        "gate": 2,
        "reason": "이례적인 신호가 있습니다: " + ", ".join(unusual_reasons),
        "unusual_reasons": unusual_reasons,
    }
