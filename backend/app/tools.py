"""Challenger Agent 함수 도구.

핵심은 도구가 많은 것이 아니라 **에이전트가 매번 전부 호출하지 않는 것**이다.
claim type에 따라 필요한 것만 고르게 하고, 호출 기록은 그대로 세컨드 화면에 흐른다.

모든 도구는 실패해도 예외를 던지지 않는다. 확인하지 못한 것은
found=False / verified=False 로 정직하게 돌려준다. 추측으로 채우지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agents import RunContextWrapper, function_tool

from . import gates, judge, store


@dataclass
class Ctx:
    """에이전트 실행 컨텍스트. 모델에게 통째로 주지 않고 도구를 통해서만 노출한다."""

    case: dict[str, Any]
    profile: dict[str, Any]
    classification: dict[str, Any]
    applied_actions: list[dict[str, Any]] = field(default_factory=list)
    memories_written: list[dict[str, Any]] = field(default_factory=list)


# --------------------------------------------------------------------------
# 예산
# --------------------------------------------------------------------------

@function_tool
def get_budget_status(ctx: RunContextWrapper[Ctx]) -> dict[str, Any]:
    """이번 달 자유 예산 현황과 구매 후 잔액, 급여일까지 남은 일수를 반환한다.

    사용자의 주장이 budget 유형이거나, 가격이 잔액에 영향을 줄 때 호출한다.
    """
    return judge.budget_snapshot(ctx.context.case, ctx.context.profile)


@function_tool
def get_upcoming_events(ctx: RunContextWrapper[Ctx], days: int = 14) -> dict[str, Any]:
    """향후 N일간 예정된 지출(캘린더 기반 추정)을 반환한다.

    잔액이 충분해 보여도 예정 지출이 그 의미를 바꾼다. budget 주장 검증 시 함께 본다.
    """
    events = []
    for e in ctx.context.profile.get("upcoming_events", []):
        if int(e.get("days_from_now", 0)) <= days:
            events.append({
                "title": e["title"],
                "in_days": e["days_from_now"],
                "estimated_cost": e["estimated_cost"],
            })
    return {
        "window_days": days,
        "events": events,
        "estimated_total": sum(e["estimated_cost"] for e in events),
    }


# --------------------------------------------------------------------------
# 이력 / 보유
# --------------------------------------------------------------------------

@function_tool
def get_purchase_history(ctx: RunContextWrapper[Ctx], category: str) -> dict[str, Any]:
    """해당 카테고리의 과거 구매 이력과 **그때 사용자가 댄 근거 원문**을 반환한다.

    이 도구가 이 에이전트의 정체성이다. 과거의 변명을 그대로 인용할 수 있게 한다.
    반복 구매 여부를 여기서 확인한 뒤 find_alternatives의 mode를 정하라.
    """
    profile = ctx.context.profile
    rows = store.purchases_in_category(profile, category)
    last_180 = [r for r in rows if r["days_ago"] <= 180]
    last_90 = [r for r in rows if r["days_ago"] <= 90]
    total_90 = sum(r["price"] for r in last_90)
    span = max((r["days_ago"] for r in last_90), default=0) or 1

    return {
        "category": category,
        "purchases_last_30_days": len([r for r in rows if r["days_ago"] <= 30]),
        "purchases_last_90_days": len(last_90),
        "purchases_last_180_days": len(last_180),
        "total_spent_last_90_days": total_90,
        "estimated_annual_spend": int(total_90 * 365 / span) if last_90 else 0,
        "previous_justifications": [
            {"days_ago": r["days_ago"], "text": r["justification"]} for r in last_180
        ],
        "unused_items": len([r for r in last_180 if not r.get("used", True)]),
    }


@function_tool
def get_owned_items(ctx: RunContextWrapper[Ctx], category: str) -> dict[str, Any]:
    """사용자가 직접 등록한 보유 물품을 반환한다. necessity 주장 검증에 사용한다."""
    items = store.owned_in_category(ctx.context.profile, category)
    return {
        "category": category,
        "count": sum(int(i.get("count", 1)) for i in items),
        "items": [
            {"name": i["name"], "count": i.get("count", 1),
             "last_used_days_ago": i.get("last_used_days_ago")}
            for i in items
        ],
        "note": "사용자가 등록하지 않은 물품은 여기에 나타나지 않는다. 없다고 단정하지 말 것.",
    }


@function_tool
def read_memory(ctx: RunContextWrapper[Ctx]) -> dict[str, Any]:
    """이전 개입에서 에이전트 자신이 기록해 둔 관찰을 읽는다.

    같은 패턴이 반복되는지 확인할 때 사용한다.
    """
    return {"observations": store.read_memory(ctx.context.profile["profile_id"], limit=15)}


# --------------------------------------------------------------------------
# 검증
# --------------------------------------------------------------------------

@function_tool
def check_price_claim(
    ctx: RunContextWrapper[Ctx],
    product_name: str,
    current_price: int,
    discount_text: str = "",
) -> dict[str, Any]:
    """가격·희소성 주장을 페이지 근거만으로 1차 검증한다.

    이 도구는 외부 시세를 모른다. 실제 시세가 필요하면 web_search를 따로 호출하라.
    확인하지 못한 항목은 반드시 unverifiable로 남긴다. 추측으로 반박하지 마라.
    """
    page_text = ctx.context.case.get("page_text") or ""
    patterns = gates.detect_dark_patterns(page_text)
    urgency = [p["evidence"] for p in patterns if p["type"] == "긴급성 조작"]

    return {
        "product_name": product_name,
        "current_price": current_price,
        "discount_text": discount_text,
        "verified": False,
        "reason": "페이지 밖 가격 이력은 이 도구로 확인할 수 없습니다. 시세 확인이 필요하면 web_search를 사용하세요.",
        "urgency_phrases_detected": urgency,
        "urgency_verifiable": False,
        "dark_patterns_on_page": patterns,
    }


@function_tool
def detect_dark_pattern(ctx: RunContextWrapper[Ctx]) -> dict[str, Any]:
    """현재 결제 페이지에서 다크패턴(눈속임 설계)을 탐지한다.

    공정위가 전자상거래법(2025-02-14 시행)으로 금지한 6개 유형 + 긴급성 조작.
    """
    detected = ctx.context.case.get("dark_patterns") or gates.detect_dark_patterns(
        ctx.context.case.get("page_text")
    )
    return {
        "detected": detected,
        "count": len(detected),
        "note": "탐지는 페이지 텍스트 휴리스틱이다. '재고 3개' 같은 주장의 진위는 확인할 수 없다.",
    }


# --------------------------------------------------------------------------
# 대안
# --------------------------------------------------------------------------

@function_tool
def find_alternatives(
    ctx: RunContextWrapper[Ctx],
    product_name: str,
    category: str,
    mode: str,
) -> dict[str, Any]:
    """대안 탐색의 **계산 근거**를 만든다.

    mode: 'cheaper' | 'longterm_substitute' | 'secondhand' | 'owned'
    어떤 mode로 부를지는 get_purchase_history 결과를 보고 네가 정한다.
      · 반복 구매 소모품 → 'longterm_substitute' (구조적 대체재의 손익분기 계산)
      · 일회성 → 'cheaper'
      · 이미 보유 중 → 'owned'
    실제 상품·시세는 이 도구가 모른다. 필요하면 web_search로 확인해서 채워라.
    억지 대안을 만들지 말고, 근거가 없으면 found=False로 두어라.
    """
    profile = ctx.context.profile
    price = int(ctx.context.case["product"].get("price") or 0)
    rows = store.purchases_in_category(profile, category)
    last_90 = [r for r in rows if r["days_ago"] <= 90]

    if mode == "owned":
        items = store.owned_in_category(profile, category)
        return {
            "mode": mode,
            "found": bool(items),
            "owned_items": items,
            "message": "보유품으로 대체 가능한지 확인하십시오." if items else "등록된 보유품이 없습니다.",
        }

    if mode == "longterm_substitute":
        if not last_90:
            return {
                "mode": mode,
                "found": False,
                "reason": "반복 구매 이력이 없어 구조적 대체재를 계산할 근거가 없습니다.",
            }
        spent = sum(r["price"] for r in last_90)
        span = max(r["days_ago"] for r in last_90) or 1
        annual = int(spent * 365 / span)
        return {
            "mode": mode,
            "found": True,
            "repeat_purchases_90d": len(last_90),
            "spent_last_90_days": spent,
            "current_annual_cost": annual,
            "monthly_cost": int(annual / 12),
            "breakeven_formula": "손익분기(개월) = 대체재 초기비용 / (현재 월 지출 - 대체재 월 비용)",
            "instruction": (
                "web_search로 이 카테고리의 구조적 대체재(정기배송/렌탈/대용량/재사용 제품)의 "
                "실제 가격을 찾아, 위 공식에 넣어 손익분기 개월수를 직접 계산하라. "
                "찾지 못하면 found=False로 보고하라."
            ),
        }

    # cheaper / secondhand
    return {
        "mode": mode,
        "found": False,
        "current_price": price,
        "product_name": product_name,
        "instruction": (
            "이 도구는 시세 데이터베이스가 없다. web_search로 동일·유사 상품의 "
            "다른 판매처 가격을 찾아 현재 가격과 비교하라. "
            "찾지 못하면 '확인하지 못했습니다'라고 보고하고 최저가라고 단정하지 마라."
        ),
    }


# --------------------------------------------------------------------------
# 기록 / 행동
# --------------------------------------------------------------------------

@function_tool
def write_memory(ctx: RunContextWrapper[Ctx], observation: str, confidence: str) -> dict[str, Any]:
    """기억할 가치가 있다고 **네가 판단한** 관찰을 기록한다.

    자동 로그가 아니다. 다음 개입에서 쓸 수 있는 패턴만 남겨라.
    confidence: 'low' | 'medium' | 'high'
    """
    conf = confidence if confidence in ("low", "medium", "high") else "medium"
    mem_id = store.write_memory(ctx.context.profile["profile_id"], observation, conf)
    ctx.context.memories_written.append({"id": mem_id, "text": observation, "confidence": conf})
    return {"saved": True, "id": mem_id}


@function_tool
def apply_action(ctx: RunContextWrapper[Ctx], action: str, reason: str) -> dict[str, Any]:
    """실제 조작을 예약한다. 말이 아니라 세상을 바꾸는 단계.

    허용: 'move_to_wishlist' | 'watch_price' | 'schedule_review'
    보류(hold)와 해제(release)는 네가 정하지 않는다. 규칙 엔진이 정한다.
    """
    allowed = {"move_to_wishlist", "watch_price", "schedule_review"}
    if action not in allowed:
        return {
            "applied": False,
            "reason": f"'{action}'은 에이전트가 실행할 수 없습니다. 보류/해제는 규칙 엔진의 권한입니다.",
            "allowed": sorted(allowed),
        }
    entry = {"action": action, "reason": reason, "at": store.iso(store.now())}
    ctx.context.applied_actions.append(entry)
    return {"applied": True, **entry}


INVESTIGATION_TOOLS = [
    get_budget_status,
    get_upcoming_events,
    get_purchase_history,
    get_owned_items,
    read_memory,
    check_price_claim,
    detect_dark_pattern,
    find_alternatives,
    write_memory,
    apply_action,
]
