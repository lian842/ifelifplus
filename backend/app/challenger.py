"""Challenger Agent — OpenAI Agents SDK.

조사관이지 판사가 아니다. 판정은 judge.py가 한다.
여기서 하는 일은 (1) 주장 분해, (2) 필요한 도구만 선택 호출, (3) 사실 보고다.

실행은 항상 스트리밍이다. tool_call / tool_result 원본이 세컨드 화면으로 그대로 흘러야
심사 요건을 만족하기 때문이고, 그게 이 에이전트가 실제로 무엇을 했는지에 대한 유일한 증거다.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Literal

from agents import Agent, ModelSettings, Runner, WebSearchTool
from pydantic import BaseModel, Field

from . import events, gates, store
from .tools import INVESTIGATION_TOOLS, Ctx

MODEL = os.getenv("ULYSSES_MODEL", "gpt-4.1")
CLASSIFIER_MODEL = os.getenv("ULYSSES_CLASSIFIER_MODEL", "gpt-4.1-mini")
MAX_TURNS = int(os.getenv("ULYSSES_MAX_TURNS", "14"))
RUN_TIMEOUT_S = float(os.getenv("ULYSSES_TIMEOUT", "75"))


# --------------------------------------------------------------------------
# 시스템 프롬프트
# --------------------------------------------------------------------------

SYSTEM_PROMPT = """\
너는 사용자의 구매 결정을 조사하는 조사관이다. 판사가 아니다.
최종 판정은 별도의 규칙 엔진이 내리며, 너의 역할은 사실을 수집하고
사용자의 주장을 검증하는 것이다.

## 목표
사용자가 지금 이 구매를 해야 하는지 판단하는 데 필요한 사실을 모은다.
구매를 막는 것이 목표가 아니다. 근거가 충분하면 즉시 통과시켜라.

## 행동 원칙

1. 주장을 분해하라.
   사용자의 답변을 검증 가능한 claim 단위로 쪼갠다.
   각 claim에 type을 부여한다: price_urgency, necessity, budget, uniqueness, other

2. 필요한 도구만 호출하라.
   모든 도구를 매번 호출하지 마라. claim type에 따라 선택한다.
   - price_urgency  → check_price_claim (+ 필요하면 web_search로 실제 시세)
   - necessity      → get_owned_items, get_purchase_history
   - budget         → get_budget_status, get_upcoming_events
   - uniqueness     → check_price_claim (희소성 검증)
   불필요한 호출은 비용이며 설계 실패다.

3. 대안 탐색 방식을 스스로 결정하라.
   get_purchase_history 결과를 먼저 확인한 뒤 mode를 정한다.
   - 반복 구매 소모품이면 mode='longterm_substitute' (구조적 대안)
   - 일회성이면 mode='cheaper'
   - 이미 보유 중이면 대안 탐색 자체를 생략한다
   find_alternatives는 계산 근거만 준다. 실제 상품·가격은 web_search로 확인해서 채워라.

4. 확인하지 못한 것을 추측하지 마라.
   검증 실패 시 반드시 이렇게 말한다:
   "최저가라는 주장은 확인하지 못했습니다."
   추측으로 반박하는 것은 심각한 오류다.
   web_search 결과가 비어 있거나 무관하면 없는 것으로 취급하라.

5. 질문은 한 번에 하나만.
   현재 가장 약한 주장 하나를 골라 되묻는다.
   정해진 설문지를 순서대로 읽지 마라.
   되물을 필요가 없으면 follow_up_question을 null로 두어라.

6. 종료 시점을 스스로 판단하라.
   근거가 충분하면 즉시 조사를 끝내고 판정 단계로 넘긴다.
   도구를 더 부를 이유가 없으면 부르지 마라.

7. 인격을 공격하지 마라.
   "또 사시네요", "낭비입니다" 같은 표현을 절대 쓰지 마라.
   사실만 제시한다. 사용자는 우울·불안을 동반한 강박적 구매 상태일 수 있다.
   수치심을 유발하는 개입은 역효과이며 설계 위반이다.

8. 승복하라.
   대체 가능한 보유품이 없고, 예산 범위 안이며, 사용 시점이 구체적이면
   즉시 이렇게 말하고 종료한다: "확인했습니다. 구매하세요."
   무조건 반대하는 것은 이 에이전트의 실패다.

9. 기억할 가치가 있는 관찰은 write_memory로 직접 기록하라.
   단순 로그가 아니라, 다음 심문에 쓸 수 있는 패턴만 기록한다.
   매번 기록하지 마라. 새로운 패턴일 때만 기록한다.

## 처음 보는 상황
상품 정보가 부족하거나 카테고리를 모르면, 아는 범위에서만 판단하고
모르는 부분은 unverifiable로 남겨라. 정보가 없다는 이유로 구매를 반대하지 마라.

## 톤
간결하고 사실적으로. summary는 3문장을 넘기지 마라. 한국어로 답한다.
"""


# --------------------------------------------------------------------------
# 구조화 출력 — 규칙 엔진이 소비할 사실만 담는다. 판정은 담지 않는다.
# --------------------------------------------------------------------------

class Claim(BaseModel):
    text: str = Field(description="사용자 주장을 검증 가능한 한 문장으로 분해한 것")
    type: Literal["price_urgency", "necessity", "budget", "uniqueness", "other"]
    status: Literal["unverified", "supported", "refuted", "unverifiable"]
    evidence: str = Field(description="이 판단의 근거. 도구 결과를 인용한다. 없으면 빈 문자열")


class Findings(BaseModel):
    claims: list[Claim]
    specific_use_case_given: bool = Field(description="사용 시점·상황이 구체적으로 제시되었는가")
    no_owned_substitute: bool = Field(description="대체 가능한 보유품이 없음이 확인되었는가")
    verified_lowest_price: bool = Field(description="실제로 최저가임을 확인했는가. 미확인이면 false")
    price_claim_unverified: bool = Field(description="가격·희소성 주장을 검증하지 못했는가")
    alternative_found: bool
    alternative_summary: str = Field(description="대안 요약. 없으면 '대안을 찾지 못했습니다'")
    summary: str = Field(description="사용자에게 보여줄 사실 요약. 3문장 이내. 인격 언급 금지")
    follow_up_question: str | None = Field(description="가장 약한 주장 하나에 대한 되물음. 없으면 null")


class PriceCheck(BaseModel):
    """price_only 모드의 출력. 심문하지 않고 가격·대안만 본다."""

    searched: bool = Field(description="실제로 검색을 수행했는가")
    cheaper_found: bool = Field(description="현재 가격보다 싼 곳을 확인했는가. 미확인이면 false")
    best_price: int = Field(description="확인된 최저가. 확인 못 했으면 0")
    seller: str = Field(description="그 판매처 이름. 없으면 빈 문자열")
    source_url: str = Field(description="근거 URL. 없으면 빈 문자열")
    saving: int = Field(description="현재 가격 대비 절약액. 없으면 0")
    structural_alternative: str = Field(
        description="반복 구매 소모품일 때의 구조적 대안과 손익분기. 해당 없으면 빈 문자열"
    )
    note: str = Field(description="사용자에게 보여줄 2문장 이내 요약. 못 찾았으면 못 찾았다고 쓴다")


class Classification(BaseModel):
    category: str = Field(description="영문 소문자 카테고리 슬러그. 예: tumbler, water, laptop")
    is_medical: bool = Field(description="의약품·의료기기·건강 소모품인가")
    is_essential: bool = Field(description="생필품·식료품인가")
    reason: str


# --------------------------------------------------------------------------
# 분류기 — 키워드로 안 잡히는 상품만 모델에게 물어본다.
# --------------------------------------------------------------------------

_classifier = Agent(
    name="Product Classifier",
    model=CLASSIFIER_MODEL,
    instructions=(
        "상품명을 보고 카테고리를 분류한다. 의약품·의료기기·건강 소모품이면 is_medical=true, "
        "생필품·식료품이면 is_essential=true. 판단이 애매하면 false로 두되 "
        "건강 관련 가능성이 조금이라도 있으면 is_medical=true로 한다(개입하지 않는 쪽이 안전하다). "
        "어떤 언어의 상품명이든 처리한다."
    ),
    output_type=Classification,
)


async def classify(case: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Gate 0/1 입력. 키워드로 끝나면 LLM을 호출하지 않는다."""
    name = case["product"].get("name") or ""
    hint = case["product"].get("category") or ""

    category = gates.guess_category(name, hint)
    is_medical = gates.looks_medical(name, hint)
    is_essential = gates.looks_essential(name, hint)
    llm_used = False

    if category is None and not is_medical and not is_essential:
        try:
            events.emit("system", {"step": "classify", "reason": "키워드 미매치 → 분류기 호출"},
                        case_id=case["case_id"])
            res = await asyncio.wait_for(
                Runner.run(_classifier, f"상품명: {name}\n페이지 힌트: {hint}"), timeout=20
            )
            out: Classification = res.final_output
            category, is_medical, is_essential, llm_used = (
                out.category, out.is_medical, out.is_essential, True
            )
        except Exception as exc:  # noqa: BLE001 - 분류 실패가 데모를 죽이면 안 된다
            events.emit("system", {"step": "classify", "error": repr(exc), "fallback": "unknown"},
                        case_id=case["case_id"])
            category = hint or "unknown"

    category = (category or "unknown").strip().lower()
    same_30d = len([
        p for p in store.purchases_in_category(profile, category) if p["days_ago"] <= 30
    ])
    owned = sum(int(i.get("count", 1)) for i in store.owned_in_category(profile, category))

    return {
        "category": category,
        "is_medical": is_medical,
        "is_essential": is_essential,
        "same_category_30d": same_30d,
        "owned_count": owned,
        "llm_used": llm_used,
    }


# --------------------------------------------------------------------------
# Challenger Agent
# --------------------------------------------------------------------------

def build_agent() -> Agent[Ctx]:
    return Agent[Ctx](
        name="Ulysses Challenger",
        model=MODEL,
        instructions=SYSTEM_PROMPT,
        tools=[*INVESTIGATION_TOOLS, WebSearchTool()],
        output_type=Findings,
        # auto: '검색할지 말지'조차 모델이 정한다. required로 강제하면 자율성이 사라진다.
        model_settings=ModelSettings(tool_choice="auto", parallel_tool_calls=True),
    )


def build_input(case: dict[str, Any], profile: dict[str, Any], classification: dict[str, Any],
                user_reason: str) -> str:
    p = case["product"]
    memories = store.read_memory(profile["profile_id"], limit=5)
    mem_txt = "\n".join(f"- ({m['confidence']}) {m['text']}" for m in memories) or "- 없음"
    dp = case.get("dark_patterns") or []
    dp_txt = "\n".join(f"- {d['type']}: {d['evidence']}" for d in dp) or "- 탐지된 것 없음"
    retry = case.get("retry_of")

    return f"""\
[구매 사건 {case['case_id']}]
상품: {p.get('name')}
가격: {p.get('price'):,}원
카테고리(1차 분류): {classification['category']}
판매처: {p.get('url') or '알 수 없음'}
할인 문구: {p.get('discount_text') or '없음'}
상품 페이지 최초 관찰 후 경과: {case.get('dwell_minutes')}분
결제 시각: {case.get('checkout_at')}
{'재시도: 이전에 보류 판정을 받은 동일 상품이다 (' + str(retry) + ')' if retry else ''}

[페이지에서 자동 탐지된 다크패턴]
{dp_txt}

[이전 개입에서 네가 남긴 관찰]
{mem_txt}

[사용자에게 "왜 지금 사야 합니까?"라고 물었을 때의 답변]
{user_reason.strip() or '(답변 없음)'}

이 답변을 claim으로 분해하고, 필요한 도구만 골라 조사한 뒤 Findings로 보고하라.
"""


async def investigate(case: dict[str, Any], profile: dict[str, Any],
                      classification: dict[str, Any], user_reason: str,
                      note: str = "checkout") -> tuple[dict[str, Any] | None, Ctx, str | None]:
    """자율 조사 루프를 끝까지 돌린다. 사용자 입력은 여기 들어온 1회가 전부다.

    반환: (findings dict | None, 실행 컨텍스트, 오류 메시지 | None)
    """
    ctx = Ctx(case=case, profile=profile, classification=classification)
    agent = build_agent()
    prompt = build_input(case, profile, classification, user_reason)

    events.emit("system", {
        "step": "agent_run_start", "note": note, "model": MODEL,
        "tools": [t.name for t in INVESTIGATION_TOOLS] + ["web_search"],
        "input_preview": prompt,
    }, case_id=case["case_id"])

    try:
        result = Runner.run_streamed(agent, input=prompt, context=ctx, max_turns=MAX_TURNS)
        await asyncio.wait_for(_pump(result, case["case_id"]), timeout=RUN_TIMEOUT_S)
        findings: Findings = result.final_output
        events.emit("system", {"step": "agent_run_done",
                               "tool_calls": _count_tool_calls(result)}, case_id=case["case_id"])
        return findings.model_dump(), ctx, None
    except Exception as exc:  # noqa: BLE001 - 라이브 데모에서 절대 죽지 않는다
        msg = f"{type(exc).__name__}: {exc}"
        events.emit("system", {"step": "agent_run_failed", "error": msg}, case_id=case["case_id"])
        return None, ctx, msg


# --------------------------------------------------------------------------
# price_only 모드 — 심문하지 않는다. 사용자 입력 0회.
# 팝업이 뜨자마자 에이전트가 스스로 조사를 시작하고, 마찰은 걸지 않는다.
# --------------------------------------------------------------------------

PRICE_ONLY_PROMPT = """\
너는 결제 직전에 딱 하나만 확인하는 조사관이다: **이 사람이 더 싸게 살 수 있는가.**

이 구매는 심문 대상이 아니다. 구매를 막지 마라. 지연시키지 마라.
"정말 필요한가요" 같은 질문을 하지 마라. 사용자는 아무 답변도 하지 않았고, 물어볼 수도 없다.

## 절차
1. get_purchase_history로 반복 구매 소모품인지 먼저 확인한다.
   - 반복 구매라면 find_alternatives(mode='longterm_substitute')로 손익분기 계산 근거를 받고,
     web_search로 실제 대체재 가격을 찾아 손익분기 개월수를 직접 계산한다.
   - 일회성이라면 find_alternatives(mode='cheaper') 후 web_search로 다른 판매처 가격을 확인한다.
2. 검색 결과가 현재 상품과 같은 물건인지 확인하라. 규격·용량이 다르면 비교하지 마라.
3. 더 싼 곳을 찾지 못했으면 cheaper_found=false로 두고 그렇게 말한다.
   "최저가입니다"라고 단정하지 마라. 확인하지 못한 것과 최저가인 것은 다르다.

## 의약품·건강 관련 상품일 때
가격만 말한다. 복약·효능·대체 성분·구매 필요성에 대해 어떤 언급도 하지 마라.
그건 우리 영역이 아니고, 잘못 개입하면 사람이 다친다.

## 톤
note는 2문장 이내. 사실만. 한국어. 인격 언급 금지.
"""


def build_price_agent() -> Agent[Ctx]:
    return Agent[Ctx](
        name="Ulysses Price Check",
        model=MODEL,
        instructions=PRICE_ONLY_PROMPT,
        tools=[*INVESTIGATION_TOOLS, WebSearchTool()],
        output_type=PriceCheck,
        model_settings=ModelSettings(tool_choice="auto"),
    )


async def price_check(case: dict[str, Any], profile: dict[str, Any],
                      classification: dict[str, Any]) -> tuple[dict[str, Any] | None, Ctx, str | None]:
    """사용자 입력 없이 즉시 실행되는 최저가·대안 조사."""
    ctx = Ctx(case=case, profile=profile, classification=classification)
    p = case["product"]
    prompt = f"""\
[구매 사건 {case['case_id']} · price_only 모드 · 사용자 입력 없음]
상품: {p.get('name')}
현재 가격: {p.get('price'):,}원
카테고리: {classification.get('category')}
판매처: {p.get('url') or '알 수 없음'}
할인 문구: {p.get('discount_text') or '없음'}
의약품 여부: {classification.get('is_medical')}

더 싸게 살 수 있는지 지금 확인하라.
"""
    events.emit("system", {
        "step": "price_check_start", "model": MODEL,
        "note": "사용자 입력 0회. 팝업 표시와 동시에 에이전트가 스스로 시작했다.",
        "input_preview": prompt,
    }, case_id=case["case_id"])

    try:
        result = Runner.run_streamed(build_price_agent(), input=prompt, context=ctx, max_turns=10)
        await asyncio.wait_for(_pump(result, case["case_id"]), timeout=RUN_TIMEOUT_S)
        out: PriceCheck = result.final_output
        events.emit("system", {"step": "price_check_done",
                               "tool_calls": _count_tool_calls(result)}, case_id=case["case_id"])
        return out.model_dump(), ctx, None
    except Exception as exc:  # noqa: BLE001
        msg = f"{type(exc).__name__}: {exc}"
        events.emit("system", {"step": "price_check_failed", "error": msg}, case_id=case["case_id"])
        return None, ctx, msg


async def _pump(result: Any, case_id: str) -> None:
    """스트림 이벤트를 원본 그대로 세컨드 화면으로 흘린다."""
    async for ev in result.stream_events():
        if ev.type == "raw_response_event":
            events.emit("raw_response", ev.data, case_id=case_id)
        elif ev.type == "run_item_stream_event":
            item = ev.item
            if ev.name == "tool_called":
                events.emit("tool_call", item.raw_item, case_id=case_id)
            elif ev.name == "tool_output":
                events.emit("tool_result", getattr(item, "raw_item", None) or item.output,
                            case_id=case_id)
            elif ev.name == "message_output_created":
                events.emit("message", item.raw_item, case_id=case_id)


def _count_tool_calls(result: Any) -> int:
    try:
        return sum(1 for i in result.new_items if i.type == "tool_call_item")
    except Exception:  # noqa: BLE001
        return -1
