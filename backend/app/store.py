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
        "label": "프로필 A · 김서준(27) 신입 3년차 / 예산 여유",
        "persona": (
            "직장 3년차. 자취 2년째. 큰 지출 전에 며칠 고민하는 편이고, "
            "장바구니에 담아두고 주말에 정리해서 산다. 이번 달은 지출이 적었다."
        ),
        "monthly_income": 2_600_000,
        "fixed_expenses": 1_100_000,
        "fixed_expense_items": [
            {"name": "월세", "amount": 620_000},
            {"name": "관리비·공과금", "amount": 130_000},
            {"name": "통신비", "amount": 55_000},
            {"name": "교통(정기권)", "amount": 65_000},
            {"name": "보험", "amount": 90_000},
            {"name": "넷플릭스", "amount": 13_500},
            {"name": "헬스장", "amount": 89_000},
            {"name": "클라우드 저장소", "amount": 3_300},
        ],
        "monthly_free_budget": 400_000,
        "seed_spent_this_month": 120_000,
        "payday": 25,
        "hourly_wage": 12_000,
        "owned_items": [
            {"category": "tumbler", "name": "스탠리 텀블러 473ml", "count": 1, "last_used_days_ago": 1},
            {"category": "shoes", "name": "아디다스 울트라부스트", "count": 1, "last_used_days_ago": 2},
            {"category": "headphones", "name": "에어팟 3세대", "count": 1, "last_used_days_ago": 0},
        ],
        "purchases": [
            {"category": "book", "name": "소설 『파친코』", "price": 15_800, "days_ago": 20,
             "justification": "읽고 싶었어요", "used": True},
            {"category": "food", "name": "원두 1kg", "price": 24_000, "days_ago": 12,
             "justification": "집에서 내려 마시려고", "used": True},
            {"category": "clothing", "name": "무지 반팔티 2장", "price": 29_800, "days_ago": 34,
             "justification": "여름옷이 없어서", "used": True},
            {"category": "stationery", "name": "노트 3권", "price": 9_600, "days_ago": 47,
             "justification": "회의록용", "used": True},
        ],
        "upcoming_events": [],
    },
    "B": {
        "profile_id": "B",
        "label": "프로필 B · 이하은(24) 취준생 / 예산 소진 임박",
        "persona": (
            "취업 준비 중. 아르바이트 수입이 불규칙하다. 스트레스를 받으면 밤에 쇼핑앱을 켠다. "
            "'한정판', '오늘만' 같은 문구에 반응하는 편이고, 산 물건을 잘 쓰지 않는다. "
            "생수는 무거워서 늘 배달로 시킨다."
        ),
        "monthly_income": 2_300_000,
        "fixed_expenses": 1_250_000,
        "fixed_expense_items": [
            {"name": "월세", "amount": 700_000},
            {"name": "관리비·공과금", "amount": 145_000},
            {"name": "통신비", "amount": 69_000},
            {"name": "학원(인강)", "amount": 185_000},
            {"name": "보험", "amount": 78_000},
            {"name": "유튜브 프리미엄", "amount": 14_900},
            {"name": "쿠팡 와우멤버십", "amount": 7_890},
            {"name": "음악 스트리밍", "amount": 10_900},
            {"name": "쇼핑앱 멤버십", "amount": 4_900},
        ],
        "monthly_free_budget": 300_000,
        "seed_spent_this_month": 139_460,
        "payday": 25,
        "hourly_wage": 10_500,
        "owned_items": [
            {"category": "tumbler", "name": "스탠리 클래식 진공 텀블러 473ml", "count": 1, "last_used_days_ago": 40},
            {"category": "tumbler", "name": "스타벅스 한정판 텀블러", "count": 2, "last_used_days_ago": 65},
            {"category": "tumbler", "name": "무인양품 보온병", "count": 2, "last_used_days_ago": 90},
            {"category": "shoes", "name": "나이키 에어 줌 페가수스 40", "count": 2, "last_used_days_ago": 12},
            {"category": "shoes", "name": "컨버스 척테일러", "count": 2, "last_used_days_ago": 55},
            {"category": "cosmetics", "name": "쿠션 팩트", "count": 3, "last_used_days_ago": 30},
        ],
        "purchases": [
            {"category": "water", "name": "제주 삼다수 2L 6병", "price": 7_900, "days_ago": 6,
             "justification": "떨어져서 샀어요", "used": True},
            {"category": "water", "name": "제주 삼다수 2L 6병", "price": 8_400, "days_ago": 18,
             "justification": "무거워서 배달이 편해요", "used": True},
            {"category": "water", "name": "아이시스 500ml 20병", "price": 9_900, "days_ago": 27,
             "justification": "행사 중이라 쟁여두려고", "used": True},
            {"category": "water", "name": "제주 삼다수 2L 6병", "price": 7_900, "days_ago": 39,
             "justification": "떨어져서", "used": True},
            {"category": "water", "name": "제주 삼다수 2L 6병", "price": 8_900, "days_ago": 52,
             "justification": "쿠폰이 있어서", "used": True},
            {"category": "water", "name": "제주 삼다수 2L 12병", "price": 15_800, "days_ago": 68,
             "justification": "대용량이 더 싸서", "used": True},
            {"category": "water", "name": "제주 삼다수 2L 6병", "price": 8_400, "days_ago": 84,
             "justification": "떨어져서", "used": True},
            {"category": "tumbler", "name": "스타벅스 한정판 텀블러", "price": 59_000, "days_ago": 44,
             "justification": "한정판이라 지금 아니면 못 사요", "used": False},
            {"category": "tumbler", "name": "무인양품 보온병", "price": 39_000, "days_ago": 91,
             "justification": "보온력이 더 좋아서", "used": False},
            {"category": "cosmetics", "name": "쿠션 팩트 리필", "price": 32_000, "days_ago": 22,
             "justification": "세일해서", "used": False},
            {"category": "food", "name": "야식 배달", "price": 23_000, "days_ago": 3,
             "justification": "밤에 배고파서", "used": True},
            {"category": "food", "name": "야식 배달", "price": 19_500, "days_ago": 9,
             "justification": "밤에 배고파서", "used": True},
            {"category": "clothing", "name": "오버핏 후드티", "price": 45_000, "days_ago": 15,
             "justification": "타임세일이라서", "used": False},
        ],
        "upcoming_events": [
            {"title": "친구 결혼식 축의금", "days_from_now": 8, "estimated_cost": 100_000},
            {"title": "생일 모임", "days_from_now": 11, "estimated_cost": 50_000},
            {"title": "토익 응시료", "days_from_now": 13, "estimated_cost": 48_000},
        ],
    },
}

DEFAULT_PROFILE = "B"


# --------------------------------------------------------------------------
# 로딩 중 표시할 청년 금융 팁
#
# 날짜가 바뀌는 모집 일정은 DB에 고정하지 않는다. 대신 실제 신청을 준비할 때
# 확인해야 할 공식 채널과 점검 포인트를 기록해, 오래된 안내를 사실처럼 보여주지 않는다.
# --------------------------------------------------------------------------

TIP_SEEDS: tuple[tuple[str, int, int, str, str, str, str, str], ...] = (
    (
        "housing-subscription-alerts", 20, 29, "청약",
        "청약 공고는 관심 지역별 알림으로 묶어두세요.",
        "공급 공고와 자격 기준은 수시로 달라져요. 관심 지역을 정해 청약홈 알림을 켜두면 준비할 시간을 확보할 수 있어요.",
        "청약홈", "https://www.applyhome.co.kr/",
    ),
    (
        "youth-finance-announcements", 20, 29, "청년 금융",
        "청년 금융상품은 모집 공고를 먼저 확인해보세요.",
        "청년도약계좌나 청년내일저축계좌처럼 조건과 신청 기간이 있는 상품은 공식 공고 알림을 받아두는 편이 좋아요.",
        "서민금융진흥원 · 복지로", "https://www.kinfa.or.kr/",
    ),
    (
        "youth-housing-support", 20, 29, "주거",
        "월세·주거 지원은 거주 지역 공고를 함께 살펴보세요.",
        "청년 월세와 임대주택 지원은 지역과 소득 조건에 따라 달라져요. 마이홈과 지자체 청년 포털을 함께 확인해보세요.",
        "마이홈포털", "https://www.myhome.go.kr/",
    ),
    (
        "savings-rate-check", 20, 29, "저축",
        "자동이체일은 월급 다음 날로 맞춰보세요.",
        "남은 돈을 저축하기보다 먼저 저축할 금액을 빼두면, 이번 달에 실제로 쓸 수 있는 예산이 더 선명해져요.",
        "개인 예산 점검", "",
    ),
    (
        "credit-card-review", 20, 29, "신용 관리",
        "카드 혜택은 전월 실적까지 같이 계산해보세요.",
        "할인 금액만 보기보다 혜택을 받기 위해 추가로 쓰는 금액이 없는지 확인하면 불필요한 지출을 줄일 수 있어요.",
        "금융감독원 파인", "https://fine.fss.or.kr/",
    ),
    (
        "employment-training", 20, 29, "커리어",
        "교육비를 결제하기 전, 지원 제도를 먼저 확인해보세요.",
        "직무 교육이나 자격증 과정은 국민내일배움카드 등 지원 대상인지 먼저 확인하면 같은 계획의 부담을 낮출 수 있어요.",
        "고용24", "https://www.work24.go.kr/",
    ),
)


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

-- 데모 중 실제로 성사된 구매. 시드 이력과 합쳐져 get_purchase_history에 그대로 반영된다.
-- 심사위원이 같은 물건을 두 번 사면 두 번째에 에이전트가 그 사실을 안다.
CREATE TABLE IF NOT EXISTS purchases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id    TEXT NOT NULL,
    case_id       TEXT,
    category      TEXT NOT NULL,
    name          TEXT NOT NULL,
    price         INTEGER NOT NULL,
    justification TEXT NOT NULL DEFAULT '',
    verdict       TEXT,
    overridden    INTEGER NOT NULL DEFAULT 0,
    bought_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   TEXT NOT NULL,
    written_at   TEXT NOT NULL,
    text         TEXT NOT NULL,
    confidence   TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'agent'
);

CREATE TABLE IF NOT EXISTS tips (
    tip_id        TEXT PRIMARY KEY,
    min_age       INTEGER NOT NULL,
    max_age       INTEGER NOT NULL,
    category      TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    source_label  TEXT NOT NULL,
    source_url    TEXT NOT NULL DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1
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
        _seed_tips(_conn)
        _conn.commit()
    return _conn


def reset() -> None:
    """데모 리허설용 초기화. 시드 프로필은 코드 상수라 영향 없음."""
    conn = db()
    conn.execute("DELETE FROM purchase_cases")
    conn.execute("DELETE FROM memory_observations")
    conn.execute("DELETE FROM purchases")
    conn.commit()


def _seed_tips(conn: sqlite3.Connection) -> None:
    conn.executemany(
        """INSERT INTO tips
           (tip_id, min_age, max_age, category, title, body, source_label, source_url, active)
           VALUES (?,?,?,?,?,?,?,?,1)
           ON CONFLICT(tip_id) DO UPDATE SET
             min_age=excluded.min_age, max_age=excluded.max_age, category=excluded.category,
             title=excluded.title, body=excluded.body, source_label=excluded.source_label,
             source_url=excluded.source_url, active=excluded.active""",
        TIP_SEEDS,
    )


def tips_for_age(age: int, limit: int = 3) -> list[dict[str, Any]]:
    """연령대에 맞는 활성 팁을 무작위 순서로 가져온다."""
    safe_limit = max(1, min(int(limit), 6))
    rows = db().execute(
        """SELECT tip_id, category, title, body, source_label, source_url
           FROM tips
           WHERE active=1 AND min_age <= ? AND max_age >= ?
           ORDER BY RANDOM() LIMIT ?""",
        (int(age), int(age), safe_limit),
    ).fetchall()
    return [dict(row) for row in rows]


# --------------------------------------------------------------------------
# 프로필 조회 (에이전트 도구가 사용하는 읽기 경로)
# --------------------------------------------------------------------------

def record_purchase(profile_id: str, case: dict[str, Any], overridden: bool) -> int:
    """데모 중 성사된 구매를 이력에 남긴다.

    이게 없으면 심사위원이 같은 물건을 두 번 사도 에이전트가 처음 보는 것처럼 군다.
    구매 근거(user_reason)를 함께 저장하는 것이 핵심이다 — 다음 개입에서 그대로 인용된다.
    """
    p = case.get("product", {})
    cat = (case.get("classification", {}) or {}).get("category") or p.get("category") or "other"
    conn = db()
    cur = conn.execute(
        """INSERT INTO purchases
           (profile_id, case_id, category, name, price, justification, verdict, overridden, bought_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (profile_id, case.get("case_id"), cat, p.get("name") or "(이름 없음)",
         int(p.get("price") or 0), case.get("user_reason") or "",
         case.get("verdict"), 1 if overridden else 0, iso(now())),
    )
    conn.commit()
    return int(cur.lastrowid or 0)


def runtime_purchases(profile_id: str) -> list[dict[str, Any]]:
    """저장된 런타임 구매를 시드 이력과 같은 모양으로 변환한다."""
    rows = db().execute(
        "SELECT category, name, price, justification, bought_at, overridden, verdict "
        "FROM purchases WHERE profile_id=? ORDER BY id DESC", (profile_id,)
    ).fetchall()
    ref = now()
    out = []
    for r in rows:
        try:
            days = max(0, (ref - datetime.fromisoformat(r["bought_at"])).days)
        except (TypeError, ValueError):
            days = 0
        out.append({
            "category": r["category"], "name": r["name"], "price": r["price"],
            "days_ago": days, "justification": r["justification"],
            "used": True, "source": "runtime",
            "overridden": bool(r["overridden"]), "verdict_at_purchase": r["verdict"],
        })
    return out


def get_profile(profile_id: str) -> dict[str, Any]:
    """시드 페르소나 + 런타임 구매를 합친 현재 상태.

    은행 연동이 없으므로 소득·고정지출은 목업이다. 다만 '이번 달 얼마 썼는가'는
    데모 중 실제 구매를 반영해 움직인다. 그래야 두 번째 구매의 잔액이 달라진다.
    """
    seed = PROFILES.get(profile_id) or PROFILES[DEFAULT_PROFILE]
    extra = runtime_purchases(seed["profile_id"])
    this_month = sum(p["price"] for p in extra if p["days_ago"] <= 31)
    return {
        **seed,
        "purchases": extra + list(seed["purchases"]),
        "spent_this_month": int(seed["seed_spent_this_month"]) + this_month,
        "runtime_purchase_count": len(extra),
    }


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


CONSUMABLE_CATEGORIES = {
    "water", "food", "grocery", "groceries", "cosmetics", "medicine", "medical",
    "supplement", "supplements", "household_consumable", "consumable",
}


def owned_in_category(profile: dict[str, Any], category: str) -> list[dict[str, Any]]:
    """직접 등록한 보유품과 구매 이력으로 추정되는 비소모품을 함께 반환한다.

    구매 사실만으로 현재 보유를 확정할 수는 없으므로 source를 표시한다. 소모품은
    구매 후 사용됐을 가능성이 높아 자동 보유품으로 만들지 않는다.
    """
    cat = (category or "").strip().lower()
    if not cat:
        return []
    registered = [
        {**i, "source": "registered", "ownership_inferred": False}
        for i in profile.get("owned_items", [])
        if i["category"].lower() == cat or i["category"].lower() in cat or cat in i["category"].lower()
    ]
    if any(consumable == cat or consumable in cat for consumable in CONSUMABLE_CATEGORIES):
        return registered

    registered_names = {(item.get("name") or "").strip().lower() for item in registered}
    inferred_by_name: dict[str, dict[str, Any]] = {}
    for purchase in purchases_in_category(profile, cat):
        name = (purchase.get("name") or "").strip()
        key = name.lower()
        if not key or key in registered_names:
            continue
        if key not in inferred_by_name:
            inferred_by_name[key] = {
                "category": purchase.get("category") or cat,
                "name": name,
                "count": 0,
                "last_used_days_ago": None,
                "source": "purchase_history",
                "ownership_inferred": True,
            }
        inferred_by_name[key]["count"] += 1

    return registered + list(inferred_by_name.values())


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
