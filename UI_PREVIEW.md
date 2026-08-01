# Lian UI preview routes

백엔드를 실행한 뒤 아래 개발 전용 URL로 확장 화면에 직접 진입한다.

- 전체 보드: `http://localhost:8787/ui-board`
- 개별 화면: `http://localhost:8787/ui-preview?screen=<state>`

## States

| state | 실제 진입 조건 |
| --- | --- |
| `context-remaining` | 상품 추출 성공, 구매 후 여유금액이 0원보다 큼 |
| `context-zero` | 상품 추출 성공, 구매 총액과 이번 달 여유금액이 정확히 같음 |
| `context-shortage` | 상품 추출 성공, 구매 총액이 이번 달 여유금액보다 큼 |
| `loading` | 구매 이유 제출 후 `/api/case` 또는 `/answer` 응답 대기 중 |
| `interview` | 하나 이상의 상품이 `price_only`가 아니며 질문 응답이 존재함 |
| `result` | 분석 완료 후 `PASS`가 아닌 상품이 하나 이상 존재함 |
| `extraction-error` | 상품명 또는 0원보다 큰 가격을 읽지 못함 |
| `backend-error` | `/api/case` 또는 `/answer` 요청 실패·타임아웃 |

`PASS` 상품만 존재하면 결과 화면 없이 원래 결제를 이어간다. 사용자가 보류를 수용하면 별도 완료 화면 없이 팝업을 닫는다.

## E2E setup

1. 상태 초기화: `POST http://localhost:8787/api/dev/reset`
2. 확장 프로그램 다시 로드
3. 동일 탭 재시도는 10초 우회 시간이 지난 뒤 수행
4. UI만 확인할 때는 위 preview route를 사용
5. 실제 DOM 추출과 결제 감지는 지원 쇼핑몰의 최종 결제 버튼에서 검증

Preview 파일은 실제 `styles.css`와 `tips.css`를 `/ui-assets/*`로 읽는다. 보드 전용 CSS는 레이아웃 격리만 담당하며 제품 컴포넌트 색상이나 타이포그래피를 복제하지 않는다.
