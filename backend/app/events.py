"""tool_call / tool_result 원본 스트림 브로커.

대회 필수 요건: OpenAI API의 tool_call / tool_result 이벤트를 **가공 없이**
세컨드 화면에 실시간 출력한다.

설계 원칙 — 원본 보존:
  · SDK/API가 준 객체는 `raw` 필드에 model_dump() 그대로 넣는다. 변형·요약·번역 금지.
  · 우리가 덧붙이는 것은 봉투(envelope)뿐: seq / ts / elapsed_ms / channel.
  · 뷰어에서 delta 이벤트를 숨길 수 있지만 그건 클라이언트 측 필터이고,
    서버는 받은 이벤트를 전부 내보낸다.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from typing import Any

from .store import iso, now

_MAX_BUFFER = 500

_subscribers: set[asyncio.Queue] = set()
_buffer: deque[dict[str, Any]] = deque(maxlen=_MAX_BUFFER)
_seq = 0
_t0: float | None = None


def _elapsed_ms() -> int:
    global _t0
    loop_time = asyncio.get_event_loop().time()
    if _t0 is None:
        _t0 = loop_time
    return int((loop_time - _t0) * 1000)


def emit(channel: str, raw: Any, case_id: str | None = None, note: str | None = None) -> dict[str, Any]:
    """이벤트 1건을 모든 구독자에게 밀어넣는다. `raw`는 절대 가공하지 않는다."""
    global _seq
    _seq += 1
    try:
        elapsed = _elapsed_ms()
    except RuntimeError:  # 이벤트 루프 밖에서 호출된 경우
        elapsed = 0

    envelope = {
        "seq": _seq,
        "ts": iso(now()),
        "elapsed_ms": elapsed,
        "channel": channel,
        "case_id": case_id,
        "note": note,
        "raw": _safe(raw),
    }
    _buffer.append(envelope)
    for q in list(_subscribers):
        try:
            q.put_nowait(envelope)
        except asyncio.QueueFull:
            pass
    return envelope


def _safe(obj: Any) -> Any:
    """직렬화만 보장한다. 내용은 건드리지 않는다."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    for attr in ("model_dump", "dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:  # noqa: BLE001 - 원본 보존 실패 시에도 스트림은 죽지 않는다
                break
    if isinstance(obj, (list, tuple)):
        return [_safe(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _safe(v) for k, v in obj.items()}
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return repr(obj)


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=2000)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def replay() -> list[dict[str, Any]]:
    """새 구독자가 붙었을 때 직전 이벤트를 되돌려준다(데모 중 새로고침 대비)."""
    return list(_buffer)


def clear() -> None:
    _buffer.clear()
