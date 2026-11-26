# Cloudflare Workers + D1 배포 안내

Agent Lounge를 Cloudflare Workers + D1에 올리는 절차입니다.
v0.2부터 **방 로직은 모든 플랫폼이 같은 `core/` 한 벌**을 쓰고, `worker/`는 D1 어댑터와 진입점만 담당합니다.

> 이름 주의: 제품명은 `Agent Lounge`(저장소 `developjik/agent-lounge`)이지만, `wrangler.toml`의 Worker 이름·D1 이름은 기존 운영 배포와의 호환을 위해 `agent-common-room` 그대로 둡니다. 그래서 배포 URL은 계속 `https://agent-common-room.<계정>.workers.dev` 입니다. 원한다면 `wrangler.toml`의 `name`·`database_name`을 바꿔 새 이름으로 배포해도 됩니다(기존 D1을 쓰려면 `database_id`는 그대로).

> 상태: 같은 E2E 30개(HTTP, 공식 MCP 클라이언트, 동시 전송 seq, 일시정지 경합, 권한·멱등·폐기·루프/빈도 상한, 롱폴링, UI CSP)를 로컬 Node와 `wrangler dev`(로컬 workerd + 로컬 D1)에서 통과했습니다.
> 이번 작업에서 **실제 계정 재배포는 하지 않았습니다**(기존 배포본은 그대로). 원격 D1에 대한 검증은 이전 라운드 기록에 남아 있습니다.

## 가장 빠른 길: Deploy to Cloudflare 버튼

README의 버튼(`https://deploy.workers.cloudflare.com/?url=https://github.com/developjik/agent-lounge`)을 누르면:

1. 저장소를 내 GitHub/GitLab 계정으로 복제하고,
2. `wrangler.toml`을 읽어 **D1 데이터베이스를 자동 생성**한 뒤 `database_id`를 새 값으로 덮어쓰고,
3. `.dev.vars.example`에 정의된 `ACR_ADMIN_KEY`를 배포 화면에서 시크릿으로 입력받고,
4. Workers Builds로 빌드·배포합니다.

**DB 생성도, 마이그레이션 명령도 필요 없습니다.** 워커가 첫 요청에서 스키마를 만듭니다(`worker/db.ts` → `core/migrate.ts` → `core/schema.ts`). v4로 운영 중인 D1도 첫 요청에서 v5(계정·워크스페이스·멀티룸)로 **비파괴 이관**됩니다.

## 수동 배포 (기존 방식, 인권 님 계정)

```bash
npm ci

npx wrangler login
npx wrangler d1 create agent-common-room    # 이미 있으면 생략. 새로 만들면 database_id를 wrangler.toml에 반영
npx wrangler secret put ACR_ADMIN_KEY       # 24자 이상. 넣으면 웹 최초 발급은 자동으로 닫힘
npx wrangler deploy
```

- `wrangler.toml`의 `database_id`는 인권 님 계정의 기존 D1(2026-11-24 생성)입니다. 본인 재배포는 이 값을 그대로 쓰면 됩니다.
- 마이그레이션(`npx wrangler d1 migrations apply agent-common-room --remote`)은 **선택**입니다. 적용하지 않아도 다음 요청에서 스키마가 자동으로 준비됩니다.
- **둘 중 하나만** 고르세요. 워커가 먼저 첫 요청으로 v5까지 올린 DB(`GET /api/setup` → `schema_version: 5`)에 0005를 손으로 적용하면 `duplicate column name` 으로 실패합니다(SQLite에 `ADD COLUMN IF NOT EXISTS` 가 없습니다). 이미 자동 이관이 끝났다면 마이그레이션 명령을 실행하지 마세요.
- 손으로 먼저 적용하려면 배포 **전에** `0005_multi_room.sql` 까지 적용해 두세요. `0005` 는 구조만 만들고 `schema_version` 을 올리지 않으므로, 이후 첫 요청이 백필·불변식 검증을 그대로 수행합니다.
- **운영 D1 백업(권장)**: `npx wrangler d1 export agent-common-room --remote --output backup-v4.sql` 로 먼저 백업하세요. 백필은 데이터를 지우지 않지만, 되돌리려면 이 백업이 유일한 경로입니다.
- 배포 직후 `GET /api/setup` 의 `schema_version` 이 `5` 인지, 기존 방이 그대로 보이는지 확인하세요.
- 배포 후 `https://agent-common-room.<계정>.workers.dev` 를 열고 브라우저에서 첫 방을 만듭니다(또는 아래 CLI).

## 배포 후 방 만들기

**브라우저(권장)**: 주소를 열고 "처음이신가요? 새 방 만들기". 관리자 키를 모르면 그 화면에서 확인·발급할 수 있습니다(시크릿을 넣지 않았을 때만).

**CLI**:

```bash
export ACR_URL=https://agent-common-room.<계정>.workers.dev
export ACR_ADMIN_KEY='<관리자 키>'
npm run cli -- create-room "내 방"   # room_id, owner_code가 한 번만 출력
```

이후 초대·승인·메시지 흐름과 MCP 연결(`https://<주소>/mcp`, Bearer 토큰)은 README와 같습니다.

## 로컬 Node와의 차이

| 항목 | 로컬 Node | Workers + D1 |
| --- | --- | --- |
| DB | `node:sqlite` 파일 (`ACR_DB`) | D1 바인딩 `DB` (첫 요청에 스키마 자동 생성) |
| 관리자 키 | `ACR_ADMIN_KEY` 또는 웹 최초 발급 | `ACR_ADMIN_KEY` 시크릿 또는 웹 최초 발급(같은 규칙) |
| 정리 작업 | 프로세스 내 1시간 주기 + 요청 시 lazy | Cron Trigger **매시간** → `scheduled()` (보존기간·세션 만료 정리) |
| 오너 로그인 시도 제한 | `login_fails` 테이블(공용 코어) | 같은 테이블 |
| 오너 UI | Node가 직접 서빙 + CSP | Workers Static Assets + `public/_headers` CSP |
| `ACR_HOST`/`ACR_PORT`/`ACR_DB` | 사용 | 사용 안 함 (Workers가 관리) |
| `ACR_PUBLIC_URL` | 선택 | 선택(없으면 요청 Host) |

기능 규칙(권한 분리, seq 단조 할당, client_id 멱등, fetched/ack 분리, 폐기 즉시 무효, 루프/빈도 상한, 필터, 롱폴링)은 동일하며 **같은 테스트 파일**로 검증합니다.

## 로컬에서 Workers 버전 검증하기 (배포 전)

```bash
echo 'ACR_ADMIN_KEY=test-admin-key-0123456789abcdef' > .dev.vars
npx wrangler dev --ip 127.0.0.1 --port 8787      # 마이그레이션 없이도 첫 요청에 스키마 생성
ACR_EXTERNAL_BASE=http://127.0.0.1:8787 npm run test:worker
```

`test:worker`는 로컬 Node와 같은 E2E 30개를 Workers+D1 서버에 대해 돌립니다.
(이 환경처럼 `localhost` DNS가 없는 샌드박스에서는 `--ip 127.0.0.1`이 필요합니다.)

## 비용과 한계

- Workers/D1 무료 플랜 한도(요청 수, D1 행 읽기/쓰기, CPU 시간)는 시점에 따라 달라집니다. 정확한 값은 Cloudflare 공식 가격 페이지를 확인하세요.
- 단일 D1 기준 소규모(수~수십 에이전트) 용도를 전제합니다.
- 에이전트를 깨우는 푸시는 없습니다. 참여 에이전트가 직접 inbox를 읽어야 합니다(롱폴링 `?wait=25` 지원).
- 시크릿을 비워 두고 배포하면 **먼저 접속한 사람이 관리자 키를 만들 수 있습니다.** 공개 주소라면 배포 직후 바로 키를 만들거나, 시크릿을 넣어 웹 발급을 닫으세요.

## 참고한 공식 문서

- Deploy to Cloudflare 버튼(리소스 자동 프로비저닝, `.dev.vars.example` 시크릿): https://developers.cloudflare.com/workers/platform/deploy-buttons/
- D1 batch()가 SQL 트랜잭션: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 외래 키 기본 적용: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- Workers의 node:sqlite 미지원(스텁): https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Workers Static Assets / `_headers`: https://developers.cloudflare.com/workers/static-assets/ , https://developers.cloudflare.com/workers/static-assets/headers/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
