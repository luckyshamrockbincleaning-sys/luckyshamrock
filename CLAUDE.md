# Lucky Shamrock — repo instructions for Claude Code sessions

## What this repo is

Marketing site + booking system for **Lucky Shamrock Residential Bin Cleaning**
(Fort Saskatchewan). Hosted on Vercel. The customer-facing brand for AB's
BinWash side-business — but built standalone, not on the BinWash Django stack.

## Architecture

- **Static site** at repo root (`index.html` + `app.jsx` + `components-*.jsx` +
  `styles.css`). React via Babel-standalone in the browser. No build step.
- **Serverless API** in `api/`. TypeScript files become Vercel Functions
  (Node 20 runtime).
- **Database** = Neon Postgres. Accessed via `db/client.ts` (lazy singleton).
- **Migrations** = `drizzle-kit` (`npm run db:generate`, `npm run db:push`).
- **Tests** = `vitest`, files live in `**/_tests/**/*.test.ts` (nested dirs
  allowed). Env loaded from `.env.local` via `dotenv-cli`.

## Common commands

| Command | What it does |
|---|---|
| `npm install` | Install deps |
| `npm run dev` | `vercel dev` — local server with static + functions on :3000 (requires `npx vercel link` first) |
| `npm test` | Run vitest with `.env.local` |
| `npm run typecheck` | Type-only check, no emit |
| `npm run db:generate` | Generate SQL migrations from `db/schema.ts` |
| `npm run db:push` | Apply schema directly to Neon (use for fast dev, not prod) |
| `npx vercel env pull .env.local` | Refresh local env from Vercel |

## Production URLs

- **Site:** https://www.luckyshamrock.ca (apex `luckyshamrock.ca` 307-redirects to www)
- **Vercel preview:** https://luckyshamrock.vercel.app
- **Health check:** https://www.luckyshamrock.ca/api/health

## Working in this repo

- **Don't touch the static site files** (`index.html`, `app.jsx`, `components-*.jsx`,
  `styles.css`) when adding API code. They're served as-is.
- **API files** go in `api/` and become endpoints at `/api/<filename>` (without `.ts`).
  Static nested folders work: `api/operator/login.ts` → `POST /api/operator/login`.
- **⚠️ Multi-segment DYNAMIC routes don't reach the function in this project's
  Vercel runtime.** A catch-all `api/foo/[...path].ts` or nested
  `api/foo/[id]/[action].ts` 404s at the *platform* for any 2+/-segment URL — the
  function never runs. Only **single dynamic segments** are reliable
  (`api/operator/[action].ts`, `api/visit/[id]/skip.ts` where `[id]` is the only
  dynamic part). When you need id + sub-action, flatten to one segment and put the
  rest in the request **body/query** (see `POST /api/operator/act` `{id, op}`).
  Learned the hard way 2026-06-01 when `/ops` action buttons 404'd in prod.
- **DB schema changes** require both editing `db/schema.ts` AND running
  `npm run db:push` (or generating + applying a migration). The schema file
  is the source of truth.
- **Tests for `api/foo.ts`** go in `api/_tests/foo.test.ts`. The `_tests/` prefix
  is what vitest matches.
- **Integration tests** (hit real Neon) and **unit tests** (mock the DB via
  `vi.mock('../../db/client.js', ...)`) live side by side. See
  `api/_tests/health.test.ts` (integration) and `api/_tests/health.failure.test.ts`
  (unit) for the pattern.
- **Magic-link secrets, operator password, etc.** live in Vercel env vars,
  not in code. See `.env.example` for the full list. Add new vars in both
  `.env.example` (placeholder, committed) and Vercel dashboard (real value).
- **Postgres driver quirk:** `db/client.ts` sets `ssl: 'require'` explicitly
  because postgres-js's URL parser drops the `sslmode` hint when Neon's
  `channel_binding=require` is also present in the query string. Don't remove
  this line — it's load-bearing for production.

## API response convention

DB-touching endpoints return `{status, db, time, error}` with `error: null`
on success and a string on failure. Protocol-level rejects (e.g., 405 wrong
method) return a separate `{error: '<reason>'}` shape — those aren't health
or business-state assertions and don't carry `time`. See `api/health.ts`
for the reference implementation.

## Booking endpoint conventions

`/api/book` and similar mutation endpoints follow this response contract:

| Status | Body shape | Meaning |
|---|---|---|
| 200 | `{status: 'ok', ...payload}` | success |
| 400 | `{status: 'invalid', errors: Record<string, string[]>}` | zod validation failed |
| 409 | `{status: '<reason>', message}` | request conflicts with current state (e.g., `already_subscribed`) |
| 422 | `{status: '<reason>', message}` | request is well-formed but business-invalid (e.g., `out_of_area`) |
| 500 | `{status: 'error', message}` | unexpected server failure; logged with the endpoint's `[name]` tag |

Pure-validation tests (mocked DB) live in `api/_tests/<endpoint>.failure.test.ts`. Integration tests (real Neon) live in `api/_tests/<endpoint>.test.ts` and must call `truncateAllForTests()` in a `beforeEach` to keep rows from leaking between cases.

App-side UUIDs via `crypto.randomUUID()` everywhere. Do not introduce `gen_random_uuid()` or `pgcrypto` without a strong reason.

**500 responses are generic.** Endpoint catch blocks `console.error` the real error server-side but return a fixed `{status:'error', message:'Something went wrong…'}` to the client — never the raw `err.message` (it can leak driver/schema detail). Exceptions: `api/health.ts` (the error string is its documented contract) and the Stripe webhook (Stripe-facing).

**Only sold plans are bookable.** `lib/validation.ts` `planField` accepts `oneoff|monthly|seasonal`. `bimonthly`/`quarterly` stay in the DB `cadence` enum + `Cadence` type for legacy subscriptions, but a crafted `/api/book` cannot create them.

**Client prices have one source.** `/pricing.js` sets `window.LS_PRICING` (dollars), consumed by `components-mid.jsx` + `components-booking.jsx`. `lib/_tests/pricing-sync.test.ts` fails the build if it drifts from `lib/pricing.ts` (cents). Change a price → change `pricing.js` + `lib/pricing.ts` together. (No build step means the client can't import the server module; this is the shared-source workaround.)

**Schema invariants (migration 0005):** partial unique `one_active_sub_per_customer` (one active sub per customer, backs the app-level `already_subscribed` guard); partial `visit_actionable_idx` on `scheduled_for WHERE status IN ('scheduled','heading_there')` (replaced the low-selectivity full `visit_status_idx`); CHECK constraints `payment_amount_non_negative`, `payment_discount_non_negative` (NB: discount may exceed amount on a comp), `visit/subscription_bin_count_positive`. `customer.bin_location` (curb/side/garage/back) is collected at booking and shown on the operator stop card. `payment_status` enum gained `refunded`.

**Test parallelism note:** `vitest.config.ts` sets `poolOptions.forks.singleFork = true` to serialize test files. Integration tests TRUNCATE the shared Neon DB; parallel files race on that. Don't undo this without solving the race a different way (per-file schemas, transactions, etc.).

**Test database isolation (load-bearing):** `npm test` runs against a **separate Neon database** (`neondb_test`), not the production `neondb`. The plumbing:

- `.env.local` holds both `DATABASE_URL` (prod) and `TEST_DATABASE_URL` (test). `.env.example` documents both.
- `vitest.config.ts` declares `globalSetup: ['./db/test-setup.ts']`. That setup script:
  1. Refuses to start if `TEST_DATABASE_URL` is missing or equal to `DATABASE_URL`.
  2. Swaps `process.env.DATABASE_URL` → `TEST_DATABASE_URL` for the duration of the run.
  3. Sets a `LUCKYSHAMROCK_TEST_RUN=1` marker.
- `truncateAllForTests()` in `db/client.ts` refuses to fire without that marker AND requires `DATABASE_URL === TEST_DATABASE_URL` at call time (defense in depth).

Without all of the above, `npm test` against `.env.local` will throw before any TRUNCATE runs. Provision the test DB once via:
```bash
psql "$DATABASE_URL_UNPOOLED" -c 'CREATE DATABASE neondb_test'
DATABASE_URL=<test-url> DATABASE_URL_UNPOOLED=<test-url-unpooled> npx drizzle-kit push --force
```
Schema drift requires re-running `drizzle-kit push --force` against the test URL. Don't add real customer-like data to `neondb_test` — it gets truncated every test case.

**Booking write atomicity:** `/api/book` wraps customer + subscription + visit + magic_link_token writes in one `db.transaction(...)`; email sends and best-effort Stripe customer provisioning stay outside the transaction.

## Auth + email conventions (Phase 2+)

- **Session cookies** are HS256 JWTs signed with `SESSION_SECRET`. Use `signSessionCookie` / `verifySessionCookie` from `lib/cookies.ts`. Cookie name: `ls_session`. 30-day absolute TTL. HTTP-only, Secure, SameSite=Lax. Sliding renewal lives in Phase 3.
- **Magic-link tokens** are 32 random bytes URL-safe base64. Always email the plaintext; store the SHA-256 hash via `hashToken()` from `lib/tokens.ts`. 1-hour TTL. Tokens are reusable within their TTL so inbox link scanners and repeat clicks do not break login; `consumed_at` records first use only.
- **Sending email** goes through `sendAndLog` (`lib/notifications.ts`), which wraps `sendEmail` and writes to `notification_log`. For visit-bound emails (`visitId !== null`) the wrapper short-circuits if a prior row exists with the same `(visit_id, kind)` — DB-enforced idempotency. Magic-link rows have `visitId: null` and are always sent.
- **Templates** live in `lib/email/templates.ts` as pure `(props) => {subject, html, text}` functions. Add a new template by exporting another function; don't pull in a template engine.
- **Gmail API client** is `lib/gmail.ts`. Sends via service-account JWT → OAuth → REST POST to `gmail.googleapis.com`. Falls back to a console-log stub (`[email:stub]` tag) when `GMAIL_SERVICE_ACCOUNT_JSON` is unset — that's the local dev / test path.
- **Env vars (Phase 2):** `SITE_URL`, `SESSION_SECRET`, `GMAIL_SERVICE_ACCOUNT_JSON`, `GMAIL_SEND_AS`. See `.env.example`.
- **Customer-enumeration safety:** endpoints that take an email and look it up (e.g., `POST /api/magic-link/send`) MUST always return 200/ok regardless of whether the email exists. Differentiating leaks the customer list to an attacker.
- **Cookie `Secure` flag is hard-coded** in `formatSessionCookieHeader`. This means the cookie is silently dropped over plain HTTP — fine for production (HTTPS) and `vercel dev` proxy, but if you ever test against `http://localhost` directly the session cookie won't stick. Don't downgrade — fix the URL instead.
- **Workspace setup** for production Gmail send is documented in `docs/superpowers/plans/2026-05-27-phase-2-email-magiclink.md` Task 1. If a future session sees Gmail failing, start there.

## Operator auth conventions (Phase 4)

- **Separate session from customers.** Operator auth is its own `ls_operator`
  HS256 JWT (payload `{ op: true }`) signed with `OPERATOR_SECRET`, helpers in
  `lib/operator.ts`. Never reuse `ls_session`/`SESSION_SECRET` for operator gating
  — `getSessionCustomerId` and `getOperatorSession` are deliberately distinct.
- **Login** is `POST /api/operator/login` with `{password}`, checked **timing-safe**
  against `OPERATOR_PASSWORD`. Operator endpoints gate on `getOperatorSession(req)`
  → 401 `{status:'unauthorized'}`. One shared password; no per-user identity.
- **Routing is single-segment** (`api/operator/[action].ts` → `lib/operator-handlers.ts`).
  Routes: `login`, `today`, `upcoming`, `attention`, and `act`. **Visit actions go
  through `POST /api/operator/act` with body `{id, op, text?}`** where `op` ∈
  {notify, done, skip, note, retry} — NOT `/api/operator/visit/:id/:action`
  (multi-segment, 404s in prod; see the API-files note above). `handleAct`
  validates the body and delegates to the per-op handlers, which read the id from
  `req.query.id`. `GET /api/operator/attention` lists done visits whose charge
  failed; `{op:'retry'}` re-charges one (fresh idempotency key per attempt).
- **"Today" is Edmonton-local** via `operatorTodayISO()` (route runs in Mountain
  Time; UTC "today" flips mid-evening). `today`/`upcoming` accept `?date=YYYY-MM-DD`.
  `upcoming` returns all future actionable visits after the anchor date, not a
  7-day window.
- **Active route lists are actionable only.** `today`/`upcoming` return only
  `scheduled` and `heading_there` visits. `notify`, `done`, and `skip` reject
  `skipped`, `done`, and `cancelled` visits with 409 `not_actionable`.
- **`bin_count` per visit type:** recurring visits derive it from the
  subscription (LEFT JOIN, `visit.bin_count` null); one-off visits store it on
  `visit.bin_count` (no subscription to derive from). The operator view selects
  `COALESCE(visit.bin_count, subscription.bin_count)` so both render correctly.
- **Operator skip ≠ customer skip:** operator skip just marks the visit `skipped`
  (no replacement). Customer skip (`/api/visit/:id/skip`) inserts a replacement.
- **Operator Done requires photo proof in the UI.** `/ops` compresses the selected
  clean-bin photo to JPEG and sends it in `POST /api/operator/act` as
  `clean_photo`; the Done email attaches it. V1 does **not** store photos
  durably — email attachment only. Backend accepts no-photo Done for API
  compatibility but validates any supplied photo (JPEG/PNG/WebP, max 5 MB).
- **notify/done are double-tap-safe** for free via `sendAndLog`'s `(visit_id, kind)`
  idempotency — a second tap returns `{skipped:true}` and sends no second email.
- **New env vars:** `OPERATOR_SECRET` (`openssl rand -hex 32`), `OPERATOR_PASSWORD`.
  `/ops` shows the password gate without them, but login + the API 500/401 until
  both are set in Vercel.
- **`/ops` page** is filesystem-routed like `/manage` (no `vercel.json`): the
  `ops/` dir (`index.html` + `app-ops.jsx` + `components-ops.jsx` + `ops.css`).

## Payments / Stripe conventions (Phase 6)

- **Graceful degradation is load-bearing.** `lib/stripe.ts` (`getStripe` +
  `isStripeConfigured`) and `lib/billing.ts` return null / `{ok:false}` and NEVER
  throw when keys are absent — booking and the operator "Done" flow must work
  with or without Stripe. Same philosophy as the Gmail stub.
- **We bill per-visit, not via Stripe Subscriptions.** Card saved at booking
  (Stripe Customer + SetupIntent), charged on the operator **Done** tap
  (off-session PaymentIntent). Keeps skip/seasonal/discount logic ours.
- **Prices are server-side only** (`lib/pricing.ts`, in cents). NEVER trust a
  client-sent amount. First bin uses the plan price; each extra bin is
  `$12/clean`. Discount comes from the operator (`discount_cents` on the `done`
  op), clamped to `[0, base]`.
- **A charge failure never blocks "Done."** Declined card → `visit.payment_status
  = 'failed'` + a flagged `payment` row; the clean still completes. Full discount
  → `comped` (no Stripe call).
- **The webhook is the source of truth** for payment state
  (`api/stripe/webhook.ts` → `lib/billing-webhook.ts`). It needs the RAW body, so
  it sets `export const config = { api: { bodyParser: false } }`. It's the ONE
  Stripe function — **we're at 12/12 on Vercel Hobby.** Adding ANY new function
  now fails the build; consolidate or upgrade to Pro first. The handler rejects
  forged/absent signatures with 400 and NEVER calls `applyStripeEvent` in that
  case (covered by `api/_tests/stripe-webhook.test.ts`).
- **Webhook events to subscribe in the Stripe dashboard:**
  `setup_intent.succeeded`, `payment_method.attached`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, **and `charge.refunded`** (the last flips the
  `payment` row + `visit.payment_status` to `refunded`; without it, a dashboard
  refund leaves the row showing `charged`).
- **Charge on Done is crash-safe + race-safe.** `handleDone` atomically CLAIMS
  the visit (`UPDATE ... WHERE id=? AND status IN (actionable) RETURNING`) so two
  concurrent Done taps can't both charge — the loser gets 409, not a duplicate
  `payment` 23505 → 500. The `payment` row is inserted as `pending` BEFORE the
  Stripe call and updated after, so a crash mid-charge still leaves a row for the
  webhook to reconcile (no charge-without-ledger-row).
- **Failed charges are surfaced, not silent.** A declined card flags the visit
  `payment_status='failed'` (never blocks Done) and shows up in: the operator
  `GET /api/operator/attention` list (with a `{op:'retry'}` re-charge via
  `/api/operator/act`), and the customer's `/manage` banner (`GET /api/me`
  returns `payment_alert`).
- **Card setup is folded into existing functions** to respect the 12-cap.
  Booking uses `POST /api/book` with `{intent:'payment_setup'}` before final
  confirmation; `/manage` still uses `POST /api/me` for replacing the saved card.
  Both load Stripe.js + Elements on the client.
- **Env:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
  Use `sk_test_`/`pk_test_` until a deliberate live cutover. Pin the SDK
  `apiVersion` in `lib/stripe.ts` (currently `2026-05-27.dahlia` for stripe@22).

## Active work

Current phase: see `docs/superpowers/plans/` for the most recent dated plan.
Specs: `docs/superpowers/specs/`.

## Related projects

- `~/Documents/binwash` — separate Django SaaS. Lucky Shamrock is its
  customer-facing brand but **not** built on top of it.
- Obsidian project notes: `~/Documents/My Brain/Projects/Lucky Shamrock/`.
