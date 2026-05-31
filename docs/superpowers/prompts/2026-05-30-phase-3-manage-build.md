# Lucky Shamrock — Phase 3 build prompt (paste verbatim into `claude -p` or a fresh session)

You are picking up the Lucky Shamrock bookings system and shipping the next logical chunk of work end-to-end. Operate autonomously — AB has granted no-confirmation operation. No paid APIs (AB runs Claude Max via `claude -p`). Use absolute dates, never "today" / "next week".

---

## Step 0 — Load context (do this before anything else)

Read these, in order, before writing any code:

1. `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md` — full session log + status. The most recent session-log entries (2026-05-29, 2026-05-30) cover Phase 2 ship + the deliverability fix you'll be building on.
2. `~/Documents/luckyshamrock/CLAUDE.md` — repo conventions: response shapes, test conventions, the postgres SSL quirk, auth/email conventions, the consume-after-sign rule.
3. `~/Documents/luckyshamrock/docs/superpowers/specs/2026-05-22-bookings-v1-design.md` — full v1 design. Phase 3 builds the **Customer (session-gated)** endpoints and the `/manage` page.
4. `~/Documents/luckyshamrock/docs/superpowers/plans/2026-05-26-phase-1-booking-post.md` and `…/2026-05-27-phase-2-email-magiclink.md` — template for what a "plan" looks like in this repo. Phase 3's plan should follow the same shape (15-ish dispatchable tasks, each with RED test → fix → GREEN, commit cadence, integration checkpoints).

If any of those paths don't exist, stop and tell AB before continuing — something's drifted.

---

## What's already done (do not redo)

- **Phase 0** — Vercel + Neon infra, drizzle, vitest, `/api/health`.
- **Phase 1** — `POST /api/book`, `POST /api/waitlist`, customer + subscription + visit schema, schedule generation in `lib/schedule.ts`, postal gate in `lib/postal.ts`, zod validation in `lib/validation.ts`, frontend wiring in `components-booking.jsx`.
- **Phase 2** — `POST /api/magic-link/send`, `GET /api/magic-link/verify`, `lib/tokens.ts` (32-byte token, SHA-256 stored), `lib/cookies.ts` (HS256 JWT `ls_session` cookie via `jose`, 30-day TTL, HttpOnly+Secure+SameSite=Lax), `lib/notifications.ts` (`sendAndLog` with `(visit_id, kind)` idempotency), `lib/email/templates.ts` (4 templates), `lib/gmail.ts` (service-account JWT → REST POST). All env vars wired in Vercel: `SESSION_SECRET`, `SITE_URL`, `GMAIL_SERVICE_ACCOUNT_JSON`, `GMAIL_SEND_AS=sheasommerfeld@luckyshamrock.ca`. SPF + DKIM + DMARC published. Real Gmail send hits INBOX from the dev gmail recipient. Verified end-to-end in prod 2026-05-30.
- **Bug fixed this past session** — `api/magic-link/verify.ts` now signs cookie BEFORE marking the token consumed (so a sign failure doesn't burn the link). Regression test in `api/_tests/magic-link-verify.test.ts` ("leaves consumed_at null when cookie signing fails"). Commit `3e9a5a5`.

---

## Step A — Test-DB prod-bleed guard (do this FIRST, separately committable)

### Why

`db/client.ts` exports `truncateAllForTests()` which is called from every integration test's `beforeEach`. The current guard:

```ts
if (process.env.NODE_ENV === 'production') {
  throw new Error('truncateAllForTests must not run in production');
}
```

is insufficient — `vitest` doesn't set `NODE_ENV=production`, and `.env.local` holds the prod Neon URL. Running `npm test` locally truncates prod data. This session confirmed the footgun (real test customer rows were wiped mid-verification). Acceptable today because no real customers exist yet; **unacceptable as soon as a real booking lands**.

### What to build

Pick the lowest-friction safe option:

1. Require a separate `TEST_DATABASE_URL` env var (committed to `.env.example`, used by `truncateAllForTests`, distinct from `DATABASE_URL`). If unset OR equal to `DATABASE_URL`, **throw a clear error** — fail loud.
2. Provision a second Neon database (free tier under the same Neon project) named `luckyshamrock_test`. Add its URL as `TEST_DATABASE_URL` in `.env.local`. Vercel does NOT need `TEST_DATABASE_URL` set — production never runs truncate.
3. Update `db/client.ts`:
   - `getDb()` keeps using `DATABASE_URL` as today.
   - Add a `getTestDb()` (or rename internal helper) that reads `TEST_DATABASE_URL`.
   - `truncateAllForTests()` calls `getTestDb()` only.
4. Update `vitest.config.ts` to set the right URL for the duration of the test run (`globalSetup` that swaps `process.env.DATABASE_URL = process.env.TEST_DATABASE_URL`) — OR more simply, let tests import the test db helper directly. Pick whichever causes the least churn across the ~16 test files.
5. Re-run `npm test` against the test DB; confirm 0 rows in prod Neon afterward via a quick `psql` or one-off node script.

### Acceptance for Step A

- `npm test` passes (currently 92 passing).
- After a full test run, the **production** Neon DB (the one Vercel uses) has untouched data — including the test customer `dcf9ed4e-654f-4291-922e-64e8a5e717e7` if it's still there at the start of your work.
- Running `truncateAllForTests()` against a URL that matches `DATABASE_URL` throws a clear error.
- `.env.example` is updated with `TEST_DATABASE_URL=`.
- `CLAUDE.md` "Test parallelism note" section now also documents the test-DB requirement.

Commit Step A on its own. Suggested message: `chore(test): isolate truncate to TEST_DATABASE_URL`.

---

## Step B — Phase 3: `/manage` page + customer-session endpoints

### Scope (per spec §125–§196)

**Endpoints to add** (all session-gated via `ls_session` cookie verified by `lib/cookies.ts::verifySessionCookie`):

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/me` | Returns `{customer, subscription, upcoming_visits[]}` for the customer whose id is in the session. 401 with `{status:'unauthorized'}` if no/invalid cookie. Top up the visit schedule if fewer than N future visits exist (N=12 for monthly, 6 for bimonthly, 4 for quarterly — pick a reasonable rule and document it). |
| POST | `/api/visit/:id/skip` | 422 if the visit's customer doesn't match the session customer. 409 if the visit is already `done`/`skipped`/`cancelled`. Otherwise mark it `skipped` and insert a replacement visit one cadence-interval after the skipped one (extending the schedule by one slot), per spec §171. |
| POST | `/api/subscription/:id/cancel` | 422 if subscription doesn't belong to session customer. Marks subscription `cancelled`, sets `cancelled_at`, cancels all future-dated `scheduled` visits. |
| POST | `/api/subscription/:id/update` | Body: `{cadence?, bin_count?}`. Validates with zod. If `cadence` changed, regenerate the remaining schedule from "now" forward using the new cadence. If `bin_count` changed, just update the sub row. |
| POST | `/api/logout` | Clears the `ls_session` cookie (Max-Age=0). Always 200. |

**Frontend** — new route at `/manage`:

- `manage/index.html` + `manage/app.jsx` (or `components-manage.jsx` mirroring the existing pattern). React via Babel-standalone, no build step — match the existing setup.
- On load: fetch `/api/me`. If 401, render a "Sign in" view that POSTs to `/api/magic-link/send` (existing endpoint) and shows the customer-enumeration-safe success message.
- If 200: render customer info, current subscription, list of upcoming visits, and per-visit Skip buttons. Cancel-subscription button at the bottom. Cadence/bin-count edit controls.
- Cookie is sent automatically by the browser since it's same-origin.

### Response convention (matches existing Phase 1/2)

| Status | Body | Use |
|---|---|---|
| 200 | `{status:'ok', ...payload}` | success |
| 400 | `{status:'invalid', errors:{...}}` | zod failed |
| 401 | `{status:'unauthorized'}` | session cookie missing/invalid |
| 404 | `{status:'not_found'}` | resource doesn't exist |
| 409 | `{status:'<reason>', message}` | conflict (e.g. visit already done) |
| 422 | `{status:'<reason>', message}` | well-formed but business-invalid (e.g. wrong owner) |
| 500 | `{status:'error', message}` | unexpected |

### Acceptance for Step B

- All 5 endpoints have:
  - An integration test file at `api/_tests/<name>.test.ts` hitting the real test Neon (Step A makes this safe).
  - A unit/failure test file at `api/_tests/<name>.failure.test.ts` mocking the db.
  - Coverage for happy path + each error branch.
- The `/manage` page can be opened in a real browser (via the deployed site), it survives a hard refresh (cookie persists), and Skip/Cancel/Update buttons round-trip.
- A full smoke test from a single curl session:
  1. Book a customer via `/api/book`.
  2. Hit `/api/magic-link/send` to issue a token.
  3. Verify with the token to get the `ls_session` cookie.
  4. Use that cookie to hit `/api/me`, skip a visit, cancel the subscription, log out.
  5. Confirm `/api/me` after logout returns 401.
- `npm test` green. `npm run typecheck` green.

### Conventions to follow (don't trip on these)

- **App-side UUIDs** via `crypto.randomUUID()`. Do NOT introduce `gen_random_uuid()` or `pgcrypto`.
- **Postgres SSL quirk** — `db/client.ts` has `ssl: 'require'` explicitly. Don't remove it.
- **Test parallelism** — `vitest.config.ts` has `poolOptions.forks.singleFork = true`. Don't undo without solving the truncate race.
- **Cookie `Secure` is hard-coded** in `formatSessionCookieHeader` — production HTTPS only. Don't downgrade for local testing; use `vercel dev`.
- **Customer-enumeration safety** — endpoints that look up by email (`/api/magic-link/send`) always return 200 regardless. Don't break this for `/manage`-driven re-sends.
- **Idempotency for emails** — visit-bound emails use `(visit_id, kind)` uniqueness via `sendAndLog`. If you add new email kinds (e.g. `subscription_cancelled`), think about whether they're per-visit or per-customer.
- **Templates** — pure `(props) => {subject, html, text}` functions in `lib/email/templates.ts`. No template engine.
- **`/manage` redirect target** — `api/magic-link/verify.ts` already 307s here after consuming the token. Phase 3 just adds the destination.
- **Open Phase 1 follow-up still applies** — `/api/book`'s sequential customer + subscription + visit + magic_link_token INSERTs aren't in a transaction. The skip endpoint's "mark skipped + insert replacement" pair has the same shape. Use `db.transaction(...)` for both write-pairs in Phase 3 endpoints; while in there, consider also wrapping `/api/book` (one extra commit if it grows scope, otherwise leave a follow-up note).

### Spec deviations allowed (mention any in the plan)

- Spec says `{ok:true}` always. Phase 1 chose to differentiate 200/400/409/422. Keep doing that for Phase 3 — symmetry beats spec fidelity here.
- Spec mentions HMAC operator cookie in Phase 4 (not yet). Don't bleed operator session work into Phase 3.
- Spec mentions `pages/auth/verify` landing page. Probably not needed since `/api/magic-link/verify` already does the cookie+redirect server-side. Document the decision either way.

---

## Step C — Wrap up

1. Write a fresh plan file at `~/Documents/luckyshamrock/docs/superpowers/plans/2026-05-30-phase-3-manage.md` BEFORE writing code. Mirror the shape of the Phase 1 + Phase 2 plans (~15 tasks, each TDD-shaped).
2. Execute with the superpowers `subagent-driven-development` skill if available — each implementer dispatch picks one task, writes RED test, ships GREEN, commits. Spec reviewer + quality reviewer between dispatches.
3. Update `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md`:
   - Top-line **Status** field → reflect Phase 3 ship state.
   - Append a new dated `### 2026-05-30 — Phase 3 (Manage) shipped` section.
4. Update repo `CLAUDE.md` if any new conventions emerged (e.g. test-db pattern, transaction wrapping, new endpoint shapes).
5. Final smoke test from the curl session above. Paste the outputs into the session log.

---

## Definition of Done

- Step A committed separately, `truncateAllForTests` provably unable to touch prod.
- 5 new Phase 3 endpoints shipped with full test coverage.
- `/manage` page deployed and usable from a real browser.
- 92+ tests still green; typecheck green.
- Plan + session log + (if needed) CLAUDE.md updated.
- No new follow-ups left unrecorded in the session log.

If anything in the spec or the prior plans contradicts this prompt, prefer **this prompt** for scope and **the spec** for endpoint semantics — flag the contradiction in the plan file rather than guessing.

End of brief. Start with Step 0 (load context), then write the plan, then execute.
