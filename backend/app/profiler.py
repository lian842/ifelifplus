"""1단계 — 상시 메모리 갱신.

개입이 일어날 때만 학습하면, 처음 개입에서 에이전트는 아무것도 모른다.
그래서 결제와 무관하게 주기적으로 한 번 돈다: 소득·고정지출·이번 달 소비·
캘린더 일정·급여일·과거 결제내역을 훑고, **기억할 가치가 있는 것만** 골라 적는다.

무엇을 적을지는 에이전트가 정한다. 전부 적으면 그건 로그지 메모리가 아니다.
적은 것은 SQLite와 파일 양쪽에 남는다. 파일은 사람이 열어볼 수 있어야 하기 때문이다.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from agents import Agent, ModelSettings, Runner
from pydantic import BaseModel, Field

from . import events, store
from .challenger import MODEL, _pump
from .tools import INVESTIGATION_TOOLS, Ctx

MEMORY_DIR = Path(__file__).resolve().parent.parent / "memory"
REFRESH_SECONDS = int(os.getenv("ULYSSES_MEMORY_REFRESH_SECONDS", "900"))

PROFILER_PROMPT = """\
너는 한 사람의 소비 데이터를 주기적으로 훑어보고, 다음 개입에서 쓸 수 있는 관찰만 기록한다.
지금은 아무도 무엇을 사려 하지 않는다. 개입 상황이 아니다. 관찰만 한다.

## 볼 것
get_budget_status, get_upcoming_events, get_purchase_history로 데이터를 확인한다.
read_memory로 이미 적어둔 것을 먼저 읽어라. 중복은 적지 않는다.

## 기록할 가치가 있는 것
- 반복되는 구매 주기 ("생수를 평균 13일마다 산다")
- 반복되는 근거 표현 ("'떨어져서'가 4회 반복된다")
- 지출이 몰리는 시점 (급여일 직후, 월말, 특정 요일)
- 예정 지출과 잔액의 충돌 ("14일 내 198,000원 예정인데 잔액은 29,000원")
- 사용하지 않는 물건이 쌓이는 카테고리
- 이전 관찰이 최근 데이터로 확인되거나 반박된 것

## 기록하지 않을 것
- 데이터를 그대로 옮긴 것 ("이번 달 271,000원을 썼다"). 그건 조회하면 나온다.
- 사람에 대한 평가 ("낭비가 심하다", "충동적이다").
  우리는 사실을 적지 사람을 규정하지 않는다. 이 메모는 나중에 사용자에게 보일 수 있다.
- 이미 read_memory에 있는 것.

## 방법
write_memory로 직접 기록한다. 0~3건이면 충분하다. 적을 것이 없으면 하나도 적지 마라.
confidence는 근거의 강도에 맞춰라. 1회 관찰은 low, 3회 이상 반복은 high.
"""


class ProfileScan(BaseModel):
    observations_written: int = Field(description="이번에 write_memory로 기록한 건수")
    summary: str = Field(description="이번 스캔에서 확인한 것을 1~2문장으로. 기록이 없으면 그렇게 쓴다")


def build_profiler() -> Agent[Ctx]:
    return Agent[Ctx](
        name="Ulysses Profiler",
        model=MODEL,
        instructions=PROFILER_PROMPT,
        tools=[t for t in INVESTIGATION_TOOLS
               if t.name in ("get_budget_status", "get_upcoming_events", "get_purchase_history",
                             "get_owned_items", "read_memory", "write_memory")],
        output_type=ProfileScan,
        model_settings=ModelSettings(tool_choice="auto"),
    )


def _scan_input(profile: dict[str, Any]) -> str:
    cats = sorted({p["category"] for p in profile.get("purchases", [])})
    return f"""\
[정기 스캔 · 개입 상황 아님 · 사용자 입력 없음]
프로필: {profile['profile_id']}
월 소득: {profile['monthly_income']:,}원 / 고정지출 {profile['fixed_expenses']:,}원
자유 예산: {profile['monthly_free_budget']:,}원 / 이번 달 사용 {profile['spent_this_month']:,}원
급여일: 매월 {profile['payday']}일
구매 이력이 있는 카테고리: {', '.join(cats) or '없음'}

데이터를 확인하고, 기억할 가치가 있는 것만 기록하라.
"""


async def scan(profile_id: str) -> dict[str, Any]:
    """프로필 1건을 훑고 메모리를 갱신한다."""
    profile = store.get_profile(profile_id)
    case = {"case_id": f"scan_{profile_id}", "profile_id": profile_id,
            "product": {"name": "", "price": 0}, "page_text": ""}
    ctx = Ctx(case=case, profile=profile, classification={})

    events.emit("system", {"step": "memory_scan_start", "profile_id": profile_id,
                           "trigger": "periodic — no user input"}, case_id=case["case_id"])
    try:
        result = Runner.run_streamed(build_profiler(), input=_scan_input(profile),
                                     context=ctx, max_turns=10)
        await asyncio.wait_for(_pump(result, case["case_id"]), timeout=90)
        out = result.final_output.model_dump()
    except Exception as exc:  # noqa: BLE001 - 백그라운드 스캔이 앱을 죽이면 안 된다
        events.emit("system", {"step": "memory_scan_failed", "error": repr(exc)},
                    case_id=case["case_id"])
        return {"profile_id": profile_id, "error": repr(exc), "observations_written": 0}

    dump_memory_file(profile_id)
    events.emit("system", {"step": "memory_scan_done", "profile_id": profile_id, **out},
                case_id=case["case_id"])
    return {"profile_id": profile_id, **out, "written_now": ctx.memories_written}


def dump_memory_file(profile_id: str) -> str:
    """메모리를 사람이 읽을 수 있는 파일로 내보낸다.

    DB만 있으면 데모 중에 '에이전트가 뭘 기억하고 있나'를 보여줄 방법이 없다.
    """
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    profile = store.get_profile(profile_id)
    rows = store.read_memory(profile_id, limit=200)
    path = MEMORY_DIR / f"{profile_id}.md"
    lines = [
        f"# 에이전트 메모리 · {profile['label']}",
        "",
        "> 에이전트가 스스로 기록한 관찰이다. 자동 로그가 아니라 기록할지 말지를 판단한 결과다.",
        "",
        f"- 월 소득 {profile['monthly_income']:,}원 / 고정지출 {profile['fixed_expenses']:,}원",
        f"- 자유 예산 {profile['monthly_free_budget']:,}원 / 이번 달 사용 {profile['spent_this_month']:,}원",
        f"- 데모 중 기록된 구매 {profile['runtime_purchase_count']}건",
        "",
        "## 관찰",
        "",
    ]
    if rows:
        for r in rows:
            lines.append(f"- `{r['confidence']}` ({r['written_at'][:16]}, {r['source']}) {r['text']}")
    else:
        lines.append("- 아직 기록된 관찰이 없습니다.")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


async def loop() -> None:
    """주기 스캔. 앱이 살아있는 동안 계속 돈다."""
    await asyncio.sleep(5)  # 기동 직후의 혼잡을 피한다
    while True:
        for pid in store.PROFILES:
            try:
                await scan(pid)
            except Exception as exc:  # noqa: BLE001
                events.emit("system", {"step": "memory_scan_error", "error": repr(exc)})
        await asyncio.sleep(REFRESH_SECONDS)
