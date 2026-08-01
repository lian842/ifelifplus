"""Gate 0 / Gate 1 — LLM을 부르기 전에 끝내는 결정론적 관문.

Gate 0 : 절대 개입 금지 (의약품·의료기기·건강 소모품). 통과가 아니라 '개입 없음'이다.
Gate 1 : 이례성이 없으면 LLM 없이 즉시 PASS. 대부분의 구매가 여기서 끝나야 한다.

여기서 걸러지지 않은 것만 Challenger Agent(Gate 2)로 간다.
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


def looks_essential(name: str | None, hint: str | None = None) -> bool:
    text = _norm(name, hint)
    return any(w in text for w in ESSENTIAL_KEYWORDS)


# --------------------------------------------------------------------------
# 다크패턴 탐지 (DOM 텍스트 휴리스틱)
# 공정위가 2025-02-14 시행 전자상거래법으로 금지한 유형 + 긴급성 조작
# --------------------------------------------------------------------------

DARK_PATTERN_RULES: list[tuple[str, list[str]]] = [
    ("긴급성 조작", [r"재고\s*\d+\s*개", r"품절\s*임박", r"마감\s*임박", r"오늘\s*(만|종료)",
                 r"\d+\s*분\s*남", r"\d{2}:\d{2}:\d{2}", r"only \d+ left", r"ends today"]),
    ("반복간섭", [r"지금\s*가입", r"다시\s*보지\s*않기", r"놓치지\s*마세요", r"마지막\s*기회"]),
    ("특정옵션 사전선택", [r"자동\s*결제", r"추가\s*보증", r"멤버십\s*자동", r"정기\s*배송\s*신청"]),
    ("숨은 갱신", [r"첫\s*달\s*무료", r"무료\s*체험", r"자동\s*연장", r"이후\s*월\s*\d"]),
    ("순차공개 가격책정", [r"배송비\s*별도", r"결제\s*시\s*추가", r"옵션\s*추가금", r"\+\s*\d+원\s*추가"]),
    ("취소·탈퇴 방해", [r"고객센터\s*문의\s*후\s*해지", r"전화로만\s*취소"]),
]


def detect_dark_patterns(page_text: str | None) -> list[dict[str, Any]]:
    if not page_text:
        return []
    text = re.sub(r"\s+", " ", page_text)[:20000]
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for label, patterns in DARK_PATTERN_RULES:
        for pat in patterns:
            m = re.search(pat, text, re.IGNORECASE)
            if m and label not in seen:
                seen.add(label)
                found.append({
                    "type": label,
                    "evidence": m.group(0).strip(),
                    # 재고/타이머 주장은 우리가 검증할 수 없다. 검증했다고 말하지 않는다.
                    "verifiable": label not in ("긴급성 조작",),
                })
                break
    return found


# --------------------------------------------------------------------------
# Gate 0 / Gate 1
# --------------------------------------------------------------------------

def gate0(classification: dict[str, Any]) -> dict[str, Any] | None:
    """의약품·의료 관련이면 개입 자체를 하지 않는다."""
    if classification.get("is_medical"):
        return {
            "gate": 0,
            "verdict": "PASS",
            "intervene": False,
            "reason": "건강·의료 관련 구매입니다. 개입하지 않습니다.",
            "llm_used": classification.get("llm_used", False),
        }
    return None


def gate1(case: dict[str, Any], profile: dict[str, Any], classification: dict[str, Any]) -> dict[str, Any] | None:
    """이례성이 없으면 LLM을 부르지 않고 통과시킨다."""
    price = int(case["product"].get("price") or 0)
    free_budget = int(profile["monthly_free_budget"])
    remaining = free_budget - int(profile["spent_this_month"])
    dwell = int(case.get("dwell_minutes") or 0)
    same_cat_30d = classification.get("same_category_30d", 0)

    if price <= TRIVIAL_PRICE and same_cat_30d == 0:
        return {
            "gate": 1,
            "verdict": "PASS",
            "intervene": False,
            "reason": f"{price:,}원. 예산에 유의미한 영향이 없습니다.",
            "llm_used": classification.get("llm_used", False),
        }

    unusual = (
        price > remaining
        or price >= HIGH_VALUE_THRESHOLD
        or price > free_budget * 0.05
        or same_cat_30d > 0
        or dwell < 1440
        or bool(case.get("dark_patterns"))
        or bool(case.get("retry_of"))
    )
    if not unusual:
        return {
            "gate": 1,
            "verdict": "PASS",
            "intervene": False,
            "reason": "예산 내이고, 최근 유사 구매가 없으며, 24시간 이상 검토한 구매입니다.",
            "llm_used": classification.get("llm_used", False),
        }
    return None
