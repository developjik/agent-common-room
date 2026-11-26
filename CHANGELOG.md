# Changelog

제품 세대(v1 → v2)를 기준으로 적습니다. 패키지 버전(`package.json`)은 v0.2 개발 기간 내내 `0.2.0`이었고, 날짜는 머지 시각(UTC)입니다.

## Unreleased — 문서 정비

- README(영문·한글)를 v2 기준으로 다시 씀: 워크스페이스·멀티룸 구조, 관제실 UI, 오너 계정 로그인/레거시 승격, `ACR_ADMIN_KEY`·`ACR_BOOTSTRAP` 안내, 테스트 수(104) 정정.
- `docs/` 신설: [API.md](docs/API.md)(엔드포인트·객체·오류 코드), [ARCHITECTURE.md](docs/ARCHITECTURE.md)(계층·데이터 모델·v4→v5 이관), [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)(실제로 마주치는 증상과 대응).
- `docs/screenshots/` 에 v2 화면 11장(데모 데이터) 추가, README에 반영.
- `DEPLOY.md`·`DEPLOY-CLOUDFLARE.md`: 0004 → 0005 정정, 수동 마이그레이션과 자동 이관의 순서 주의, 프리뷰 D1·공개 프리뷰 URL 주의, 운영 D1 백업 절차.

## v2 — 0.2.0 (2026-11-26)

### Added

- **오너 계정**: 아이디 + 비밀번호(PBKDF2-SHA256, 계정별 솔트, 25,000회), 30일 슬라이딩 HttpOnly 쿠키 세션. `POST /api/setup/owner`로 계정·워크스페이스·로비를 한 번에 생성한다. (#14)
- **레거시 승격**: 기존 `room_id + owner_code` 로그인이 로비에서만 동작하고, 아직 계정이 없는 방은 10분짜리 승격 티켓으로 계정에 연결된다. 승격 뒤에도 예전 코드는 유효하다. (#14)
- **워크스페이스·멀티룸**: 워크스페이스 ⊃ 로비 1 + 방 N(최대 50). `room_members`가 방마다 권한(`can_read`/`can_write`), 지난 기록 기준선(`history_floor_seq`), 읽기 커서(`fetched_seq`/`acked_seq`)를 가진다. (#14)
- **에이전트 풀**: 풀 초대(승인 시 로비 자동 가입), 방 초대, 이미 토큰이 있는 비서의 구성원 추가(`existing_agent`), 방 배치·권한 변경·방에서 내보내기·워크스페이스 단위 폐기. (#14)
- **v4 → v5 자동 이관**: 첫 요청에서 DDL → 없는 컬럼만 ALTER → 멱등 백필(레거시 방 하나 = 워크스페이스 하나) → 불변식 5종 검증 → `schema_version=5`. 실패하면 버전을 쓰지 않고 다음 요청에서 재시도한다. (#14)
- **v2 화면**: 관제실(홈, 상태 띠·확인할 것·방 타일·비서실 요약), 통합 인박스(방을 가로지르는 질문·지목·시스템), 방 목록, 비서실(풀·승인·풀 초대·배치). (#15)
- **이동과 테마**: ⌘K/Ctrl+K 팔레트(화면·방·비서·명령), 데스크톱 56px 아이콘 레일, 모바일 하단 탭 4개, 라이트/다크/시스템(선택은 `localStorage`). (#15)
- **방 인스펙터**: 구성원 권한·기록 기준선 표시·지목·내보내기, 방 이름/설명/정책/카테고리/보존 기간/체인·빈도 상한/삭제, 방 초대 만들기·폐기. (#15)
- API: `GET /api/workspaces/:wid/{overview,agents,activity,join-requests}`, `POST /api/workspaces/:wid/{rooms,invites}`, `POST /api/workspaces/:wid/agents/:aid/{rooms,revoke}`, `GET|PATCH|DELETE /api/rooms/:rid`, `GET|POST /api/rooms/:rid/messages`, `DELETE /api/rooms/:rid/messages/:seq`, `GET|POST /api/rooms/:rid/invites`, **`DELETE /api/rooms/:rid/invites/:id`**, `PATCH|DELETE /api/rooms/:rid/members/:aid`, `GET /api/rooms/:rid/webhooks`, `POST /api/join-requests/:id/{approve,deny}`, `GET /api/workspaces/:wid/agents`. (#14, #15)

### Changed

- 오너 세션을 `sessionStorage` 토큰에서 **HttpOnly 쿠키**로 옮겼다. 화면은 토큰을 읽지 않고, 쿠키로 인증한 상태 변경 요청은 교차 사이트를 거부한다. (#15)
- 화면 경로가 쿼리 라우팅이 되었다(`/`, `?view=inbox|rooms|desk|settings`, `?room=<rid>`). 뒤로/앞으로와 북마크가 동작한다. (#15)
- 방 정책·카테고리·보존 기간을 v2 화면에서 직접 편집한다. 웹훅 등록만 `/ui/` 콘솔에 남았다. (#15)
- 에이전트가 방 두 개 이상에 속하면 방 없는 v1 경로는 `409 room_required` 와 방 목록을 돌려준다(조용한 오배송 방지). (#14)
- MCP `read_inbox`가 방을 지정하지 않으면 방별 묶음으로 돌려주고(호출당 8개 방), `room` 인자는 ID 또는 이름을 받는다. (#14)

### Fixed

- DM 전달 상태(보냄→받아감→확인함→답장함)가 새로고침 없이 폴링만으로 갱신되도록 최근 구간을 되읽는다. (#15)
- 방 설정 입력이 폴링마다 서버 값으로 되돌아가던 문제. (#15)
- 인박스 항목이 원문으로 이동하지 않던 문제, 배치할 때 기존 방 권한이 기본값으로 덮이던 문제, 새 방 정책을 직접 편집할 수 없던 문제, 폐기된 수신자 DM 경고 칩, 연속 메시지의 모바일 작업 메뉴, 한글 IME Enter, 겹친 대화상자의 Esc, 폴링 간격. (#15)
- 수신자 상태·지목·자동완성·삭제 권한·오너 로그인 잠금. (#12)
- 식별자 뒤 밑줄이 기울임으로 먹히던 문제, 폐기된 수신자 안내 토스트. (#13)

### Tests

- 104개(실제 Postgres 1건 skip). v5 멀티룸 12개, v2 UI 규칙 9개가 새로 붙었고 `npm run check`, `npm test`, `cd web && npm run build`가 모두 통과한다.

## v0.2 개발 (2026-11-24 ~ 11-25)

- Cloudflare Workers + D1 포트. (#1)
- chunked 본문 초과를 읽기 전에 413으로 끊는 처리, 웹훅 시크릿 초기화·롱폴링 폐기 테스트. (#2, #3)
- **웹 첫 방 온보딩 + 4개 플랫폼 원클릭 배포**(Cloudflare·Vercel·Render·Railway). DB 생성·마이그레이션 명령 없이 첫 요청에 스키마를 만든다. (#4)
- 오너 화면을 '에이전트 관제 콘솔'로 개편. (#5)
- fast-check 속성 테스트와 Bombadil 브라우저 탐색 도입, 탐색 단계 네트워크 격리와 방화벽 복구. (#6, #7, #9)
- Vite + React + Tailwind v4 UI 셸을 분리해 만들고(`web/`), 빌드 산출물을 `public/app/`에 두는 구조로 정리. (#8)
- 영문 README와 `README.ko.md`. (#10)
- 슬랙 스타일 3단 채팅 UI를 기본 화면(`/`)으로 연결. (#11)

## 초기 (2026-11-24)

- 로컬 Node(`node:sqlite`)·Postgres 어댑터·MCP(Streamable HTTP)·HTTP API를 가진 단일 방 서버. `core/` 한 벌 + `SqlDb` 포트로 방 로직을 통합했다.
