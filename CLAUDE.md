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

**An address we can't deliver to is rejected at booking.** `lib/email-domain.ts`
`checkEmailDomain()` does an MX lookup and `/api/book` returns **422
`email_undeliverable`** on a definitive miss — checked on the `payment_setup`
intent (before the customer types a card, so a typo costs a correction rather
than a re-entered card) and again at final confirmation. Rules that matter:

- **It fails OPEN.** Only `ENOTFOUND`/`ENODATA`/an empty answer are
  `undeliverable`; a timeout, SERVFAIL, or unparseable address is `unknown` and
  the booking proceeds. Never lose a sale to flaky DNS.
- **No MX means undeliverable even if the domain has an A record.** RFC 5321's
  implicit-MX fallback is legal but in practice an A-only "mail domain" is a
  typosquatter (`gmial.com` is one), and delivering to a squatter is worse than
  bouncing. An RFC 7505 null MX (`0 .`, which `example.com` publishes) is also
  undeliverable.
- **It never touches the network under `npm test`** (`LUCKYSHAMROCK_TEST_RUN`),
  because the suite books hundreds of `@example.com` customers. Tests that mean
  to exercise the logic inject a resolver, which still runs.
- `suggestEmailFix()` turns a known typo domain into "Did you mean …?" — the
  message must stay actionable, since the customer has to fix it to buy.
- Written after a real customer paid $57 with `@hotmail.co` (no such domain) and
  all four of her emails bounced while `notification_log` recorded four
  successful sends. **"Sent" still does not mean "delivered"** — bounce handling
  does not exist.

## Auth + email conventions (Phase 2+)

- **Session cookies** are HS256 JWTs signed with `SESSION_SECRET`. Use `signSessionCookie` / `verifySessionCookie` from `lib/cookies.ts`. Cookie name: `ls_session`. 30-day absolute TTL. HTTP-only, Secure, SameSite=Lax. Sliding renewal lives in Phase 3.
- **Magic-link tokens** are 32 random bytes URL-safe base64. Always email the plaintext; store the SHA-256 hash via `hashToken()` from `lib/tokens.ts`. 1-hour TTL. Tokens are reusable within their TTL so inbox link scanners and repeat clicks do not break login; `consumed_at` records first use only.
- **Sending email** goes through `sendAndLog` (`lib/notifications.ts`), which wraps `sendEmail` and writes to `notification_log`. For visit-bound emails (`visitId !== null`) the wrapper short-circuits if a prior row exists with the same `(visit_id, kind)` — DB-enforced idempotency. Magic-link rows have `visitId: null` and are always sent.
- **Templates** live in `lib/email/templates.ts` as pure `(props) => {subject, html, text}` functions. Add a new template by exporting another function; don't pull in a template engine.
- **Gmail API client** is `lib/gmail.ts`. Sends via service-account JWT → OAuth → REST POST to `gmail.googleapis.com`. Falls back to a console-log stub (`[email:stub]` tag) when `GMAIL_SERVICE_ACCOUNT_JSON` is unset — that's the local dev / test path.
- **Env vars (Phase 2):** `SITE_URL`, `SESSION_SECRET`, `GMAIL_SERVICE_ACCOUNT_JSON`, `GMAIL_SEND_AS`. See `.env.example`.
- **Customer-enumeration safety:** endpoints that take an email and look it up (e.g., `POST /api/magic-link/send`) MUST always return 200/ok regardless of whether the email exists. Differentiating leaks the customer list to an attacker.
- **Operator gets an email per new booking** (`operator_new_booking` kind, enum
  migration 0006) sent to `OPERATOR_NOTIFY_EMAIL` || `GMAIL_SEND_AS`,
  best-effort (failure never fails the booking), idempotent on (first visit, kind).
- **All outbound HTML email goes through `brandWrap()`** in
  `lib/email/templates.ts` (green 🍀 header card, own footer — don't append a
  second footer). Table-based inline-styles only; Gmail/Outlook strip the rest.
- **Stripe Link is disabled account-wide** (payment_method_configuration
  `link.display_preference=off`, set 2026-07-04) so customers don't get
  Stripe's "create a Link account" emails during card save. Don't re-enable
  without AB's say-so.
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
- **🔴 Unfinished work ROLLS FORWARD onto today's route** (`scheduled_for <=`
  today for actionable statuses), flagged `overdue: true` per visit and sorted
  oldest-first. This is load-bearing: `today` is an exact date match,
  `upcoming` is strictly forward, and `history`/`attention` only cover
  done/skipped/cancelled — so before this, **a visit not completed on its
  scheduled day matched NO tab and became permanently invisible.** Five real
  jobs were lost that way, one for eleven days. **An explicit `?date=` keeps
  the exact match** (that view is for planning one specific day). If you add a
  visit list, ask what happens to it the morning after.
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
- **Operator Done requires photo proof in the UI, one before/after pair per bin.**
  `/ops` compresses each selected photo to JPEG and sends `POST /api/operator/act`
  `{op:'done', photos: [{before?, after}, ...]}` — one entry per `stop.bin_count`
  (max 3, matching the booking/walk-up bin_count ceiling), `after` required by the
  UI, `before` optional. Legacy single-bin callers may still send
  `before_photo`/`clean_photo` instead; `handleDone`'s `parsePhotoPairs` falls back
  to that shape as a single-entry array when `photos` is absent (`photos` always
  wins if both are present — don't rely on sending both). V1 does **not** store
  photos durably — email only. Backend accepts a no-after-photo bin for API
  compatibility but validates any supplied photo (JPEG/PNG/WebP, max 5 MB each).
- **The wash GIF is generated from bin 1 ONLY.** `generateWashGif` (sharp +
  gifenc) takes ~13s per pair — stacking one per bin would risk the 30s
  `maxDuration` on a 2-3 bin visit. Bins 2+ always render as plain before/after
  (or after-only) photo pairs, never a GIF, via `extraBins` on `doneTemplate` and
  the `binBeforePhotoCid(n)`/`binAfterPhotoCid(n)` helpers in
  `lib/email/templates.ts` (n = bin number, starting at 2 — bin 1 uses the
  original `DONE_*_PHOTO_CID` constants).
- **Done-email photos render INLINE, not as paperclip attachments.** The
  handler marks them `inline: true` with Content-IDs from
  `lib/email/templates.ts` (`DONE_BEFORE_PHOTO_CID`/`DONE_AFTER_PHOTO_CID` for
  bin 1, `binBeforePhotoCid`/`binAfterPhotoCid` for bin 2+);
  `buildRfc822Message` wraps inline images in `multipart/related` and the
  template references them as `<img src="cid:...">`. Both photos → side-by-side
  Before/After table card; after only → single inline "Sparkling clean" image;
  a before photo without an after photo is accepted but ignored per bin (no
  anti-testimonial emails). Email HTML must stay table-based with inline
  styles — Gmail/Outlook strip everything else.
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
- **Doorstep payments.** `POST /api/operator/act {op:'done'}` takes
  `payment_method` ∈ {card_on_file (default), cash, terminal, qr, etransfer}
  and an optional `amount_cents` override (server clamps 0–100000; blank =
  standard price). cash/terminal/etransfer record a succeeded `payment` row
  with that `method` and set `visit.payment_status` to
  `paid_cash`/`paid_terminal`/`paid_etransfer` — no Stripe call.
  qr creates a Stripe **Checkout Session** (`lib/billing.ts
  createDoorstepCheckoutSession`), returns `payment_url` for /ops to render as a
  QR, and leaves the visit `awaiting_payment` until
  `checkout.session.completed` lands (webhook locates the pending payment row
  scoped by `visitId`, `status='pending'`, and `method='qr'`). **That event MUST
  be in the live webhook's event list** or QR payments never confirm.
- **E-transfer (migration 0014) exists because its absence cost a record.**
  Interac e-transfer is normal for this trade in Canada; with only
  card/QR/terminal/cash on the Done screen, an operator who took one had
  nothing truthful to tap, and a real $57 job went out `unpaid` with **no
  `payment` row at all**. Like `terminal` it is **not** auto-reconciled — the
  money lands in the bank and tapping Done is what records it. **Any new
  settlement channel needs its own `payment_method` value, its own
  `payment_status`, and its own branch in `doneTemplate` + `receipt-pdf.ts`** —
  falling through to the `charged` branch tells a customer who paid another way
  that "your card on file was charged", which is false.
- **Tap to Pay is native-SDK only** (Stripe iOS/Android/React Native). It cannot
  work in the /ops web page. The `terminal` method means "operator collected in
  the Stripe app"; it is reconciled in Stripe by amount/time, not auto-linked.
- **Walk-up jobs.** `POST /api/operator/job` creates a customer + one-off visit
  for someone who flags the truck down. Deliberately **skips the service-area
  gate**. Customer and visit inserts wrap in a single `db.transaction(...)`
  (consistent with "Booking write atomicity"). A missing email becomes
  `walkup+<8hex>@luckyshamrock.ca` so the NOT NULL/UNIQUE constraints hold;
  those addresses receive no customer email.
- **Walk-up jobs take an optional `scheduled_for` (`YYYY-MM-DD`)** for the
  "come back in two weeks" deal made at the door; omitted = today
  (`operatorTodayISO()`), which stays the common case. The response echoes
  `scheduled_for` so /ops can tell the operator a future job landed under
  "All upcoming" rather than today's route. Validation rejects a **past** date
  and anything **more than a year out** — both would create a visit that never
  appears in `today` (exact match) or `upcoming` (forward-only), i.e. invisible
  work. **Sundays ARE allowed here**, unlike the customer-facing booking form:
  this endpoint already trusts the operator over the system (same reason it
  skips the service-area gate), so the day is their call. The `parseDateOnlyUtcNoon`
  helper is duplicated from `lib/validation.ts` rather than imported — keep them
  in sync if either changes.
- **A FUTURE-dated walk-up with a real email gets a `booking_confirmed` email**
  (same template + 1-hour manage link as a web booking; the magic-link token is
  only minted when we're actually sending). **Same-day walk-ups deliberately get
  nothing** — the operator is at the bin and the `done` email with photos and
  receipt follows within the hour, so a "you're booked" note would be noise.
  Placeholder `walkup+…` addresses never receive it. The send is best-effort and
  **after** the transaction: the job is already saved, so a mail failure must not
  500 an operator at the door (they'd re-tap and duplicate the job). It's awaited,
  not detached — Vercel freezes the lambda on response, which silently dropped a
  `void promise` send once before (see the 2026-06-10 magic-link P0). The response
  returns `confirmation_sent` (true only on a genuine fresh send: `ok && !skipped`)
  so /ops can warn the operator to say the date out loud when no email went out.
- **On-the-spot surcharge needs a reason, always.** `POST /api/operator/act
  {op:'done'}` takes `surcharge_cents` (0–50000) plus `surcharge_reason`, and
  **rejects an amount with no reason** — the reason prints on the customer's
  receipt and in the done email, because an unexplained extra on a card
  statement is how you earn a chargeback. Stored on the `payment` row
  (`surcharge_cents`/`surcharge_reason`, migration 0013) so it is auditable.
- **Order of money operations at Done is deliberate:** base (or the operator's
  amount override) **+ surcharge**, then **− discount**, then **− referral
  credit**. The surcharge is part of what is owed before anything comes off it,
  so "$15 extra, but here's $10 off" behaves the way the customer just heard it.
- **`customer.postal_code` is NULLABLE.** Self-serve bookings always supply one
  (it gates the service area), but a **walk-up collects a phone number instead**
  — the operator is standing at the address. **Every address string must
  tolerate a missing postal code**; `/ops` funnels them all through `addressOf()`
  and the server through `[street, [city, postal].filter(Boolean).join(' ')]`.
  Interpolating it directly renders "Fort Saskatchewan null" into Maps links and
  receipts.
- **A booking says WHICH bins, not just how many.** `lib/bin-types.ts` is the
  vocabulary — **`garbage` and `organics` only; we don't service blue
  recycling bins**, and a request naming one is rejected rather than quietly
  downgraded to a smaller job. `bin_types text[]` sits beside
  `bin_count` on both `subscription` and `visit` (migration 0015). Rules:
  - **`bin_count` stays the source of truth for money and photo pairing.**
    `bin_types` is the descriptive companion, and CHECK constraints
    (`*_bin_types_match_count`) stop them drifting. A request whose types and
    count disagree is **rejected**, never reconciled — trusting the smaller
    number would clean three bins for the price of one.
  - **It is NULLABLE and must stay optional.** Three live subscriptions predate
    it. Every render path goes through `describeBins()`, which falls back to
    "2 bins".
  - **Stored order is canonical** (`normalizeBinTypes` sorts to `BIN_TYPES`
    order) because photos, the per-bin email sections and the receipt are keyed
    by position — "bin 1" has to mean the same bin every visit.
  - The client list lives in `pricing.js` (`window.LS_BIN_TYPES`) with
    `lib/_tests/bin-types-sync.test.ts` as the drift guard, same pattern as
    prices. No build step means the browser can't import the server module.
- **Walk-up field order is name → street → phone → bins → email**, matching how
  the conversation actually goes at a gate. `street` is required, **and so is
  at least one of `phone` / `email`** — a walk-up with neither is a customer
  nobody can ever contact, which is how a $57 job on Woodbend Way went unpaid
  and unchaseable in August 2026. Enforced in `newJobSchema.superRefine` and
  mirrored in the `/ops` form so the operator sees it while the customer is
  still standing there.
- **`POST /api/operator/customer` patches a customer's details** (name, street,
  city, phone, email) — only the fields supplied. Details typed one-handed at a
  gate get typos, and customers often give an email only after the job is done.
  A duplicate email returns **409 `email_taken`** rather than letting the UNIQUE
  constraint surface as a 500.

- **Charge on Done is crash-safe + race-safe.** `handleDone` atomically CLAIMS
  the visit (`UPDATE ... WHERE id=? AND status IN (actionable) RETURNING`) so two
  concurrent Done taps can't both charge — the loser gets 409, not a duplicate
  `payment` 23505 → 500. The `payment` row is inserted as `pending` BEFORE the
  Stripe call and updated after, so a crash mid-charge still leaves a row for the
  webhook to reconcile (no charge-without-ledger-row).
- **🔴 Done must never complete with NO settlement recorded.** `payment_method`
  defaults to `card_on_file`, so a walk-up with no saved card used to be
  completed with **no `payment` row at all** — job done, money owed, nothing in
  the ledger. It happened twice (Dona Taverner 2026-08-10, Chris Wims
  2026-08-18) and both needed a developer editing the database. Now:
  `stopColumns` exposes `has_card`, /ops **disables "Card on file" when there
  isn't one and preselects nothing**, and Done stays disabled until a method is
  picked. The server stays permissive on purpose (Done never blocks) and still
  returns `nothing_collected`.
- **`POST /api/operator/act {op:'settle'}` records money already taken** for a
  visit that is already `done` — cash/terminal/etransfer only, since
  `card_on_file` and `qr` are live payment flows rather than bookkeeping.
  Claims the row with a status-guarded UPDATE so a double-tap 409s instead of
  writing two payments. This exists so a mis-settled job is fixable **from
  /ops**; before it, Needs attention listed such visits with no action at all.
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

## Referral program conventions

- **One balance, two sources.** `customer.credit_cents` holds BOTH the friend's
  welcome $5 and any referral $5 earned. There is no separate discount path —
  everything is balance, spent at Done. `REFERRAL_REWARD_CENTS` in
  `lib/referral.ts` is the single source for the amount.
- **Codes** are 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0/O/1/I/L` —
  they get said aloud over a fence). Issued at booking (`api/book.ts`) AND on
  walk-ups (`handleNewJob`); `db/backfill-referral-codes.ts` covers rows that
  predate the feature. **Any new customer-creation path must issue one** or that
  customer can never refer anyone.
- **`lib/referral.ts` must stay dependency-light.** `billing-webhook.ts` imports
  it; importing `operator-handlers.ts` there would drag `sharp` + `gifenc` + the
  ~947 KB sprite module into the webhook bundle. Same reason `walkup-email.ts`
  exists.
- **Credit is reserved before settlement, released if unspent.** The amount
  depends on it (and a QR Checkout Session must be created for that exact
  figure), so `spendCredit` runs first — but every branch that writes a
  `payment` row sets `creditCommitted`, and anything still reserved afterwards
  is handed back via `releaseCredit`. Without that, a customer with no card on
  file loses their balance on a clean nobody was charged for. **If you add a
  fifth settlement path, it must set `creditCommitted`.**
- **`check_referral` always returns 200** with a `valid` boolean — never 404 on
  an unknown code (that would be an enumeration oracle), and only ever the
  referrer's FIRST name. Same rule as `/api/magic-link/send`.
- **The referrer is paid only when money actually moved.** `comped` never pays.
  QR is awarded in `billing-webhook.ts` on `checkout.session.completed`, not at
  Done, because nobody has paid at Done time. `referral_awarded_at` is the
  idempotency guard — a redelivered webhook or double-tapped Done pays once.
- **Self-referral is blocked**, and `referred_by` is written once and never
  rewritten (so re-booking with a different code can't farm credit).
- **The done email's referral block sits BELOW the star row.** Those stars route
  4–5★ to Google and are the strongest growth lever in that email; a test in
  `lib/_tests/templates.test.ts` asserts the ordering.

## Active work

Current phase: see `docs/superpowers/plans/` for the most recent dated plan.
Specs: `docs/superpowers/specs/`.

## Related projects

- `~/Documents/binwash` — separate Django SaaS. Lucky Shamrock is its
  customer-facing brand but **not** built on top of it.
- Obsidian project notes: `~/Documents/My Brain/Projects/Lucky Shamrock/`.
