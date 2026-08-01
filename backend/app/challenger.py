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

# 조사 본체는 luna. 분류는 판단이 단순해서 더 작은 모델로 충분하다.
MODEL = os.getenv("ULYSSES_MODEL", "gpt-5.6-luna")
CLASSIFIER_MODEL = os.getenv("ULYSSES_CLASSIFIER_MODEL", "gpt-5.4-mini")
MAX_TURNS = int(os.getenv("ULYSSES_MAX_TURNS", "14"))
RUN_TIMEOUT_S = float(os.getenv("ULYSSES_TIMEOUT", "120"))


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

2-1. 다만 claim type과 무관하게 **항상 확인해야 하는 것**이 하나 있다.
   Findings의 no_owned_substitute는 규칙 엔진이 점수 계산에 직접 쓴다.
   get_owned_items를 호출하지 않고 이 값을 적어서는 안 된다.
   사용자가 필요성을 주장하지 않았어도, 같은 용도의 물건을 이미 갖고 있다는 사실은
   이 구매의 가장 중요한 맥락이다. 예를 들어 "한정판이라 지금 아니면 못 산다"는
   희소성 주장이지만, 같은 용도의 물건이 5개 있다면 그 숫자를 함께 제시해야 한다.
   보유품이 있으면 마지막 사용 시점까지 확인해 summary에 수치로 넣어라.

3. 대안 탐색 방식을 스스로 결정하라.
   get_purchase_history 결과를 먼저 확인한 뒤 mode를 정한다.
   - 반복 구매 소모품이면 mode='longterm_substitute' (구조적 대안)
   - 일회성이면 mode='cheaper'
   - 이미 보유 중이면 대안 탐색 자체를 생략한다
   find_alternatives는 계산 근거만 준다. 실제 상품·가격은 web_search로 확인해서 채워라.

3-1. 최저가는 반드시 가격비교 사이트를 겨냥해서 찾아라.
   get_price_comparison_sources를 먼저 호출해 검색 전략을 받고,
   거기서 준 쿼리로 web_search를 실행하라. 다나와·에누리·네이버쇼핑이 우선이다.
   그냥 "상품명 최저가"로 검색하면 블로그와 광고글이 걸려 엉뚱한 가격을 물어온다.
   찾은 판매처는 offers 배열에 가격 오름차순으로 담고, 각각 근거 URL을 붙여라.
   모델명·용량·수량이 정확히 같은 것만 담아라. 규격이 다르면 비교가 아니라 오해다.
   배송비 별도면 note에 적어라. 표기가만 싸고 총액이 비싼 경우가 흔하다.

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
   단, **시작한 계산은 끝내라.** find_alternatives로 손익분기 계산 근거를 받아놓고
   숫자를 내지 않은 채 끝내는 것은 조사 실패다.

7. 인격을 공격하지 마라.
   "또 사시네요", "낭비입니다" 같은 표현을 절대 쓰지 마라.
   사실만 제시한다. 사용자는 우울·불안을 동반한 강박적 구매 상태일 수 있다.
   수치심을 유발하는 개입은 역효과이며 설계 위반이다.

8. 승복하라.
   대체 가능한 보유품이 없고, 예산 범위 안이며, 사용 시점이 구체적이면
   즉시 이렇게 말하고 종료한다: "확인했습니다. 구매하세요."
   무조건 반대하는 것은 이 에이전트의 실패다.

9. 조사를 마치기 전에 한 번 판단하라: 이번에 새로 알게 된 패턴이 있는가?
   있으면 write_memory로 직접 기록한다. 없으면 기록하지 않는다. 판단은 네가 한다.
   기록할 가치가 있는 것의 예:
   - 특정 단어("한정판", "오늘만")가 나올 때 이 사용자가 보이는 반응
   - 같은 근거가 반복해서 등장하는 것 ("떨어져서"가 3번째다)
   - 이전 관찰이 이번에 맞았거나 틀렸다는 확인
   단순 사실("생수를 샀다")은 기록하지 마라. 그건 구매 이력이 이미 갖고 있다.
   read_memory로 읽은 내용과 중복되면 기록하지 마라.

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
    offers: list[PriceOffer] = Field(
        description="더 싼 판매처 목록. 가격 오름차순. 확인 못 했으면 빈 배열"
    )
    cheaper_price: int = Field(description="확인된 최저가. 못 찾았으면 0")
    specific_use_case_given: bool = Field(description="사용 시점·상황이 구체적으로 제시되었는가")
    no_owned_substitute: bool = Field(description="대체 가능한 보유품이 없음이 확인되었는가")
    verified_lowest_price: bool = Field(description="실제로 최저가임을 확인했는가. 미확인이면 false")
    price_claim_unverified: bool = Field(description="가격·희소성 주장을 검증하지 못했는가")
    alternative_found: bool
    alternative_summary: str = Field(description="대안 요약. 없으면 '대안을 찾지 못했습니다'")
    annual_saving: int = Field(
        description="구조적 대안으로 바꿨을 때의 연간 절약액(원). 계산 못 했으면 0. 추정하지 말 것"
    )
    summary: str = Field(description="사용자에게 보여줄 사실 요약. 3문장 이내. 인격 언급 금지")
    follow_up_question: str | None = Field(description="가장 약한 주장 하나에 대한 되물음. 없으면 null")


class QuestionOption(BaseModel):
    id: str = Field(description="선택지 식별자. opt1, opt2 ... 형태")
    label: str = Field(description="사용자에게 보이는 문장. 1줄")
    implies: str = Field(description="이 선택이 의미하는 claim type. price_urgency/necessity/budget/uniqueness/other")


class Question(BaseModel):
    """개입 팝업에서 사용자에게 던질 질문. 형식까지 에이전트가 정한다."""

    format: Literal["choice", "text"]
    text: str = Field(description="질문 문장. 고정 문구를 쓰지 말고 이 상품·이 이력에 맞게 쓴다")
    options: list[QuestionOption] = Field(description="format='choice'일 때 2~4개. 'text'면 빈 배열")
    allow_free_text: bool = Field(description="객관식이어도 직접 입력을 함께 허용할지")
    free_text_placeholder: str = Field(description="자유 입력칸의 예시 문구. 없으면 빈 문자열")
    reason: str = Field(description="왜 이 형식을 골랐는지 한 문장. 심사위원에게 설계 의도를 보여주는 값")


class PriceOffer(BaseModel):
    seller: str = Field(description="판매처 이름")
    price: int = Field(description="확인된 가격(원). 배송비 별도면 note에 적는다")
    url: str = Field(description="근거 URL. 없으면 빈 문자열")
    note: str = Field(description="배송비·조건 등 단서. 없으면 빈 문자열")


class PriceCheck(BaseModel):
    """price_only 모드의 출력. 심문하지 않고 가격·대안만 본다."""

    searched: bool = Field(description="실제로 검색을 수행했는가")
    cheaper_found: bool = Field(description="현재 가격보다 싼 곳을 확인했는가. 미확인이면 false")
    best_price: int = Field(description="확인된 최저가. 확인 못 했으면 0")
    seller: str = Field(description="그 판매처 이름. 없으면 빈 문자열")
    source_url: str = Field(description="근거 URL. 없으면 빈 문자열")
    saving: int = Field(description="현재 가격 대비 절약액. 없으면 0")
    offers: list[PriceOffer] = Field(
        description="확인된 판매처 목록. 가격 오름차순. 확인 못 했으면 빈 배열"
    )
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
# 3단계 — 질문 생성. 무거운 조사(플래닝 모드) 앞에 놓이는 가벼운 한 박자.
#
# 이 단계의 목적은 정보 수집만이 아니다. 결제 버튼에서 손을 떼게 하는 것 자체가 개입이다.
# 그래서 답하기 쉬워야 한다. 긴 서술을 요구하면 사용자는 아무거나 쓰고 넘어간다.
# 형식(객관식/주관식)은 에이전트가 이 상품과 이 사람의 이력을 보고 정한다.
# --------------------------------------------------------------------------

QUESTION_PROMPT = """\
너는 결제 직전에 사용자에게 던질 질문 하나를 설계한다. 조사는 아직 하지 않는다.

## 목적
1) 이 구매의 근거를 한 조각 확보한다.
2) 결제 버튼에서 손을 떼게 한다. 답하기 쉬워야 손을 뗀다.

## 형식 선택 (네가 정한다)
- choice : 기본값. 이 상품에서 나올 법한 답이 몇 가지로 좁혀질 때.
           선택지는 2~4개. 서로 겹치지 않게.
- text   : 처음 보는 종류의 상품이라 선택지를 만들면 오히려 답을 왜곡할 때만.

## 길이 제한
- 질문은 핵심만 남긴 짧은 한 문장으로 쓴다. 공백 포함 30자를 넘기지 마라.
- 선택지 label은 각각 공백 포함 16자를 넘기지 마라.
- 상품명을 질문에서 길게 반복하지 마라. 상품명은 화면에 따로 표시된다.
- 배경 설명, 인사말, 판단이나 충고를 질문에 넣지 마라.

## 선택지를 만드는 법
- get_purchase_history로 **과거에 이 사용자가 실제로 댄 근거**를 먼저 확인하라.
  같은 근거가 또 나올 것 같으면 그것을 선택지에 그대로 넣어라.
  ("지난번에도 '보온력이 더 좋아서'라고 답하셨습니다" 같은 대조가 여기서 만들어진다)
- read_memory로 이전에 네가 남긴 관찰을 확인하고, 반복되는 패턴이 있으면 반영하라.
- 보유품이 있으면 get_owned_items로 확인해 "기존 것으로 안 되는 이유"를 물어라.
- 각 선택지에 implies를 붙여라. 그게 다음 단계의 claim type이 된다.

## 금지
- "정말 필요한가요?" 같은 죄책감을 유도하는 문장. 사용자는 강박적 구매 상태일 수 있다.
- 정답이 뻔한 선택지("낭비인 것 같다" 같은 것). 사실을 얻지 못한다.
- 5개 이상의 선택지. 읽는 데 시간이 걸리면 아무거나 누른다.
- 도구를 3개 넘게 부르지 마라. 이 단계는 빨라야 한다.

## 톤
짧고 바로 이해되는 1문장. 한국어. 고정 문구를 쓰지 마라 — 이 상품에 맞는 질문을 써라.
"""


def build_question_agent() -> Agent[Ctx]:
    return Agent[Ctx](
        name="Ulysses Question Designer",
        model=MODEL,
        instructions=QUESTION_PROMPT,
        tools=[t for t in INVESTIGATION_TOOLS
               if t.name in ("get_purchase_history", "get_owned_items", "read_memory")],
        output_type=Question,
        model_settings=ModelSettings(tool_choice="auto"),
    )


DEFAULT_QUESTION = {
    "format": "text",
    "text": "왜 지금 사야 합니까?",
    "options": [],
    "allow_free_text": True,
    "free_text_placeholder": "예: 다음 주 등산에 쓸 건데 기존 것은 용량이 부족해요",
    "reason": "질문 생성에 실패해 기본 질문으로 대체했습니다.",
}


async def make_question(case: dict[str, Any], profile: dict[str, Any],
                        classification: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """개입 팝업에 띄울 질문을 만든다. 실패해도 기본 질문으로 반드시 하나는 돌려준다."""
    ctx = Ctx(case=case, profile=profile, classification=classification)
    p = case["product"]
    prompt = f"""\
[구매 사건 {case['case_id']} · 질문 설계 단계]
상품: {p.get('name')} / {p.get('price'):,}원
카테고리: {classification.get('category')}
할인 문구: {p.get('discount_text') or '없음'}
발견 후 {case.get('dwell_minutes')}분 만에 결제 시도
이례 신호: {', '.join(case.get('mode', {}).get('unusual_reasons', [])) or '없음'}

이 사람에게 던질 질문 하나를 설계하라.
"""
    events.emit("system", {"step": "question_design_start", "input_preview": prompt},
                case_id=case["case_id"])
    try:
        result = Runner.run_streamed(build_question_agent(), input=prompt, context=ctx, max_turns=6)
        await asyncio.wait_for(_pump(result, case["case_id"]), timeout=45)
        q: Question = result.final_output
        out = q.model_dump()
        if q.format == "choice" and len(q.options) < 2:
            out = DEFAULT_QUESTION | {"text": q.text or DEFAULT_QUESTION["text"]}
        events.emit("system", {"step": "question_design_done", "question": out},
                    case_id=case["case_id"])
        return out, None
    except Exception as exc:  # noqa: BLE001 - 질문이 없으면 개입 자체가 멈춘다
        msg = f"{type(exc).__name__}: {exc}"
        events.emit("system", {"step": "question_design_failed", "error": msg},
                    case_id=case["case_id"])
        return dict(DEFAULT_QUESTION), msg


# --------------------------------------------------------------------------
# 4단계 — 플래닝 모드 (Challenger Agent)
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
                user_reason: str, want_alternatives: bool = True) -> str:
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
판매처: {(case.get('site') or {}).get('site_name') or '알 수 없음'} ({p.get('url') or 'URL 없음'})
{(case.get('site') or {}).get('site_note') or ''}
{(case.get('site') or {}).get('conversion_note') or ''}
할인 문구: {p.get('discount_text') or '없음'}
상품 페이지 최초 관찰 후 경과: {case.get('dwell_minutes')}분
결제 시각: {case.get('checkout_at')}
{'재시도: 이전에 보류 판정을 받은 동일 상품이다 (' + str(retry) + ')' if retry else ''}

[페이지에서 자동 탐지된 다크패턴]
{dp_txt}

[이전 개입에서 네가 남긴 관찰]
{mem_txt}

[네가 설계한 질문]
{(case.get('question') or {}).get('text') or '왜 지금 사야 합니까?'}

[사용자의 답변]
{user_reason.strip() or '(답변 없음)'}

[사용자가 "다른 가격·상품을 찾아달라"에 답한 것]
{'예 — 더 싼 판매처와 대안을 찾아 제시하라.' if want_alternatives
 else '아니오 — 대안 탐색은 하지 마라. 주장 검증에만 집중하라. offers는 빈 배열로 둔다.'}

이 답변을 claim으로 분해하고, 필요한 도구만 골라 조사한 뒤 Findings로 보고하라.
"""


async def investigate(case: dict[str, Any], profile: dict[str, Any],
                      classification: dict[str, Any], user_reason: str,
                      want_alternatives: bool = True,
                      note: str = "checkout") -> tuple[dict[str, Any] | None, Ctx, str | None]:
    """자율 조사 루프를 끝까지 돌린다. 사용자 입력은 여기 들어온 1회가 전부다.

    반환: (findings dict | None, 실행 컨텍스트, 오류 메시지 | None)
    """
    ctx = Ctx(case=case, profile=profile, classification=classification)
    agent = build_agent()
    prompt = build_input(case, profile, classification, user_reason, want_alternatives)

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
0. get_price_comparison_sources를 먼저 호출해 검색 전략을 받는다.
   다나와·에누리·네이버쇼핑을 겨냥한 쿼리로 web_search를 실행하라.
   "상품명 최저가"로만 검색하면 블로그·광고글이 걸린다.
   찾은 판매처는 offers에 가격 오름차순으로 담고 각각 근거 URL을 붙여라.
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
