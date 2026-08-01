# Ulysses 백엔드

온라인 결제 직전에 개입해, 구매 근거를 조사하고 규칙 기반으로 판정한 뒤 실제 마찰을 적용하는 자율 에이전트.

구매를 막는 것이 목적이 아니다. **결정에 쓸 시간을 되돌려주는 것**이 목적이고, 최종 결정권은 항상 사용자에게 있다.

## 실행

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env   # OPENAI_API_KEY 입력
cd backend && ../.venv/bin/python -m uvicorn app.main:app --port 8787
```

| 화면 | 주소 |
| --- | --- |
| 목업 쇼핑몰 (다크패턴 포함) | http://localhost:8787/shop |
| tool_call 원본 스트림 뷰어 | http://localhost:8787/viewer |
| API 문서 | http://localhost:8787/docs |

## 파이프라인

```
[1] 상시    profiler.py  주기 스캔 → 에이전트가 메모리를 스스로 갱신 (사용자 입력 0회)
     │
[2] 관찰    POST /api/observe        상품 페이지 진입. 개입 없음. detected_at만 기록
     │                                 → checkout_at과의 차이 = dwell_minutes (충동성 핵심 변수)
[3] 트리거  POST /api/case           결제 버튼 클릭
     │       ├ 사이트 식별 + 통화 정규화 (sites.py)
     │       ├ 다크패턴 탐지 (gates.py, DOM 텍스트 휴리스틱)
     │       ├ 카테고리 분류 (키워드 → 미매치 시에만 LLM)
     │       └ 개입 방식 결정 — 팝업은 항상 뜬다
     │            price_only : 심문 없음. 입력 0회로 즉시 최저가 조사. 마찰 금지
     │            challenge  : 질문 1회 → 자율 조사 → 판정 → 마찰
     │
[4] 질문    (challenge일 때) 에이전트가 질문 형식과 선택지를 설계해 응답에 담아 보냄
     │
[5] 조사    POST /api/case/{id}/answer   ★ 사용자 입력은 여기 1회가 전부
     │       └ 도구 선택·조사 반복·종료 시점·대안 방식·메모리 기록을 에이전트가 스스로 결정
     │
[6] 판정    judge.py  규칙 기반 점수 계산. LLM이 아니다
     │
[7] 결정    POST /api/case/{id}/resolve  accept | override
     │       └ 성사된 구매는 이력에 기록된다 → 다음 개입이 그것을 안다
     │
[8] 자율 재실행  autopilot.py  release_at 도달 시 사용자 입력 없이 스스로 깨어남
```

## 프론트엔드 연동

CORS는 전체 허용이라 확장 프로그램 content script에서 직접 호출하면 된다.
`credentials`는 쓰지 않는다. 상태는 전부 `case_id`로 이어진다.

### 로딩 중 경제 팁

결제 판단이나 에이전트 조사가 길어질 때 확장 프로그램은 아래 API로 팁을 읽어 화면에 순환 표시한다.

```text
GET /api/tips?age=20&limit=3
```

팁은 SQLite의 `tips` 테이블에 저장되며, 서버 시작 시 20대 대상 청약·청년 금융·주거·저축·신용 관리·커리어 팁이 시드된다. 모집 일정처럼 자주 바뀌는 사실은 고정하지 않고 공식 확인 채널만 함께 제공한다.

### 1. 상품 페이지 진입 시

```js
await fetch(`${API}/api/observe`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profile_id: 'B', product: { name, price, category, url } })
});
```

개입하지 않는다. `detected_at`만 남긴다. 이걸 호출해두지 않으면 dwell_minutes가 0이 되어
"발견 후 즉시 결제"로 잡히니, 상품 페이지에서 반드시 한 번 부른다.

### 2. 결제 버튼 클릭 시

```js
const res = await post('/api/case', {
  profile_id, 
  product: { name, price, category, url, discount_text, currency },  // currency 생략 시 URL로 추론
  page_text: document.body.innerText,   // 다크패턴 탐지 입력
  dwell_minutes: null,                  // null이면 서버가 observe 시각으로 계산
  payment_method_bnpl: false,
});
```

응답:

```jsonc
{
  "case_id": "case_ab12cd34",
  "intervene": true,            // 항상 true. 어떤 구매도 그냥 통과시키지 않는다
  "mode": "challenge",          // "price_only" | "challenge"
  "no_friction": false,         // true면 어떤 점수가 나와도 지연시키지 않는다 (의약품·생필품)
  "gate": 2,                    // 0=의약품 1=소액·이례성없음 2=심문 -1=파싱실패
  "mode_reason": "이례적인 신호가 있습니다: ...",
  "site": { "site_name": "쿠팡", "currency": "KRW", "price_krw": 69000, "converted": false },
  "budget": { "remaining": 29000, "after_purchase": -40000, "days_until_payday": 24,
              "upcoming_total": 150000, "after_upcoming": -190000, "work_hours_equivalent": 6.6 },
  "dark_patterns": [{ "type": "긴급성 조작", "evidence": "재고 3개", "verifiable": false }],
  "parse_failed": false,
  "override_stats": { "overrides_last_30d": 0, "override_amount": 0 },

  // mode === "challenge" 일 때만
  "question": {
    "format": "choice",                 // "choice" | "text"
    "text": "보유 중인 텀블러가 5개인데 ...",
    "options": [{ "id": "opt1", "label": "...", "implies": "necessity" }],
    "allow_free_text": true,
    "free_text_placeholder": "...",
    "reason": "이 형식을 고른 이유"       // 심사·디버깅용
  },
  "alternatives_prompt": "다른 가격이나 대안 상품을 찾아드릴까요?",

  // mode === "price_only" 일 때만 (이미 조사가 끝나 있다)
  "verdict": "PASS",
  "price_check": {
    "searched": true, "cheaper_found": true, "best_price": 6800,
    "seller": "...", "source_url": "...", "saving": 2100,
    "offers": [{ "seller": "...", "price": 6800, "url": "...", "note": "배송비 별도" }],
    "structural_alternative": "", "note": "2문장 이내 요약"
  }
}
```

**렌더링 분기**

| 조건 | 화면 |
| --- | --- |
| `parse_failed === true` | "상품 정보를 추출하지 못했습니다" — 막지 않는다 |
| `mode === "price_only"` | 최저가·대안만 표시. 심문·마찰 없음. 확인 버튼 하나 |
| `mode === "challenge"` | `question` 렌더 (`format`에 따라 라디오/체크박스 또는 textarea) |

### 3. 답변 전송 (사용자 입력은 여기가 마지막)

```js
const res = await post(`/api/case/${case_id}/answer`, {
  selected_option_ids: ['opt3', 'opt4'],   // 객관식에서 고른 것
  reason: '자유 입력 (없으면 빈 문자열)',
  want_alternatives: true,                  // "다른 가격 찾아줄까요?"의 답
});
```

20~40초가 걸린다. 이 시간을 침묵으로 두지 말고 `/api/stream`을 구독해
tool_call을 실시간으로 보여주는 것을 권한다 (`shop.html`의 `startLive()` 참고).

응답:

```jsonc
{
  "verdict": "STRONG_HOLD",       // PASS | WARN | HOLD | STRONG_HOLD
  "risk_score": 11,
  "breakdown": [{ "key": "budget_exceeded", "label": "이번 달 자유 예산 초과", "points": 3 }],
  "hold_minutes": 1440,
  "release_at": "2026-08-02T23:09:34+09:00",   // 이 시각에 에이전트가 스스로 깨어난다
  "capped_reason": null,          // 상한/하한 규칙이 적용됐으면 그 이유
  "summary": "3문장 이내 사실 요약",
  "claims": [{ "text": "...", "type": "uniqueness", "status": "unverifiable", "evidence": "..." }],
  "savings": {
    "not_buying_saves": 69000, "cheaper_price": 0, "cheaper_saves": 0,
    "offers": [], "annual_saving": 0, "work_hours_saved": 6.6
  },
  "alternative": { "found": false, "summary": "대안을 찾지 못했습니다" },
  "follow_up_question": "이 텀블러를 언제 어떤 상황에서 사용할 예정인가요?",
  "agent_memories": [{ "text": "...", "confidence": "high" }],
  "agent_error": null             // null이 아니어도 verdict는 유효하다(결정론적 신호만으로 계산)
}
```

### 4. 최종 결정

```js
await post(`/api/case/${case_id}/resolve`, { action: 'accept' });              // 판정 수용
await post(`/api/case/${case_id}/resolve`, { action: 'override', reason: '...' }); // 무시하고 구매
```

override는 **항상 허용된다.** 다만 사유 한 문장을 받아 기록하고, 그 문장이 다음 심문의 재료가 된다.

`accept`는 판정에 따라 의미가 다르다.

- `PASS` / `WARN`을 accept → 그대로 결제한 것. 구매 이력에 기록된다
- `HOLD` / `STRONG_HOLD`를 accept → 사지 않은 것. `release_at`이 유지되어 스케줄러가 스스로 깨운다

### 5. 원본 스트림 (심사 필수 요건)

```js
const es = new EventSource(`${API}/api/stream`);
es.onmessage = (m) => {
  const e = JSON.parse(m.data);
  // e.channel: raw_response | tool_call | tool_result | message | system
  // e.raw    : SDK/API가 준 객체 원본 (가공하지 않음)
  // e.seq, e.ts, e.elapsed_ms, e.case_id : 우리가 덧붙인 봉투
};
```

봉투(seq/ts/elapsed_ms/channel)만 우리가 붙이고 내용은 `raw`에 그대로 둔다.
delta 이벤트도 전부 내보낸다 — 뷰어의 숨김 옵션은 클라이언트 측 필터일 뿐이다.

## 전체 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/observe` | 상품 페이지 관찰 (개입 없음) |
| POST | `/api/case` | 결제 트리거 → 개입 방식 결정 |
| POST | `/api/case/{id}/answer` | 사용자 답변 1회 → 자율 조사 → 판정 |
| POST | `/api/case/{id}/resolve` | accept / override |
| GET | `/api/case/{id}` | 사건 전체 조회 |
| GET | `/api/profiles` | 프로필 목록 (런타임 구매 반영된 현재 상태) |
| GET | `/api/sites` | 지원 쇼핑몰 목록 + 환율 |
| GET | `/api/memory/{pid}` | 에이전트 메모리 + override 통계 + 기록된 구매 |
| POST | `/api/memory/{pid}/scan` | 상시 메모리 스캔 즉시 1회 실행 |
| GET | `/api/scoring` | 판정표 전체 공개 |
| GET | `/api/stream` | tool_call/tool_result 원본 SSE |
| GET | `/api/events` | 스트림 버퍼 조회 (`?case_id=&channel=`) |
| POST | `/api/dev/wake` | 자율 재검토 즉시 발화 (데모용) |
| POST | `/api/dev/reset` | 사건·메모리·구매 초기화 |

## 새 쇼핑몰 추가

1. 확장 프로그램(`sites.js`)에 결제 버튼 셀렉터를 추가한다 — DOM 파싱은 확장의 책임이다.
2. `backend/app/sites.py`의 `SITES`에 한 줄 추가한다 — 호스트·통화·주의사항.

백엔드 로직은 사이트를 몰라도 된다. 모르는 쇼핑몰에서 와도 `site_id: null`로 두고 그대로 진행한다.

## 설계상 지켜지는 것

- **판정은 LLM이 하지 않는다.** `judge.py`의 점수표로 계산한다. 재현성과 설명 가능성 때문이다.
  에이전트가 제공하는 값(`no_owned_substitute` 등)도 점수 입력일 뿐, 판정 경계는 상수가 정한다.
- **의약품에는 마찰을 걸지 않는다.** 개입은 하되 `no_friction`으로 잠기고, 복약·효능 언급도 금지된다.
- **생필품은 지연시키지 않는다.** 대안 제시까지가 한계다.
- **확인하지 못한 것을 추측하지 않는다.** 최저가를 못 찾으면 "확인하지 못했습니다"이지 "최저가입니다"가 아니다.
- **인격을 공격하지 않는다.** 사용자는 우울·불안을 동반한 강박적 구매 상태일 수 있다.
  수치심을 유발하는 개입은 역효과이며 설계 위반이다.
- **override는 항상 허용된다.** 최종 결정권은 사용자에게 있다.
