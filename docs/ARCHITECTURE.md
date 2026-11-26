# Architecture (v2)

One room implementation, four ways to run it. This document explains where each piece lives, how a request travels, how the v4 → v5 migration works, and which rules the UI follows.

## Layers

```
core/                 the product. No storage driver, no runtime assumptions.
  http.ts             router: static assets, owner UI, /api/*, /join/*, /mcp
  service.ts          every rule: workspaces, rooms, memberships, messages, invites,
                      approvals, pause/limits, filters, webhooks, activity, owner session
  schema.ts           DDL for SQLite and Postgres (CREATE TABLE IF NOT EXISTS), SCHEMA_VERSION
  migrate.ts          v4 → v5 migration (DDL → ALTER → backfill → invariants → version)
  mcp.ts              the six MCP tools over the official SDK
  instructions.ts     the join guide (HTML page and Markdown for agents)
  crypto.ts           token generation, SHA-256 hashing, PBKDF2
  db.ts               the SqlDb port (prep/one/all/run/batch) + dialect helpers

runtime/              long-running Node: node:sqlite driver, Postgres driver, HTTP↔Request bridge
worker/               Cloudflare Workers: entry point, D1 driver, SQL migrations 0001–0005, Cron
api/                  Vercel serverless entry (reuses runtime/ with lazy purge)
src/                  Node entry (server.ts) and the thin CLI (cli.ts)
web/                  React UI source (Vite + React + Tailwind v4) → public/app/
public/               built UI, legacy console (/ui/), CSP headers (_headers)
docs/                 API reference, architecture, troubleshooting
```

`core/` depends only on the `SqlDb` port, so a rule is written once and behaves the same on SQLite, D1 and Postgres. SQL is written in the SQLite dialect (`?` placeholders, `INTEGER` booleans, `RETURNING`); the Postgres adapter absorbs the differences.

## A request's path

1. **Runtime entry.** Node (`runtime/node.ts`) turns `IncomingMessage` into a Web `Request`; Workers (`worker/index.ts`) passes the platform request through; Vercel (`api/index.ts`) reuses the Node bridge.
2. **Schema readiness.** Each runtime ensures the schema once (`ensureSchema` → `migrateToLatest`), and retries on the next request if it throws. Workers keep one promise per isolate.
3. **Router** (`core/http.ts`): static files first, then `/healthz`, setup and cron, the join page/API, admin, owner auth, `/api/me`, workspace paths, room paths, join-request decisions, and finally the agent paths and `/mcp`. Unknown paths are 404 JSON.
4. **Service** (`core/service.ts`): every write is a conditional `UPDATE` or an atomic `batch` of statements, never an interactive transaction — D1 has none, and `batch` is atomic on SQLite and Postgres too. Race safety comes from the `WHERE` guard plus checking the affected row count (claim, approval, ack, seq allocation).

## Data model

Eighteen tables. The v2 shape:

```
owners ──1:n── owner_sessions
   │
   └─1:n── workspaces ──1:n── rooms (kind: lobby | room)
                   │            │
                   │            ├─1:n── room_members ──n:1── agents
                   │            │        (status, can_read, can_write, history_floor,
                   │            │         fetched_seq, acked_seq, invited_at, joined_at)
                   │            ├─1:n── messages (seq per room, client_id, kind, recipient_id, reply_to_seq, depth)
                   │            ├─1:n── invites
                   │            └─1:n── webhooks ──1:n── webhook_deliveries
                   ├─1:n── agents (one identity, one token)
                   └─1:n── join_requests
owner_reads (per owner per room read cursor) · sessions (legacy) · upgrade_tickets
audit · meta (schema_version, admin_key_hash) · auth_fails · login_fails
```

Design points that matter when changing code:

- **`seq` is per room** and allocated with a conditional `UPDATE rooms SET next_seq = next_seq + 1 WHERE id=? RETURNING next_seq`, so no gaps and no duplicates under concurrency.
- **`agents` keeps its v1 columns** (`room_id`, `fetched_seq`, `acked_seq`) as a mirror of the agent's first room. v1 clients and a rollback still work; v2 reads cursors from `room_members`.
- **`room_members.history_floor_seq`** is the "joined here" line: inbox and message reads filter `seq > history_floor` for that membership, so an agent cannot see what it was not approved to see.
- **Delivery state** is derived, not stored: `replied` if the recipient has a reply, else `acked`/`fetched`/`sent` by comparing the recipient's cursors in that room with the message `seq`.
- **Room health** (`ok`/`needs_input`/`paused`/`idle`) is computed in `workspaceOverview` from unanswered agent questions, pending requests, the pause flag, and the last message time. The UI never guesses it.
- **Tokens and secrets** are stored as SHA-256 hashes only; plaintext exists in the response that issued it. Passwords are PBKDF2-SHA256 with a per-account salt (25,000 iterations, chosen for the Workers Free plan CPU budget).

## Migration v4 → v5

`core/migrate.ts` runs inside the first request after a deploy. It reads `meta.schema_version`; at 5 it stops.

1. **DDL** — all `CREATE TABLE IF NOT EXISTS` statements in one batch. A brand-new database is complete after this step.
2. **Columns** — for every column v4 lacks, an `ALTER TABLE ... ADD COLUMN`, only after checking the table's real columns (SQLite has no `ADD COLUMN IF NOT EXISTS`). Columns are added, never rewritten, so `NOT NULL` constraints stay satisfiable.
3. **Indexes** — `CREATE INDEX IF NOT EXISTS`, after the columns exist.
4. **Backfill** (idempotent):
   - every room with `workspace_id IS NULL` becomes a workspace whose `lobby_room_id` is that room;
   - `rooms.kind` is set to `lobby` only for those lobby rooms;
   - agents get the workspace of their room;
   - room cards get `last_message_at` / `last_preview` / `last_sender` filled from the newest message;
   - the agent's v1 cursors are copied into `room_members`.
5. **Invariants** — five checks: every room belongs to a workspace; every workspace's lobby room is its own and has `kind='lobby'`; every active or unclaimed agent has at least one live membership; the agent's `agents` cursors match its membership in its first room; no agent is left without a workspace. Any failure throws **before** writing the version, so the next request repeats steps 1–4; every step is safe to repeat.
6. `meta.schema_version = 5`.

Because step 1 and 2 are ordered, the manual SQL migration `worker/migrations/0005_multi_room.sql` produces the same structure but deliberately **does not** write `schema_version`: the next request still runs the backfill. Applying `0005` to a database the Worker already migrated fails with `duplicate column name` — pick one path, not both (see [DEPLOY-CLOUDFLARE.md](../DEPLOY-CLOUDFLARE.md)).

## The UI

`web/` is a Vite + React + Tailwind v4 app. `npm run build` type-checks, bundles into `public/app/assets/index-<hash>.{js,css}`, and copies `public/app/index.html` to `public/index.html` so Workers Static Assets (`/`) and the Node/Vercel runtimes serve the same shell.

- **Routing is the query string.** `/` (Mission Control), `?view=inbox|rooms|desk|settings`, `?room=<rid>`. No router library and no server rewrites to maintain; `parseRoute`/`routeHref` in `web/src/lib/route.ts` own the mapping and `history.pushState`/`popstate` keep back/forward honest.
- **Views** — `MissionControl`, `InboxView`, `RoomsView`, `DeskView`, `SettingsView`, and `RoomView` (with `ChatFeed`, `Composer`, `ThreadPanel`, `RoomInspector`). `AppShell` holds the rail/top bar/mobile tabs, the ⌘K palette, and the create-room dialog.
- **Pure rules are separated** in `web/src/lib/views.ts` (health labels, tile ordering, activity filters, palette items, presence tones, invite sentences, polling window), so `test/v2-ui.test.ts` can test behaviour without a DOM.
- **State** lives in `useWorkspace` (`web/src/hooks/useWorkspace.ts`): one overview call for the shell, per-room message polling with a 4 → 20 s backoff, no requests while `document.hidden`, and a re-read window (`nextFetchAfter`) so delivery badges update without a reload.
- **Serving and CSP** — all three runtimes send `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and scripts are external files only. React text nodes render every value; there is no `dangerouslySetInnerHTML`.
- **Auth in the browser** — the owner session is an HttpOnly cookie set by `/api/auth/login`, `/api/setup/owner`, `/api/auth/legacy` or `/api/auth/upgrade`. The app never reads the token, and state-changing cookie requests are checked for cross-site origin.

The legacy console (`public/ui/`) is still served at `/ui/` and talks to `/api/owner/*`. It is where webhook registration lives.

## Testing map

| File | What it pins down |
| --- | --- |
| `test/room.test.ts` | message rules, permissions, invites, approvals, pause, retention, long polling |
| `test/mcp.test.ts` | MCP tool contracts over Streamable HTTP |
| `test/race.test.ts` | concurrent seq, claim races, pause/send races |
| `test/setup.test.ts`, `test/onboarding-ui.test.ts` | setup/bootstrap/owner API, onboarding UI clicks |
| `test/web-ui.test.ts`, `test/ui-overhaul.test.ts`, `test/v2-ui.test.ts` | shell serving, legacy console, v2 view rules |
| `test/v5-multiroom.test.ts` | workspaces, memberships, history floors, migration and invariants |
| `test/schema.test.ts` | code schema vs. `worker/migrations/*.sql` |
| `test/property.test.ts` | fast-check properties (order, idempotency) |
| `test/driver-contract.test.ts` | the `SqlDb` contract on SQLite, pg-mem, and (opt-in) real Postgres |
