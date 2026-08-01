"""SQLite 저장소 + 시드 프로필.

로컬 우선(local-first). 브라우징 기록이나 금융 원장은 저장하지 않는다.
저장하는 것은 (1) 사용자가 직접 등록한 예산/보유물품, (2) 개입이 일어난 구매 사건,
(3) 에이전트가 직접 기록하기로 판단한 관찰뿐이다.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

KST = timezone(timedelta(hours=9))
DB_PATH = Path(__file__).resolve().parent.parent / "ulysses.db"


def now() -> datetime:
    return datetime.now(KST)


def iso(dt: datetime) -> str:
    return dt.isoformat()


# --------------------------------------------------------------------------
# 시드 프로필 2종
#
# 데모의 핵심: 같은 상품(생수 2L x 6)을 두 프로필이 결제하면
# 에이전트가 서로 다른 도구를 서로 다른 순서로 호출한다.
#   A -> 이력 없음 -> mode='cheaper' -> 즉시 PASS
#   B -> 3개월 7회 -> mode='longterm_substitute' -> 구조적 대안 탐색
# --------------------------------------------------------------------------

PROFILES: dict[str, dict[str, Any]] = {
    "A": {
        "profile_id": "A",
        "label": "프로필 A · 생수 첫 구매 / 예산 여유",
        "monthly_income": 2_600_000,
        "fixed_expenses": 1_100_000,
        "monthly_free_budget": 400_000,
        "spent_this_month": 120_000,
        "payday": 25,
        "hourly_wage": 12_000,
        "owned_items": [
            {"category": "tumbler", "name": "스탠리 텀블러", "count": 1, "last_used_days_ago": 1},
        ],
        "purchases": [
            {"category": "book", "name": "소설책", "price": 15_000, "days_ago": 20,
             "justification": "읽고 싶었어요", "used": True},
        ],
        "upcoming_events": [],
    },
    "B": {
        "profile_id": "B",
        "label": "프로필 B · 생수 반복 구매 / 예산 소진 임박",
        "monthly_income": 2_300_000,
        "fixed_expenses": 1_250_000,
        "monthly_free_budget": 300_000,
        "spent_this_month": 271_000,
        "payday": 25,
        "hourly_wage": 10_500,
        "owned_items": [
            {"category": "tumbler", "name": "스탠리 텀블러", "count": 1, "last_used_days_ago": 40},
            {"category": "tumbler", "name": "스타벅스 한정판 텀블러", "count": 2, "last_used_days_ago": 65},
            {"category": "tumbler", "name": "무인양품 보온병", "count": 2, "last_used_days_ago": 90},
            {"category": "shoes", "name": "러닝화", "count": 4, "last_used_days_ago": 12},
        ],
        "purchases": [
            {"category": "water", "name": "생수 2L x 6", "price": 7_900, "days_ago": 6,
             "justification": "떨어져서 샀어요", "used": True},
            {"category": "water", "name": "생수 2L x 6", "price": 8_400, "days_ago": 18,
             "justification": "무거워서 배달이 편해요", "used": True},
            {"category": "water", "name": "생수 500ml x 20", "price": 9_900, "days_ago": 27,
             "justification": "행사 중이라 쟁여두려고", "used": True},
            {"category": "water", "name": "생수 2L x 6", "price": 7_900, "days_ago": 39,
             "justification": "떨어져서", "used": True},
            {"category": "water", "name": "생수 2L x 6", "price": 8_900, "days_ago": 52,
             "justification": "쿠폰이 있어서", "used": True},
            {"category": "water", "name": "생수 2L x 12", "price": 15_800, "days_ago": 68,
             "justification": "대용량이 더 싸서", "used": True},
            {"category": "water", "name": "생수 2L x 6", "price": 8_400, "days_ago": 84,
             "justification": "떨어져서", "used": True},
            {"category": "tumbler", "name": "한정판 텀블러", "price": 59_000, "days_ago": 44,
             "justification": "한정판이라 지금 아니면 못 사요", "used": False},
            {"category": "tumbler", "name": "보온 텀블러", "price": 59_000, "days_ago": 91,
             "justification": "보온력이 더 좋아서", "used": False},
        ],
        "upcoming_events": [
            {"title": "결혼식", "days_from_now": 8, "estimated_cost": 100_000},
            {"title": "생일 모임", "days_from_now": 11, "estimated_cost": 50_000},
        ],
    },
}

DEFAULT_PROFILE = "B"


# --------------------------------------------------------------------------
# 스키마
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS purchase_cases (
    case_id      TEXT PRIMARY KEY,
    profile_id   TEXT NOT NULL,
    payload      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    release_at   TEXT,
    verdict      TEXT,
    resolved     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   TEXT NOT NULL,
    written_at   TEXT NOT NULL,
    text         TEXT NOT NULL,
    confidence   TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'agent'
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


_conn: sqlite3.Connection | None = None


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = connect()
        _conn.executescript(SCHEMA)
        _conn.commit()
    return _conn


def reset() -> None:
    """데모 리허설용 초기화. 시드 프로필은 코드 상수라 영향 없음."""
    conn = db()
    conn.execute("DELETE FROM purchase_cases")
    conn.execute("DELETE FROM memory_observations")
    conn.commit()


# --------------------------------------------------------------------------
# 프로필 조회 (에이전트 도구가 사용하는 읽기 경로)
# --------------------------------------------------------------------------

def get_profile(profile_id: str) -> dict[str, Any]:
    return PROFILES.get(profile_id) or PROFILES[DEFAULT_PROFILE]


def days_until_payday(profile: dict[str, Any], ref: datetime | None = None) -> int:
    ref = ref or now()
    payday = int(profile.get("payday", 25))
    if ref.day <= payday:
        return payday - ref.day
    # 다음 달 급여일까지
    next_month = (ref.replace(day=1) + timedelta(days=32)).replace(day=1)
    try:
        target = next_month.replace(day=payday)
    except ValueError:
        target = next_month.replace(day=28)
    return (target.date() - ref.date()).days


def purchases_in_category(profile: dict[str, Any], category: str) -> list[dict[str, Any]]:
    cat = (category or "").strip().lower()
    if not cat:
        return []
    out = []
    for p in profile.get("purchases", []):
        pc = p["category"].lower()
        if pc == cat or pc in cat or cat in pc:
            out.append(p)
    return out


def owned_in_category(profile: dict[str, Any], category: str) -> list[dict[str, Any]]:
    cat = (category or "").strip().lower()
    if not cat:
        return []
    return [
        i for i in profile.get("owned_items", [])
        if i["category"].lower() == cat or i["category"].lower() in cat or cat in i["category"].lower()
    ]


# --------------------------------------------------------------------------
# 사건 CRUD
# --------------------------------------------------------------------------

def new_case_id() -> str:
    return "case_" + uuid.uuid4().hex[:8]


def save_case(case: dict[str, Any]) -> None:
    conn = db()
    conn.execute(
        """INSERT INTO purchase_cases (case_id, profile_id, payload, created_at, release_at, verdict, resolved)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(case_id) DO UPDATE SET
             payload=excluded.payload, release_at=excluded.release_at,
             verdict=excluded.verdict, resolved=excluded.resolved""",
        (
            case["case_id"],
            case["profile_id"],
            json.dumps(case, ensure_ascii=False),
            case.get("created_at") or iso(now()),
            case.get("release_at"),
            case.get("verdict"),
            1 if case.get("resolved") else 0,
        ),
    )
    conn.commit()


def get_case(case_id: str) -> dict[str, Any] | None:
    row = db().execute("SELECT payload FROM purchase_cases WHERE case_id=?", (case_id,)).fetchone()
    return json.loads(row["payload"]) if row else None


def list_cases(profile_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    if profile_id:
        rows = db().execute(
            "SELECT payload FROM purchase_cases WHERE profile_id=? ORDER BY created_at DESC LIMIT ?",
            (profile_id, limit),
        ).fetchall()
    else:
        rows = db().execute(
            "SELECT payload FROM purchase_cases ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [json.loads(r["payload"]) for r in rows]


def pending_reviews(ref: datetime | None = None) -> list[dict[str, Any]]:
    """release_at 이 지난, 아직 종결되지 않은 사건. 자율 재실행의 입력."""
    ref = ref or now()
    rows = db().execute(
        "SELECT payload FROM purchase_cases WHERE resolved=0 AND release_at IS NOT NULL"
    ).fetchall()
    out = []
    for r in rows:
        case = json.loads(r["payload"])
        try:
            if datetime.fromisoformat(case["release_at"]) <= ref:
                out.append(case)
        except (KeyError, TypeError, ValueError):
            continue
    return out


def recent_hold_for(profile_id: str, product_name: str) -> dict[str, Any] | None:
    """같은 상품으로 보류를 받은 적이 있는지. retry_after_hold 판정에 사용."""
    key = (product_name or "").strip().lower()
    if not key:
        return None
    for case in list_cases(profile_id, limit=100):
        if case.get("verdict") in ("HOLD", "STRONG_HOLD"):
            if (case.get("product", {}).get("name") or "").strip().lower() == key:
                return case
    return None


# --------------------------------------------------------------------------
# 에이전트 메모리
# --------------------------------------------------------------------------

def write_memory(profile_id: str, text: str, confidence: str, source: str = "agent") -> int:
    conn = db()
    cur = conn.execute(
        "INSERT INTO memory_observations (profile_id, written_at, text, confidence, source) VALUES (?,?,?,?,?)",
        (profile_id, iso(now()), text, confidence, source),
    )
    conn.commit()
    return int(cur.lastrowid or 0)


def read_memory(profile_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = db().execute(
        "SELECT written_at, text, confidence, source FROM memory_observations "
        "WHERE profile_id=? ORDER BY id DESC LIMIT ?",
        (profile_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def override_stats(profile_id: str) -> dict[str, Any]:
    """자가 스크리닝 지표: 최근 30일간 보류 판정을 몇 번, 얼마어치 무시했는가."""
    cutoff = now() - timedelta(days=30)
    count, total = 0, 0
    for case in list_cases(profile_id, limit=200):
        ov = case.get("override")
        if not ov or not ov.get("happened"):
            continue
        try:
            if datetime.fromisoformat(case["created_at"]) < cutoff:
                continue
        except (KeyError, TypeError, ValueError):
            pass
        if case.get("verdict") in ("HOLD", "STRONG_HOLD"):
            count += 1
            total += int(case.get("product", {}).get("price") or 0)
    return {"overrides_last_30d": count, "override_amount": total}
