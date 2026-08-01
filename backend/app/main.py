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

from . import autopilot, challenger, events, gates, judge, profiler, sites, store  # noqa: E402

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
    currency: str = ""  # 비우면 URL에서 사이트를 찾아 추론한다 (amazon.com → USD)


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
    """3단계 응답. 객관식 선택 + 자유 입력 + 대안 탐색 Yes/No."""

    selected_option_ids: list[str] = Field(default_factory=list, description="고른 선택지 id")
    reason: str = Field(default="", description="자유 입력. 객관식만 골랐으면 빈 문자열")
    want_alternatives: bool = Field(default=True, description='"다른 가격·상품을 찾아줄까요?"의 답')


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
    # 두 루프 모두 사용자 입력 없이 돈다.
    #  scheduler : 보류된 사건의 재검토 시각이 되면 스스로 깨어난다
    #  profiler  : 결제와 무관하게 주기적으로 소비 데이터를 훑고 메모리를 갱신한다
    app.state.scheduler = asyncio.create_task(autopilot.loop())
    app.state.profiler = (asyncio.create_task(profiler.loop())
                          if os.getenv("ULYSSES_PROFILER", "1") == "1" else None)


@app.on_event("shutdown")
async def _shutdown() -> None:
    for name in ("scheduler", "profiler"):
        task = getattr(app.state, name, None)
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
    parse_failed = not product.get("name") or not int(product.get("price") or 0)
    if not product.get("name"):
        product["name"] = "(상품 정보 추출 실패)"

    # 어느 쇼핑몰인지 식별하고 가격을 원화로 정규화한다.
    # 모르는 사이트여도 실패하지 않는다 — 예산 계산만 원화 기준으로 맞춘다.
    site = sites.resolve(product.get("url"), int(product.get("price") or 0),
                         product.get("currency") or None)
    product["price"] = site["price_krw"]
    product["price_original"] = site["price_original"]
    product["currency"] = site["currency"]

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
        "site": site,
        "retry_of": prior_hold["case_id"] if prior_hold else None,
        "verdict": None,
        "release_at": None,
        "resolved": False,
        "parse_failed": parse_failed,
    }

    events.emit("system", {
        "step": "case_created", "product": product, "dwell_minutes": dwell,
        "dark_patterns": case["dark_patterns"], "retry_of": case["retry_of"],
        "parse_failed": parse_failed,
    }, case_id=case["case_id"])

    # 처음 보는 쇼핑몰: 상품·가격을 못 읽었다. 없는 사실로 마찰을 걸지 않고,
    # 못 읽었다는 사실만 정직하게 알린다. 조용히 통과시키지도 않는다.
    if parse_failed:
        case["verdict"] = "PASS"
        case["resolved"] = True
        case["gate"] = -1
        store.save_case(case)
        events.emit("system", {"step": "parse_failed_passthrough"}, case_id=case["case_id"])
        return {
            "case_id": case["case_id"],
            "intervene": False,
            "verdict": "PASS",
            "gate": -1,
            "parse_failed": True,
            "message": "이 페이지에서 상품 정보를 추출하지 못했습니다. "
                       "확인되지 않은 정보로 판단하지 않습니다. 결제를 막지 않습니다.",
            "classification": None,
            "budget": judge.budget_snapshot(case, profile),
        }

    classification = await challenger.classify(case, profile)
    case["classification"] = classification

    mode = gates.decide_mode(case, profile, classification)
    case["mode"] = mode
    store.save_case(case)
    snapshot = judge.budget_snapshot(case, profile)
    events.emit("system", {"step": "mode_decided", **mode, "budget": snapshot},
                case_id=case["case_id"])

    base = {
        "case_id": case["case_id"],
        "intervene": True,          # 어떤 구매도 그냥 통과시키지 않는다
        "site": site,
        "mode": mode["mode"],
        "no_friction": mode["no_friction"],
        "gate": mode["gate"],
        "mode_reason": mode["reason"],
        "classification": classification,
        "budget": snapshot,
        "dark_patterns": case["dark_patterns"],
        "parse_failed": case["parse_failed"],
        "override_stats": store.override_stats(body.profile_id),
    }

    # price_only: 사용자에게 아무것도 묻지 않는다. 지금 바로 에이전트가 조사한다.
    if mode["mode"] == "price_only":
        price, ctx, error = await challenger.price_check(case, profile, classification)
        case["price_check"] = price
        case["agent_error"] = error
        case["verdict"] = "PASS"
        case["resolved"] = True
        store.save_case(case)
        events.emit("system", {"step": "price_only_done", "result": price, "error": error},
                    case_id=case["case_id"])
        return {**base, "verdict": "PASS", "price_check": price, "agent_error": error}

    # challenge: 3단계 질문을 에이전트가 설계한다. 객관식/주관식도 에이전트가 정한다.
    question, q_error = await challenger.make_question(case, profile, classification)
    case["question"] = question
    store.save_case(case)
    return {
        **base,
        "verdict": None,
        "question": question,
        "alternatives_prompt": "다른 가격이나 대안 상품을 찾아드릴까요?",
        "question_error": q_error,
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

    # 객관식 선택과 자유 입력을 하나의 답변 문장으로 합친다.
    question = case.get("question") or {}
    chosen = [o["label"] for o in question.get("options", [])
              if o["id"] in body.selected_option_ids]
    parts = list(chosen)
    if body.reason.strip():
        parts.append(body.reason.strip())
    user_reason = " / ".join(parts)

    case["user_reason"] = user_reason
    case["selected_options"] = chosen
    case["want_alternatives"] = body.want_alternatives

    findings, ctx, error = await challenger.investigate(
        case, profile, case.get("classification", {}), user_reason,
        want_alternatives=body.want_alternatives,
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
        "savings": judge.savings_snapshot(case, profile, findings),
        "question": case.get("question"),
        "answered": {"selected": chosen, "free_text": body.reason,
                     "want_alternatives": body.want_alternatives},
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

    bought = False
    if body.action == "override":
        # 보류를 무시하고 구매. 막지 않되 사유를 남긴다.
        case["override"] = {"happened": True, "reason": body.reason,
                            "at": store.iso(store.now())}
        if body.reason.strip():
            case["user_reason"] = ((case.get("user_reason") or "") + " / " + body.reason).strip(" /")
        case["resolved"] = True
        case["release_at"] = None
        bought = True
        store.write_memory(
            case["profile_id"],
            f"'{case['product'].get('name')}' {case.get('verdict')} 판정을 무시하고 구매함. 사유: {body.reason}",
            "high", source="system",
        )
    else:
        case["accepted"] = {"at": store.iso(store.now())}
        # PASS/WARN을 수용했다는 것은 그대로 결제했다는 뜻이다.
        # HOLD/STRONG_HOLD를 수용했다면 사지 않은 것이고, release_at은 유지된다
        # → 스케줄러가 사용자 입력 없이 스스로 깨어난다.
        bought = case.get("verdict") in ("PASS", "WARN", None)
        if not case.get("release_at"):
            case["resolved"] = True

    # 실제 구매는 이력에 남는다. 같은 물건을 또 사면 다음 개입이 그것을 안다.
    if bought:
        pid = store.record_purchase(case["profile_id"], case, body.action == "override")
        case["recorded_purchase_id"] = pid

    store.save_case(case)
    events.emit("system", {
        "step": "user_resolved", "action": body.action, "reason": body.reason,
        "purchase_recorded": bought,
        "note": "구매가 이력에 기록되어 다음 개입의 조사 대상이 된다." if bought else None,
    }, case_id=case_id)
    return {
        "ok": True,
        "purchase_recorded": bought,
        "case": case,
        "override_stats": store.override_stats(case["profile_id"]),
        "budget": judge.budget_snapshot(case, store.get_profile(case["profile_id"])),
    }


# --------------------------------------------------------------------------
# 조회
# --------------------------------------------------------------------------

@app.get("/api/profiles")
async def profiles() -> dict[str, Any]:
    out = []
    for pid in store.PROFILES:
        p = store.get_profile(pid)  # 런타임 구매가 반영된 현재 상태
        out.append({
            "profile_id": p["profile_id"],
            "label": p["label"],
            "persona": p.get("persona"),
            "monthly_income": p["monthly_income"],
            "fixed_expenses": p["fixed_expenses"],
            "monthly_free_budget": p["monthly_free_budget"],
            "spent_this_month": p["spent_this_month"],
            "remaining": p["monthly_free_budget"] - p["spent_this_month"],
            "runtime_purchase_count": p["runtime_purchase_count"],
        })
    return {"profiles": out, "default": store.DEFAULT_PROFILE}


@app.get("/api/sites")
async def supported_sites() -> dict[str, Any]:
    """지원 쇼핑몰 목록. 확장 프로그램이 어느 호스트에 주입할지 결정할 때 쓴다."""
    return {"sites": sites.public_list(), "rates": sites.RATES}


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
        "file": profiler.dump_memory_file(profile_id),
        "purchases_recorded": store.runtime_purchases(profile_id),
    }


@app.post("/api/memory/{profile_id}/scan")
async def memory_scan(profile_id: str) -> dict[str, Any]:
    """1단계 상시 스캔을 즉시 1회 실행한다.

    평소에는 백그라운드에서 주기적으로 돈다. 이 엔드포인트는 데모에서
    '개입이 없어도 에이전트가 학습하고 있다'를 보여주기 위한 것이다.
    """
    return await profiler.scan(profile_id)


@app.get("/api/scoring")
async def scoring() -> dict[str, Any]:
    """판정표 공개. 규칙 기반이라는 것을 심사위원이 직접 확인할 수 있다."""
    return {"scoring": judge.SCORING, "labels": judge.LABELS, "bands": judge.VERDICT_BANDS}


# --------------------------------------------------------------------------
# 원본 스트림
# --------------------------------------------------------------------------

@app.get("/api/events")
async def events_buffer(case_id: str | None = None, channel: str | None = None) -> dict[str, Any]:
    """스트림 버퍼 조회. 뷰어를 새로 붙이지 않고도 어떤 도구가 어떤 순서로 불렸는지 확인한다."""
    out = events.replay()
    if case_id:
        out = [e for e in out if e.get("case_id") == case_id]
    if channel:
        wanted = set(channel.split(","))
        out = [e for e in out if e["channel"] in wanted]
    return {"count": len(out), "events": out}


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
