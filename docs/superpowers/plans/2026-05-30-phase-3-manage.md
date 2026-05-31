# Phase 3 — Manage page + customer-session endpoints

**Date:** 2026-05-30
**Spec:** `docs/superpowers/specs/2026-05-22-bookings-v1-design.md` §125–§196
**Builds on:** Phase 2 (cookies, magic-link, send pipeline) at `3e9a5a5..80cdc32`

## Goal

Land the customer-facing self-service surface: a `/manage` page customers reach via magic link, where they can see their subscription + upcoming visits, skip individual visits, cancel the subscription, and change cadence/bin_count.

Phase 2 redirects `/api/magic-link/verify` → `/manage` with a `ls_session` cookie. Phase 3 makes `/manage` exist.

## Acceptance (Definition of Done)

- Five new endpoints shipped: `/api/me`, `/api/visit/:id/skip`, `/api/subscription/:id/cancel`, `/api/subscription/:id/update`, `/api/logout`.
- New static page at `/manage` (HTML + JSX, no build step) that calls `/api/me` and renders the customer-facing controls.
- Each endpoint has an integration test (real test Neon) + a failure-mode test (mocked DB).
- Smoke test from a single curl session: book → magic-link → verify → /api/me → skip → cancel → logout → /api/me 401.
- 94+ tests green; typecheck green.
- Session log updated; `CLAUDE.md` extended if new conventions emerge.

## Order

1. **Task 1** — `lib/session.ts`: extract cookie-reading helper used by all session-gated endpoints.
2. **Task 2** — `POST /api/logout`: simplest, no DB; proves the cookie-clear path.
3. **Task 3** — `GET /api/me`: read-only, returns `{customer, subscription, upcoming_visits[]}`. Includes schedule top-up for recurring subscriptions.
4. **Task 4** — `POST /api/visit/:id/skip`: mark visit `skipped` + insert replacement one cadence-interval later. Use `db.transaction(...)`.
5. **Task 5** — `POST /api/subscription/:id/cancel`: mark sub `cancelled` + bulk-cancel future scheduled visits. Use `db.transaction(...)`.
6. **Task 6** — `POST /api/subscription/:id/update`: body `{cadence?, bin_count?}`. If cadence changed, regenerate future schedule from "now" using new cadence; preserve already-`done` visits.
7. **Task 7** — Frontend `/manage` page: `manage/index.html` + `components-manage.jsx`. Mirrors root pattern (Babel-standalone, no build).
8. **Task 8** — End-to-end smoke test via curl against prod (after Vercel deploys). Document the cookie-jar flow in the session log.
9. **Task 9** — Wrap `/api/book` writes in a transaction too (the long-open follow-up; small once `db.transaction(...)` is already imported elsewhere).

Each task: RED test first, then ship, then GREEN. Commit per task.

## Conventions

(All from `CLAUDE.md` — restated here for the record.)

- Response shapes:
  - 200 `{status:'ok', ...payload}`
  - 400 `{status:'invalid', errors:{...}}`
  - 401 `{status:'unauthorized'}`
  - 404 `{status:'not_found'}`
  - 409 `{status:'<reason>', message}` (conflict with state, e.g. visit already done)
  - 422 `{status:'<reason>', message}` (well-formed but business-invalid, e.g. wrong owner)
  - 500 `{status:'error', message}`
- App-side UUIDs via `crypto.randomUUID()`.
- `db.transaction(...)` for any endpoint with 2+ writes.
- Customer ownership check on every visit/subscription mutation: 422 with `status:'not_yours'` if the resource exists but belongs to another customer (don't leak existence vs ownership separately).
- Schedule top-up rule: if recurring sub has fewer than **N future visits** (`scheduled` status, date >= today), generate up to N. N = 12 for monthly, 6 for bimonthly, 4 for quarterly.
- Skip replacement rule: when skipping a visit, insert a new `scheduled` visit at `skipped_visit.scheduled_for + cadence_interval_weeks * 7 days`. Honors the spec's "extending the schedule by one slot" wording.

## Spec deviations (intentional)

- Spec says `{ok:true}` always. We've been using 200/400/409/422 since Phase 1. Continue.
- Spec mentions `pages/auth/verify` landing page. Not needed — `/api/magic-link/verify` does the cookie+redirect server-side. Skipping.
- Spec puts `/manage` schedule top-up server-side (inside `/api/me`). Following the spec.

## Out of scope (Phase 4+)

- Operator endpoints (`/api/operator/*`, password-gated)
- Day-before reminder cron
- Pause subscription (vs cancel) — spec lists `paused` enum value but no UI control planned for v1
- Sliding session renewal (currently absolute 30-day TTL)
