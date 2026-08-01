"""자율 재실행 — 사용자 입력 0회.

대회 규칙: "입력 1회 → 에이전트가 툴 호출·판단·출력까지 독립 수행."
여기가 그 규칙에 정면으로 대응하는 장치다. 보류(HOLD)가 걸리면 release_at이 등록되고,
그 시각이 지나면 **아무도 아무것도 누르지 않아도** 에이전트가 스스로 깨어나
가격을 다시 확인하고, 그 사이 유사 구매가 있었는지 조회하고, 스스로 결론을 낸다.

결론은 세 가지뿐이고 모두 에이전트가 고른다:
  release_ok  — "지금은 사도 됩니다"
  keep_hold   — 근거가 그대로다. 보류를 유지한다
  close       — 사용자가 이미 잊었거나 필요가 사라졌다. 사건을 종결한다
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Literal

from agents import Agent, ModelSettings, Runner, WebSearchTool
from pydantic import BaseModel, Field

from . import events, store
from .challenger import MODEL, RUN_TIMEOUT_S, _pump
from .tools import INVESTIGATION_TOOLS, Ctx

POLL_SECONDS = int(os.getenv("ULYSSES_POLL_SECONDS", "20"))

REVIEW_PROMPT = """\
너는 보류된 구매 사건을 스스로 재검토하는 조사관이다.
사용자는 이 재검토를 요청하지 않았다. 보류 시간이 끝나서 네가 스스로 깨어난 것이다.

## 해야 할 일
1. 보류 당시의 근거가 아직 유효한지 확인한다.
2. 가격이 바뀌었는지 web_search로 확인한다. 확인하지 못하면 확인하지 못했다고 말한다.
3. 보류 이후 같은 카테고리에서 구매가 있었는지 get_purchase_history로 확인한다.
   (있었다면 이 구매는 이제 불필요할 가능성이 높다)
4. 예산 상황이 달라졌는지 확인한다.

## 결론
셋 중 하나를 고른다.
- release_ok : 근거가 해소되었다. "지금은 사도 됩니다"라고 알린다.
- keep_hold  : 근거가 그대로다. 보류를 유지한다.
- close      : 그 사이 대체 구매가 있었거나 필요가 사라졌다. 사건을 종결한다.

## 원칙
- 보류를 유지하는 쪽으로 기울지 마라. 24시간이 지나도 여전히 필요하다는 것은
  충동이 아니었다는 강한 증거다. 그럴 땐 release_ok가 정답이다.
- 확인하지 못한 것을 추측하지 마라.
- 이번 재검토에서 새로 알게 된 패턴이 있으면 write_memory로 기록하라.
- message는 사용자에게 그대로 알림으로 나간다. 2문장 이내, 사실만. 한국어.
"""


class ReviewOutcome(BaseModel):
    decision: Literal["release_ok", "keep_hold", "close"]
    price_checked: bool = Field(description="가격을 실제로 확인했는가")
    price_note: str = Field(description="가격 확인 결과. 못 했으면 '확인하지 못했습니다'")
    new_purchase_since_hold: bool
    message: str = Field(description="사용자에게 보낼 알림. 2문장 이내")


def build_review_agent() -> Agent[Ctx]:
    return Agent[Ctx](
        name="Ulysses Auto-Review",
        model=MODEL,
        instructions=REVIEW_PROMPT,
        tools=[*INVESTIGATION_TOOLS, WebSearchTool()],
        output_type=ReviewOutcome,
        model_settings=ModelSettings(tool_choice="auto"),
    )


def _review_input(case: dict[str, Any]) -> str:
    p = case["product"]
    v = case.get("judgement") or {}
    reasons = ", ".join(b["label"] for b in v.get("breakdown", [])) or "기록 없음"
    return f"""\
[자율 재검토 · 트리거: 예약된 재검토 시각 도달 · 사용자 입력 없음]
사건: {case['case_id']}
상품: {p.get('name')} / {p.get('price'):,}원 / 카테고리 {case.get('classification', {}).get('category')}
판매처: {p.get('url') or '알 수 없음'}
보류 판정: {case.get('verdict')} (위험 점수 {v.get('risk_score')})
보류 사유: {reasons}
보류 시작: {case.get('checkout_at')}
재검토 예정 시각: {case.get('release_at')}
당시 사용자의 구매 근거: {case.get('user_reason') or '(없음)'}

지금 스스로 확인하고 결론을 내라.
"""


async def review_case(case: dict[str, Any]) -> dict[str, Any]:
    """사건 1건을 자율 재검토하고 결과를 사건에 기록한다."""
    profile = store.get_profile(case["profile_id"])
    ctx = Ctx(case=case, profile=profile, classification=case.get("classification", {}))

    events.emit("system", {
        "step": "autonomous_wakeup",
        "trigger": "release_at reached — no user input",
        "case_id": case["case_id"],
        "scheduled_for": case.get("release_at"),
    }, case_id=case["case_id"])

    outcome: dict[str, Any]
    try:
        result = Runner.run_streamed(build_review_agent(), input=_review_input(case),
                                     context=ctx, max_turns=10)
        await asyncio.wait_for(_pump(result, case["case_id"]), timeout=RUN_TIMEOUT_S)
        outcome = result.final_output.model_dump()
    except Exception as exc:  # noqa: BLE001 - 백그라운드에서 절대 죽지 않는다
        events.emit("system", {"step": "autonomous_review_failed", "error": repr(exc)},
                    case_id=case["case_id"])
        outcome = {
            "decision": "keep_hold",
            "price_checked": False,
            "price_note": "확인하지 못했습니다",
            "new_purchase_since_hold": False,
            "message": "재검토 중 오류가 발생해 보류를 유지합니다.",
        }

    case.setdefault("auto_reviews", []).append({"at": store.iso(store.now()), **outcome})
    case["resolved"] = outcome["decision"] in ("release_ok", "close")
    case["release_at"] = None if case["resolved"] else store.iso(
        store.now() + store.timedelta(minutes=30)
    )
    case["auto_review_actions"] = ctx.applied_actions
    store.save_case(case)

    events.emit("system", {"step": "autonomous_review_done", **outcome}, case_id=case["case_id"])
    return outcome


async def run_due(now: Any = None) -> list[dict[str, Any]]:
    """지금 시점에 재검토 대상인 사건을 전부 처리한다."""
    due = store.pending_reviews(now)
    out = []
    for case in due:
        out.append({"case_id": case["case_id"], "outcome": await review_case(case)})
    return out


async def loop() -> None:
    """백그라운드 루프. 앱이 살아있는 동안 계속 돈다."""
    events.emit("system", {"step": "scheduler_started", "poll_seconds": POLL_SECONDS})
    while True:
        try:
            await run_due()
        except Exception as exc:  # noqa: BLE001
            events.emit("system", {"step": "scheduler_error", "error": repr(exc)})
        await asyncio.sleep(POLL_SECONDS)
