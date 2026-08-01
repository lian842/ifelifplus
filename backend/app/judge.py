"""Policy Judge — 규칙 기반 판정. LLM이 아니다.

판정을 LLM에게 맡기지 않는 이유는 두 가지다.
  1) 같은 상황에 같은 판정이 나와야 한다(재현성).
  2) 판정 근거를 사용자에게 항목별로 공개해야 한다(설명 가능성).

에이전트는 사실을 모으고, 여기서는 그 사실로 점수를 더한다.
에이전트가 제공하는 항목(specific_use_case_given 등)조차 점수 계산에만 쓰이고
최종 판정 경계는 아래 상수가 정한다.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from . import store

SCORING: dict[str, int] = {
    # 가산
    "budget_exceeded": +3,
    "same_category_3plus_owned": +2,
    "similar_purchase_last_30d": +2,
    "dwell_under_30min": +2,
    "late_night": +2,
    "price_claim_unverified": +1,
    "dark_pattern_detected": +1,
    "retry_after_hold": +3,
    "bnpl_or_installment": +2,
    "upcoming_events_squeeze": +2,
    "high_value_item": +2,
    # 감산
    "specific_use_case_given": -2,
    "no_owned_substitute": -2,
    "intent_held_over_24h": -3,
    "verified_lowest_price": -1,
    "essential_category": -3,
}

LABELS: dict[str, str] = {
    "budget_exceeded": "이번 달 자유 예산 초과",
    "same_category_3plus_owned": "동일 카테고리 3개 이상 보유",
    "similar_purchase_last_30d": "최근 30일 내 유사 구매",
    "dwell_under_30min": "상품 발견 후 30분 이내 결제",
    "late_night": "새벽 시간대(00~04시) 결제",
    "price_claim_unverified": "가격·희소성 주장 검증 실패",
    "dark_pattern_detected": "다크패턴 탐지",
    "retry_after_hold": "보류 판정 후 재시도",
    "bnpl_or_installment": "후불결제·할부 사용",
    "upcoming_events_squeeze": "예정 지출로 잔액 부족",
    "high_value_item": "고가 상품",
    "specific_use_case_given": "구체적인 사용 시점·상황 제시",
    "no_owned_substitute": "대체 가능한 보유품 없음",
    "intent_held_over_24h": "24시간 이상 구매 의사 유지",
    "verified_lowest_price": "최저가 확인됨",
    "essential_category": "생필품·식료품",
}

# (하한, 상한) → 판정. 상한 None = 무한.
VERDICT_BANDS: list[tuple[int, int | None, str]] = [
    (-99, 0, "PASS"),
    (1, 3, "WARN"),
    (4, 6, "HOLD"),
    (7, None, "STRONG_HOLD"),
]

HOLD_MINUTES = {"HOLD": 30, "STRONG_HOLD": 24 * 60}


def collect_signals(
    case: dict[str, Any],
    profile: dict[str, Any],
    classification: dict[str, Any],
    findings: dict[str, Any] | None,
) -> dict[str, bool]:
    """점수 항목별 참/거짓. 대부분 결정론적으로 계산되고, 일부만 에이전트가 채운다."""
    price = int(case["product"].get("price") or 0)
    free_budget = int(profile["monthly_free_budget"])
    spent = int(profile["spent_this_month"])
    remaining = free_budget - spent
    after = remaining - price
    dwell = int(case.get("dwell_minutes") or 0)
    hour = datetime.fromisoformat(case["checkout_at"]).hour
    findings = findings or {}

    upcoming = sum(int(e.get("estimated_cost") or 0) for e in profile.get("upcoming_events", []))

    return {
        # --- 결정론 (에이전트가 뭐라 하든 바뀌지 않는다) ---
        "budget_exceeded": after < 0,
        "same_category_3plus_owned": classification.get("owned_count", 0) >= 3,
        "similar_purchase_last_30d": classification.get("same_category_30d", 0) > 0,
        "dwell_under_30min": dwell < 30,
        "late_night": 0 <= hour < 4,
        "dark_pattern_detected": bool(case.get("dark_patterns")),
        "retry_after_hold": bool(case.get("retry_of")),
        "bnpl_or_installment": bool(case.get("payment_method_bnpl")),
        "upcoming_events_squeeze": upcoming > 0 and after < upcoming,
        "high_value_item": price >= 500_000,
        "intent_held_over_24h": dwell >= 1440,
        "essential_category": bool(classification.get("is_essential")),
        # --- 에이전트 조사 결과 ---
        "price_claim_unverified": bool(findings.get("price_claim_unverified")),
        "specific_use_case_given": bool(findings.get("specific_use_case_given")),
        "no_owned_substitute": bool(findings.get("no_owned_substitute")),
        "verified_lowest_price": bool(findings.get("verified_lowest_price")),
    }


def judge(
    case: dict[str, Any],
    profile: dict[str, Any],
    classification: dict[str, Any],
    findings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    signals = collect_signals(case, profile, classification, findings)

    breakdown = [
        {"key": k, "label": LABELS.get(k, k), "points": SCORING[k]}
        for k, v in signals.items() if v and k in SCORING
    ]
    score = sum(item["points"] for item in breakdown)

    verdict = "PASS"
    for lo, hi, name in VERDICT_BANDS:
        if score >= lo and (hi is None or score <= hi):
            verdict = name

    # 생필품·식료품은 지연시키지 않는다. 대안 제시까지만 허용한다.
    capped_reason = None
    if signals["essential_category"] and verdict in ("HOLD", "STRONG_HOLD"):
        verdict = "WARN"
        capped_reason = "생필품으로 분류되어 지연 없이 대안 정보만 제공합니다."

    release_at = None
    hold_minutes = HOLD_MINUTES.get(verdict)
    if hold_minutes:
        release_at = store.iso(store.now() + timedelta(minutes=hold_minutes))

    return {
        "risk_score": score,
        "verdict": verdict,
        "breakdown": breakdown,
        "signals": signals,
        "hold_minutes": hold_minutes,
        "release_at": release_at,
        "capped_reason": capped_reason,
        "scoring_table": SCORING,
    }


def budget_snapshot(case: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """개입 즉시 보여주는 숫자. LLM을 거치지 않는다."""
    price = int(case["product"].get("price") or 0)
    free_budget = int(profile["monthly_free_budget"])
    spent = int(profile["spent_this_month"])
    remaining = free_budget - spent
    upcoming = profile.get("upcoming_events", [])
    upcoming_total = sum(int(e.get("estimated_cost") or 0) for e in upcoming)
    hourly = int(profile.get("hourly_wage") or 0)

    return {
        "monthly_free_budget": free_budget,
        "spent_this_month": spent,
        "remaining": remaining,
        "product_price": price,
        "after_purchase": remaining - price,
        "days_until_payday": store.days_until_payday(profile),
        "upcoming_events": upcoming,
        "upcoming_total": upcoming_total,
        "after_upcoming": remaining - price - upcoming_total,
        "work_hours_equivalent": round(price / hourly, 1) if hourly else None,
    }
