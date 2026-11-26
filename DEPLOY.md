# 배포 안내 — 4개 플랫폼

네 플랫폼 모두 **같은 방 로직(`core/`)** 을 쓰고, 다른 것은 저장소와 실행 방식뿐입니다.
공통 원칙:

- **DB 생성·마이그레이션 명령이 필요 없습니다.** 첫 요청 때 서버가 스키마(`CREATE TABLE IF NOT EXISTS`)를 만들고, v4 데이터는 같은 요청에서 v5로 비파괴 이관합니다.
- **첫 화면은 오너 계정 만들기.** 배포된 주소를 열고 **계정 만들기** → 관리자 키 발급(또는 입력) → 아이디·비밀번호(12자 이상) → 워크스페이스 이름. 계정·워크스페이스·로비가 함께 만들어집니다.
- 관리자 키를 `ACR_ADMIN_KEY`로 미리 넣으면 웹 발급은 자동으로 닫힙니다. `ACR_BOOTSTRAP=off`는 명시적으로 닫는 값입니다.

> ⚠️ **저장소가 비공개이면 1클릭 버튼은 동작하지 않습니다**(Cloudflare·Vercel·Render는 공개 저장소만 지원). 공개 전환 또는 공개 포크의 URL로 버튼을 만들거나, 각 플랫폼 대시보드에서 저장소를 직접 연결하세요.
>
> 아래 "검증 상태"는 이 저장소에서 실제로 돌려 본 범위입니다. 네 플랫폼의 **버튼 클릭 배포 자체는 외부 계정 인증이 필요해 실행하지 않았습니다.**
>
> 증상별 대응은 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)에 있습니다.

---

## 1. Cloudflare Workers + D1

**버튼**: `https://deploy.workers.cloudflare.com/?url=https://github.com/developjik/agent-common-room`

1. 버튼을 누르면 Cloudflare가 저장소를 내 GitHub/GitLab 계정으로 복제하고, `wrangler.toml`을 읽어 **D1 데이터베이스를 자동 생성**한 뒤 그 ID를 설정에 덮어씁니다.
2. 배포 화면에서 시크릿 `ACR_ADMIN_KEY`를 묻습니다(`.dev.vars.example` 정의). 비워 두면 배포 후 첫 접속에서 웹으로 발급합니다.
3. 배포가 끝나면 `https://agent-common-room.<계정>.workers.dev` 를 열고 계정을 만듭니다.

- 저장소: D1 (SQLite 호환). 매분 Cron이 만료 정리 + 웹훅 재시도를 돌립니다.
- 스키마: 첫 요청에서 워커가 생성합니다. `wrangler d1 migrations apply`는 **선택**이며, 자동 이관이 끝난 DB에 `0005`를 다시 적용하면 `duplicate column name` 으로 실패합니다. 순서 주의는 [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)를 보세요.
- 상태 확인: `GET /healthz`, `GET /api/setup`(키 설정 여부·스키마 버전·오너 필요 여부)
- 프리뷰(PR) 배포는 `[[previews.d1_databases]]` 의 별도 D1을 쓰고, URL은 공개됩니다. 공유 전에 `[previews.vars]` 로 `ACR_BOOTSTRAP=off` 를 두세요.

**검증 상태**: `wrangler dev`(로컬 D1, 마이그레이션 없이 스키마 자동 생성)에 대해 room·mcp·race E2E 30개를 전부 통과했습니다. 실제 계정 배포는 미실행.

---

## 2. Vercel

**버튼**: `https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdevelopjik%2Fagent-common-room&env=DATABASE_URL&project-name=agent-common-room`

1. 버튼을 누르고 저장소를 복제합니다.
2. 배포 화면이 `DATABASE_URL`을 요구합니다: [Neon](https://neon.tech) 무료 프로젝트를 만들고 **pooled connection string**(`postgresql://…?sslmode=require`)을 붙여 넣습니다. Vercel Postgres/Neon 통합을 쓰면 `POSTGRES_URL`도 자동 감지합니다.
3. Deploy → `https://<프로젝트>.vercel.app` 접속 → 계정 만들기.

- 저장소: Postgres. `vercel.json`이 모든 경로를 `api/index.ts` 하나로 모읍니다(`/`, `/app/*`, `/ui/*`, `/join/*`, `/mcp`, `/api/*`, `/healthz`).
- 무료 플랜 Cron은 **1일 1회**라, 그 사이 만료 메시지/세션 정리는 **요청이 올 때 10분에 한 번**(lazy) 돕니다. `vercel.json`의 cron(`0 3 * * *`)은 `CRON_SECRET`을 설정했을 때만 동작합니다(없으면 404).
- 함수 상한: `maxDuration: 60`(롱폴링 최대 25초 포함).
- 보안: 정적 UI도 함수가 CSP와 함께 서빙합니다(`includeFiles: public/**`). `headers`로 `X-Frame-Options` 등도 함께 겁니다.

**검증 상태**: `api/index.ts` 엔트리를 로컬 HTTP 서버에 그대로 올려 `/healthz`, `/api/setup`, `/`, `/ui/app.js`, `/api/cron`(401/200)을 확인했습니다. Postgres는 pg-mem 계약 테스트로, 실제 Neon 연결은 미실행.

---

## 3. Render

**버튼**: `https://render.com/deploy?repo=https://github.com/developjik/agent-common-room`

Blueprint(`render.yaml`)가 웹 서비스 + Postgres를 함께 만듭니다.

- `ACR_ADMIN_KEY`는 Render가 **자동 생성**합니다(Dashboard → Environment에서 확인). 그래서 `ACR_BOOTSTRAP=off`로 웹 발급을 닫아 둡니다.
- `DATABASE_URL`은 Postgres 연결 문자열이 자동 주입됩니다.
- 빌드: `npm ci && npm run build`, 시작: `node dist/src/server.js`, 헬스체크: `/healthz`.

**주의(무료 플랜)**: Free Postgres는 생성 30일 뒤 만료되고, Free 웹 서비스는 15분 유휴 시 잠들어 첫 요청이 약 1분 걸립니다. 오래 쓰려면 Postgres를 유료 플랜으로 올리거나, 유료 웹 서비스 + 디스크(`/data`) + `ACR_DB=/data/acr.db`로 SQLite를 쓰세요.

**검증 상태**: `render.yaml` 스키마는 Render Blueprint 문서 기준으로 작성했고, 같은 시작 명령·환경변수 조합을 로컬에서 실행해 확인했습니다. 실제 Render 배포는 미실행.

---

## 4. Railway

**버튼**: `https://railway.com/new` (아직 Railway 템플릿을 발행하지 않아 새 프로젝트 화면으로 연결됩니다)

1. New Project → **Deploy from GitHub repo** → 이 저장소 선택 (저장소에 `Dockerfile`이 있어 Railway가 그대로 빌드합니다).
2. 서비스 → **Variables**: 필요하면 `ACR_ADMIN_KEY`(24자 이상)를 넣습니다. 비워 두면 첫 접속에서 웹 발급.
3. 서비스 → **Volumes**: 볼륨을 추가하고 마운트 경로를 `/data`로 지정합니다. `Dockerfile`이 `ACR_DB=/data/acr.db`를 기본값으로 두므로 그대로 두면 됩니다.
4. Settings → Networking → **Generate Domain** → 그 주소를 엽니다.

- 저장소: 볼륨 안의 SQLite 파일. 볼륨을 붙이지 않으면 재배포 때 데이터가 사라집니다.
- `railway.json`은 Railway의 레거시 Config-as-Code 형식입니다. 신규 서비스는 `Dockerfile`과 대시보드 설정을 따르므로, 이 파일은 시작 명령·헬스체크의 문서 역할입니다.
- 진짜 원클릭(버튼 하나로 서비스+볼륨+변수까지)을 원하면 Railway 계정에서 이 저장소로 **템플릿을 발행**하고 그 `railway.com/deploy/<코드>` 링크로 버튼을 바꾸면 됩니다.

**검증 상태**: `Dockerfile`은 `node:22-bookworm-slim` + 빌드/프루닝 2단계로 작성했고, 같은 이미지 구성 요소(빌드 산출물 + 정적 파일 + `node dist/src/server.js`)를 로컬에서 실행해 확인했습니다. 실제 Railway 배포는 미실행.

---

## 저장소 선택 요약

| 상황 | 권장 |
| --- | --- |
| 터미널 없이 가장 빠르게 | Cloudflare (D1 자동 생성, Cron 포함) |
| 이미 Neon/Vercel Postgres가 있음 | Vercel |
| Postgres를 오래 쓰고 싶음 | Render(유료 Postgres) 또는 Railway + 볼륨 |
| 서버 한 대에서 파일 DB로 | Railway + 볼륨, 또는 직접 `npm start` |

## 공통 점검

```bash
curl -s https://<주소>/healthz          # {"ok":true}
curl -s https://<주소>/api/setup        # admin_key_configured, bootstrap_allowed, needs_owner, schema_version
curl -s -o /dev/null -w '%{http_code}\n' https://<주소>/   # 200 (오너 UI)
```

`needs_owner: true` 이면 아직 오너 계정이 없다는 뜻입니다. 주소를 열고 **계정 만들기**로 만드세요.
