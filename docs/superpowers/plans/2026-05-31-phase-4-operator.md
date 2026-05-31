# Phase 4 — Operator endpoints + `/ops` page

**Date:** 2026-05-31
**Spec:** `docs/superpowers/specs/2026-05-22-bookings-v1-design.md` §145–§156
**Depends on:** Phases 0–3 shipped. Warmups (book-in-transaction, prod cleanup) done first.
**Status:** Plan — ready to execute.

## Goal

Close the v1 loop: give the operator (AB / Shea) a password-gated `/ops` page on
their phone that lists today's stops and lets them tap **On my way** (fires the
`on_our_way` email), **Done** (fires the `done` email), **Skip**, and add a
**Note** per stop. Plus a 7-day upcoming view.

Customer self-service already exists (Phase 3). Without the operator side the
system can't actually run a route — this phase makes it operable.

## New env vars

| Name | Purpose | How AB sets it |
|---|---|---|
| `OPERATOR_SECRET` | HMAC key for the operator session cookie (`ls_operator`) | `openssl rand -hex 32` → Vercel (prod+preview sensitive, dev non-sensitive) |
| `OPERATOR_PASSWORD` | Shared password checked by `/api/operator/login` | a memorable strong string → Vercel |

Uncomment both in `.env.example`. **Prod won't work until AB adds them in Vercel**
and redeploys — flag this at ship time.

## Design decisions (resolved from spec)

- **Operator auth** mirrors `lib/cookies.ts`/`lib/session.ts` but in a new
  `lib/operator.ts`: a separate `ls_operator` HS256 JWT (payload `{ op: true }`)
  signed with `OPERATOR_SECRET`. TTL **7 days** (operator's own phone; re-auth
  weekly). Password check is **timing-safe** (`crypto.timingSafeEqual`).
- **"Today" is Edmonton-local**, not UTC — the route runs in Mountain Time and a
  UTC day flips mid-evening. Compute the calendar day via
  `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' })`. Both read
  endpoints accept a `?date=YYYY-MM-DD` override (operator can look at another day;
  also makes tests deterministic without mocking the clock).
- **`bin_count` on the operator view** comes from the subscription (LEFT JOIN).
  One-off visits have no subscription, so `bin_count` is `null` for them — a
  pre-existing gap (book.ts never stored bin_count for one-offs). Out of scope to
  fix here; note as a follow-up.
- **Operator skip ≠ customer skip.** Customer skip (Phase 3) inserts a replacement
  visit one cadence later. Operator skip ("bin wasn't out") just marks the visit
  `skipped` — the recurring schedule continues with the next already-scheduled
  visit. (Spec §155 "marks skipped".)
- **Double-tap safety is free**: `notify`/`done` send through `sendAndLog`, which
  is idempotent on `(visit_id, kind)`. A second tap returns `{ skipped: true }`
  and sends no second email. Frontend toasts "already sent".
- **Status guards** (lenient — operator is the authority on the ground):
  - `notify`: 409 if status ∈ {done, cancelled}; else set `heading_there`.
  - `done`: 409 if status == cancelled; else set `done` (idempotent re-done OK).
  - `skip`: 409 if status ∈ {done, cancelled}; else set `skipped`.
  - `note`: allowed on any status.
- **No operator logout endpoint** in v1 (one operator, own phone, 7-day cookie).
  Spec lists 7 endpoints; stay in scope.

## Tasks

Each task is test-first (repo convention: a `_tests/*.test.ts` beside every
endpoint). Run `npm test <file>` red → implement → green. Keep the existing 131
tests green throughout.

### Task 1 — `lib/operator.ts` + unit tests
`lib/_tests/operator.test.ts` first. Exports:
- `OPERATOR_COOKIE_NAME = 'ls_operator'`, `OPERATOR_TTL_SECONDS = 7*24*60*60`
- `signOperatorCookie(): Promise<string>` — HS256 JWT `{ op: true }`, `OPERATOR_SECRET`
- `verifyOperatorCookie(token): Promise<boolean>`
- `formatOperatorCookieHeader(token)` / `formatClearOperatorCookieHeader()` — Path=/, Max-Age, HttpOnly, Secure, SameSite=Lax
- `getOperatorSession(req): Promise<boolean>` — parse `ls_operator` off `req.headers.cookie`, verify
- `verifyOperatorPassword(password): boolean` — timing-safe compare vs `OPERATOR_PASSWORD`; false if env unset
- `operatorTodayISO(): string` — Edmonton calendar day `YYYY-MM-DD`
Tests: sign↔verify round-trip, tampered token → false, missing `OPERATOR_SECRET` throws, password match/mismatch, multi-cookie header parse, no-cookie → false.

### Task 2 — `POST /api/operator/login` + tests
`api/operator/login.ts`. 405 non-POST; 400 missing password; 401 `invalid_password`; 200 `{status:'ok'}` + `Set-Cookie: ls_operator=…` on match. 500 if `OPERATOR_SECRET` unset (let the throw surface like SESSION_SECRET does).
Tests `api/_tests/operator-login.test.ts`: all branches; assert Set-Cookie present and the cookie verifies via `verifyOperatorCookie`.

### Task 3 — `GET /api/operator/today` + tests
`api/operator/today.ts`. Operator-gated (401 if `!getOperatorSession`). `targetISO = ?date` (valid YYYY-MM-DD) else `operatorTodayISO()`. Query visit INNER JOIN customer LEFT JOIN subscription where `scheduled_for = targetDate` AND status != 'cancelled', ordered by customer name. Return `{status:'ok', date, visits:[{id, customer_name, phone, street, city, postal_code, bin_count, status, notes, heading_there_at, done_at}]}`.
Tests `api/_tests/operator-today.test.ts`: 401 no auth; 200 returns today's visits with customer + bin_count; one-off shows bin_count null; cancelled excluded; `?date` override.

### Task 4 — `GET /api/operator/upcoming?days=7` + tests
`api/operator/upcoming.ts`. Operator-gated. `days` default 7, clamp 1..60. Anchor = `?date` else today. Range `(anchor, anchor+days]` (excludes today; that's `/today`), status != cancelled, ordered by date then name. Same visit shape as today (date is per-visit). Return `{status:'ok', days, visits:[…]}`.
Tests `api/_tests/operator-upcoming.test.ts`: 401; returns next-N-days visits excluding today + cancelled; days clamp.

### Task 5 — visit action endpoints + tests
Vercel dynamic routes under `api/operator/visit/[id]/`. Each operator-gated, loads visit (404 if missing), `req.query.id`.
- `notify.ts`: guard {done,cancelled}→409; update `status='heading_there', heading_there_at=now` (set time only if null); `sendAndLog({kind:'on_our_way', visitId, …, onOurWayTemplate({name}))`; return `{status:'ok', skipped}`.
- `done.ts`: guard cancelled→409; compute `nextVisitDate` = next `scheduled` visit for the customer with `scheduled_for > this.scheduled_for` (asc, limit 1) → `YYYY-MM-DD|null`; update `status='done', done_at=now`; `sendAndLog({kind:'done', visitId, …, doneTemplate({name, nextVisitDate}))`; return `{status:'ok', skipped}`.
- `skip.ts`: guard {done,cancelled}→409; update `status='skipped'` (no replacement). Return `{status:'ok'}`.
- `note.ts`: zod `{text: string 1..1000}` (400 invalid); append `existing ? existing+'\n'+text : text`; update notes; return `{status:'ok', notes}`.
Tests: one file per endpoint (`operator-notify/done/skip/note.test.ts`): 401, 404, happy path (DB asserted), notify idempotent double-tap (1 notification_log row, 2nd call skipped:true), done computes next date + null when none, skip inserts no replacement, note appends with newline + 400 on empty.
Email tests rely on the Gmail **stub** path (no `GMAIL_SERVICE_ACCOUNT_JSON` in test env) → `sendAndLog` writes a `notification_log` row with `sent_at` set; assert the row + `kind`.
Set `process.env.OPERATOR_SECRET`/`OPERATOR_PASSWORD` in `beforeAll`; build the gate cookie via `signOperatorCookie()`.

### Task 6 — `/ops` frontend page
Filesystem-routed like `/manage` (no `vercel.json`): create `ops/index.html`,
`ops/app-ops.jsx`, `ops/components-ops.jsx`, `ops/ops.css`. Clone the manage
patterns (React via Babel-standalone, `fetch(..., {credentials:'same-origin'})`,
brand vars from `/styles.css`). Mobile-portrait, big tap targets.
- `PasswordCard` → `POST /api/operator/login`; on 401 from any operator call, show it.
- `Today / Upcoming` toggle. `StopCard`: name, address, phone (tel: link), bin
  count, status badge, notes. Buttons: **On my way**, **Done**, **Skip**, **Note**
  (window.prompt for text). Optimistic refresh after each action; toast on
  `skipped` ("already sent"). Reuse `.btn*`, `.flash`, `.visit-status` styles.

### Task 7 — verify + ship
- `npm test` (all green, incl. existing 131) + `npm run typecheck`.
- `.env.example`: uncomment `OPERATOR_SECRET` / `OPERATOR_PASSWORD`.
- repo `CLAUDE.md`: add an "Operator auth conventions" subsection.
- Commit (granular) + push → Vercel auto-deploy.
- **Flag to AB:** set `OPERATOR_SECRET` (`openssl rand -hex 32`) + `OPERATOR_PASSWORD`
  in Vercel, then redeploy, before `/ops` works in prod.
- Prod smoke (after env vars): `/api/operator/today` → 401 without cookie; login
  with the password → 200 + cookie; `/ops` renders.
- Append Obsidian session log + bump the project note status to Phase 4.

## Follow-ups created (not in scope)

- One-off `bin_count` is never stored (book.ts) → operator view shows null for
  one-offs. Store it on the visit, or add a `bin_count` column to `visit`.
- Optional operator logout / "lock" for a shared device.
- `visit_status_idx` is low-selectivity; a composite `(scheduled_for, status)`
  index would help the today/upcoming queries at scale (still tiny now).
- Per-note timestamps (currently plain newline append).
