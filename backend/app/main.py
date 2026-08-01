"""Ulysses FastAPI 앱.

파이프라인:
  POST /api/observe          상품 페이지 진입 관찰 (개입 없음, detected_at만 기록)
  POST /api/case             결제 버튼 클릭 → Gate 0 → Gate 1 → 개입 여부 결정
  POST /api/case/{id}/answer ★ 사용자 입력 1회 → 에이전트가 조사·판정·행동까지 독립 수행
  POST /api/case/{id}/resolve 사용자의 최종 결정(수용/override) 기록
  GET  /api/stream           tool_call / tool_result 원본 SSE
  GET  /viewer               세컨드 화면
  GET  /shop                 목업 쇼핑몰 (다크패턴 포함)
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from . import autopilot, challenger, events, gates, judge, store  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Ulysses — 충동구매 방어 에이전트")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 크롬 확장 content script에서 직접 호출한다
    allow_methods=["*"],
    allow_headers=["*"],
)

# 상품 페이지 최초 관찰 시각. dwell_minutes(충동성 핵심 변수)를 만들기 위한 것뿐이고
# 브라우징 기록을 보관하지 않는다. 프로세스 메모리에만 있다.
_observations: dict[str, str] = {}


# --------------------------------------------------------------------------
# 요청 모델
# --------------------------------------------------------------------------

class Product(BaseModel):
    name: str = ""
    price: int = 0
    category: str = ""
    url: str = ""
    discount_text: str = ""


class ObserveIn(BaseModel):
    profile_id: str = store.DEFAULT_PROFILE
    product: Product


class CaseIn(BaseModel):
    profile_id: str = store.DEFAULT_PROFILE
    product: Product
    page_text: str = ""
    dwell_minutes: int | None = None
    payment_method_bnpl: bool = False


class AnswerIn(BaseModel):
    reason: str = Field(default="", description='"왜 지금 사야 합니까?"에 대한 사용자 답변 1회')


class ResolveIn(BaseModel):
    action: str = Field(description="'accept' | 'override'")
    reason: str = ""


# --------------------------------------------------------------------------
# 라이프사이클
# --------------------------------------------------------------------------

@app.on_event("startup")
async def _startup() -> None:
    store.db()
    if not os.getenv("OPENAI_API_KEY"):
        events.emit("system", {"step": "warning",
                               "message": "OPENAI_API_KEY 없음. Gate 0/1은 동작하지만 에이전트 조사는 실패한다."})
    app.state.scheduler = asyncio.create_task(autopilot.loop())


@app.on_event("shutdown")
async def _shutdown() -> None:
    task = getattr(app.state, "scheduler", None)
    if task:
        task.cancel()


# --------------------------------------------------------------------------
# 관찰 → 사건 생성
# --------------------------------------------------------------------------

def _obs_key(profile_id: str, product: Product) -> str:
    return f"{profile_id}::{(product.name or product.url).strip().lower()}"


@app.post("/api/observe")
async def observe(body: ObserveIn) -> dict[str, Any]:
    """상품 페이지 진입. 개입하지 않는다. detected_at만 남긴다."""
    key = _obs_key(body.profile_id, body.product)
    _observations.setdefault(key, store.iso(store.now()))
    return {"observed": True, "detected_at": _observations[key]}


@app.post("/api/case")
async def create_case(body: CaseIn) -> dict[str, Any]:
    """결제 버튼 클릭. Gate 0 → Gate 1 → 개입 여부를 결정한다.

    여기까지는 LLM을 부르지 않는다(상품 카테고리가 키워드로 안 잡힐 때의 분류기 제외).
    """
    profile = store.get_profile(body.profile_id)
    now = store.now()
    key = _obs_key(body.profile_id, body.product)
    detected_at = _observations.get(key, store.iso(now))
    if body.dwell_minutes is not None:
        dwell = max(0, int(body.dwell_minutes))
    else:
        dwell = max(0, int((now - store.datetime.fromisoformat(detected_at)).total_seconds() // 60))

    product = body.product.model_dump()
    if not product.get("name"):
        product["name"] = "(상품 정보 추출 실패)"

    prior_hold = store.recent_hold_for(body.profile_id, product["name"])

    case: dict[str, Any] = {
        "case_id": store.new_case_id(),
        "profile_id": body.profile_id,
        "product": product,
        "detected_at": detected_at,
        "checkout_at": store.iso(now),
        "created_at": store.iso(now),
        "dwell_minutes": dwell,
        "page_text": body.page_text[:20000],
        "dark_patterns": gates.detect_dark_patterns(body.page_text),
        "payment_method_bnpl": body.payment_method_bnpl,
        "retry_of": prior_hold["case_id"] if prior_hold else None,
        "verdict": None,
        "release_at": None,
        "resolved": False,
        "parse_failed": not bool(body.product.name) or not bool(body.product.price),
    }

    events.emit("system", {
        "step": "case_created", "product": product, "dwell_minutes": dwell,
        "dark_patterns": case["dark_patterns"], "retry_of": case["retry_of"],
    }, case_id=case["case_id"])

    classification = await challenger.classify(case, profile)
    case["classification"] = classification

    for gate_fn in (lambda: gates.gate0(classification),
                    lambda: gates.gate1(case, profile, classification)):
        decision = gate_fn()
        if decision:
            case["verdict"] = decision["verdict"]
            case["resolved"] = True
            case["gate"] = decision["gate"]
            store.save_case(case)
            events.emit("system", {"step": f"gate{decision['gate']}_pass", **decision},
                        case_id=case["case_id"])
            return {
                "case_id": case["case_id"],
                "intervene": False,
                "verdict": "PASS",
                "gate": decision["gate"],
                "message": decision["reason"],
                "classification": classification,
                "budget": judge.budget_snapshot(case, profile),
            }

    store.save_case(case)
    snapshot = judge.budget_snapshot(case, profile)
    events.emit("system", {"step": "gate2_enter", "budget": snapshot}, case_id=case["case_id"])

    return {
        "case_id": case["case_id"],
        "intervene": True,
        "verdict": None,
        "gate": 2,
        "classification": classification,
        "budget": snapshot,
        "dark_patterns": case["dark_patterns"],
        "parse_failed": case["parse_failed"],
        "question": "왜 지금 사야 합니까?",
        "override_stats": store.override_stats(body.profile_id),
    }


# --------------------------------------------------------------------------
# ★ 입력 1회 → 에이전트 독립 수행
# --------------------------------------------------------------------------

@app.post("/api/case/{case_id}/answer")
async def answer(case_id: str, body: AnswerIn) -> dict[str, Any]:
    """사용자 입력은 여기 한 번뿐이다.

    이후 도구 선택, 조사 반복, 종료 시점, 대안 탐색 방식, 메모리 기록은
    모두 에이전트가 스스로 정한다. 판정만 규칙 엔진이 한다.
    """
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(404, "case not found")
    profile = store.get_profile(case["profile_id"])
    case["user_reason"] = body.reason

    findings, ctx, error = await challenger.investigate(
        case, profile, case.get("classification", {}), body.reason
    )
    case["findings"] = findings
    case["agent_error"] = error
    case["agent_actions"] = ctx.applied_actions
    case["agent_memories"] = ctx.memories_written

    verdict = judge.judge(case, profile, case.get("classification", {}), findings)
    case["judgement"] = verdict
    case["verdict"] = verdict["verdict"]
    case["release_at"] = verdict["release_at"]
    case["resolved"] = verdict["verdict"] in ("PASS", "WARN")
    store.save_case(case)

    events.emit("system", {
        "step": "verdict", "verdict": verdict["verdict"], "risk_score": verdict["risk_score"],
        "breakdown": verdict["breakdown"], "release_at": verdict["release_at"],
        "note": "판정은 LLM이 아니라 규칙 엔진이 계산했다.",
    }, case_id=case_id)

    return {
        "case_id": case_id,
        "verdict": verdict["verdict"],
        "risk_score": verdict["risk_score"],
        "breakdown": verdict["breakdown"],
        "hold_minutes": verdict["hold_minutes"],
        "release_at": verdict["release_at"],
        "capped_reason": verdict["capped_reason"],
        "summary": (findings or {}).get("summary") or _fallback_summary(error),
        "claims": (findings or {}).get("claims", []),
        "alternative": {
            "found": (findings or {}).get("alternative_found", False),
            "summary": (findings or {}).get("alternative_summary", "대안을 찾지 못했습니다"),
        },
        "follow_up_question": (findings or {}).get("follow_up_question"),
        "agent_actions": ctx.applied_actions,
        "agent_memories": ctx.memories_written,
        "budget": judge.budget_snapshot(case, profile),
        "agent_error": error,
    }


def _fallback_summary(error: str | None) -> str:
    if error:
        return "에이전트 조사에 실패했습니다. 아래 판정은 확인된 사실(예산·이력·시각)만으로 계산되었습니다."
    return "조사 결과가 비어 있습니다."


@app.post("/api/case/{case_id}/resolve")
async def resolve(case_id: str, body: ResolveIn) -> dict[str, Any]:
    """사용자의 최종 결정. override는 항상 허용하되 사유를 남긴다.

    그 문장이 다음 개입의 재료가 된다.
    """
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(404, "case not found")

    if body.action == "override":
        case["override"] = {"happened": True, "reason": body.reason,
                            "at": store.iso(store.now())}
        case["resolved"] = True
        case["release_at"] = None
        store.write_memory(
            case["profile_id"],
            f"'{case['product'].get('name')}' {case.get('verdict')} 판정을 무시하고 구매함. 사유: {body.reason}",
            "high", source="system",
        )
    else:
        case["accepted"] = {"at": store.iso(store.now())}
        # 보류를 수용하면 release_at은 유지된다 → 스케줄러가 스스로 깨운다.
        if not case.get("release_at"):
            case["resolved"] = True
    store.save_case(case)
    events.emit("system", {"step": "user_resolved", "action": body.action, "reason": body.reason},
                case_id=case_id)
    return {"ok": True, "case": case, "override_stats": store.override_stats(case["profile_id"])}


# --------------------------------------------------------------------------
# 조회
# --------------------------------------------------------------------------

@app.get("/api/profiles")
async def profiles() -> dict[str, Any]:
    return {
        "profiles": [
            {"profile_id": p["profile_id"], "label": p["label"],
             "monthly_free_budget": p["monthly_free_budget"],
             "spent_this_month": p["spent_this_month"]}
            for p in store.PROFILES.values()
        ],
        "default": store.DEFAULT_PROFILE,
    }


@app.get("/api/case/{case_id}")
async def get_case(case_id: str) -> dict[str, Any]:
    case = store.get_case(case_id)
    if not case:
        raise HTTPException(404, "case not found")
    return case


@app.get("/api/memory/{profile_id}")
async def memory(profile_id: str) -> dict[str, Any]:
    return {
        "observations": store.read_memory(profile_id, limit=50),
        "override_stats": store.override_stats(profile_id),
    }


@app.get("/api/scoring")
async def scoring() -> dict[str, Any]:
    """판정표 공개. 규칙 기반이라는 것을 심사위원이 직접 확인할 수 있다."""
    return {"scoring": judge.SCORING, "labels": judge.LABELS, "bands": judge.VERDICT_BANDS}


# --------------------------------------------------------------------------
# 원본 스트림
# --------------------------------------------------------------------------

@app.get("/api/stream")
async def stream() -> StreamingResponse:
    async def gen():
        q = events.subscribe()
        try:
            for e in events.replay():
                yield f"data: {json.dumps(e, ensure_ascii=False, default=str)}\n\n"
            while True:
                try:
                    e = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(e, ensure_ascii=False, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            events.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------
# 데모용 개발자 스위치
# --------------------------------------------------------------------------

@app.post("/api/dev/wake")
async def dev_wake() -> dict[str, Any]:
    """예약 시각을 기다리지 않고 자율 재검토를 즉시 발화시킨다.

    "지금 아무도 아무것도 누르지 않았습니다"를 3분 데모 안에서 보여주기 위한 것.
    발화 조건만 앞당길 뿐, 판단은 그대로 에이전트가 한다.
    """
    conn = store.db()
    conn.execute(
        "UPDATE purchase_cases SET release_at=? WHERE resolved=0 AND release_at IS NOT NULL",
        (store.iso(store.now() - store.timedelta(seconds=1)),),
    )
    conn.commit()
    for case in store.list_cases(limit=200):
        if not case.get("resolved") and case.get("release_at"):
            case["release_at"] = store.iso(store.now() - store.timedelta(seconds=1))
            store.save_case(case)
    results = await autopilot.run_due()
    return {"triggered": len(results), "results": results}


@app.post("/api/dev/reset")
async def dev_reset() -> dict[str, Any]:
    store.reset()
    events.clear()
    _observations.clear()
    events.emit("system", {"step": "reset"})
    return {"ok": True}


# --------------------------------------------------------------------------
# 정적 화면
# --------------------------------------------------------------------------

@app.get("/viewer")
async def viewer() -> FileResponse:
    return FileResponse(STATIC / "viewer.html")


@app.get("/shop")
async def shop() -> FileResponse:
    return FileResponse(STATIC / "shop.html")


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "name": "Ulysses",
        "viewer": "/viewer",
        "demo_shop": "/shop",
        "stream": "/api/stream",
        "docs": "/docs",
    }
