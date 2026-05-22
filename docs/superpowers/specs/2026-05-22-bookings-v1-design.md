# Lucky Shamrock Bookings v1 — Design

**Date:** 2026-05-22
**Status:** Design approved, ready for implementation plan
**Repo:** `~/Documents/luckyshamrock` (live on Vercel)
**Sibling project:** `~/Documents/binwash` (separate; not built on)

## Goal

Turn the existing static marketing site into a working bookings system. Customers can self-serve a booking (one-off or recurring), receive a notification on cleaning day when the operator is on the way, and manage their subscription via magic link — no passwords, no payments collected at v1.

Payments and SMS are deferred to v2.

## Non-Goals (out of v1)

- No payment collection. No Stripe. Pricing is shown but not charged. Operator collects manually (e-transfer / cash).
- No SMS. Email only. SMS deferred until Twilio A2P 10DLC is registered.
- No route optimization. Operator dashboard lists today's stops; operator picks order.
- No photo upload (before/after) — visual proof deferred.
- No multi-city. Service area is Fort Saskatchewan only (postal-code gated).
- No holiday-shift logic. Operator handles holiday weeks manually.
- No automated pickup-day lookup. Customer self-declares their pickup day from a dropdown; operator can correct.
- No customer accounts with passwords. Magic-link only.

## User Flows

### Customer — first booking

1. Visits site, clicks **Book**.
2. Booking form (replaces the current fake wizard):
   - Address fields (street, city, postal code)
   - Pickup-day dropdown (Mon–Fri)
   - Bin count (1 / 2 / 3+)
   - Plan choice: **One-off** or **Recurring** (monthly / bimonthly / quarterly)
   - Email (required)
   - Name (required)
   - Phone (optional)
3. Submits → server validates postal code is in service area → creates `customer`, `subscription` (if recurring) or `visit` (if one-off), generates schedule, sends two emails:
   - **Booking confirmed** — "You're booked for Wed May 28. Manage it here →"
   - **Magic link** — link to `/manage`
4. Success screen shown in-page with same info.

### Customer — managing booking

1. Clicks magic link from email → lands on `/manage`, server sets a session cookie (30-day expiry).
2. Sees: contact info, address, plan, upcoming visits.
3. Can: **skip** a specific visit, **change plan** (cadence / bin count), **cancel** subscription, **request a new magic link** if logged out.

### Customer — on cleaning day

1. Operator taps "On my way → [customer]" on their phone.
2. Customer receives **On our way** email: "Lucky Shamrock is heading to your bin now."
3. Operator taps "Done" after the clean.
4. Customer receives **Done** email: "Bins cleaned. Next clean: Wed Jun 11."

### Operator (AB) — daily

1. Opens `/ops` on phone, enters shared password (env-stored).
2. Sees today's visits: address, bin count, customer name, optional notes.
3. For each stop: tap **On my way** → email fires. Tap **Done** → marks complete.
4. Can also: mark a visit as **skipped** (e.g., bin not out), add a note.

## Data Model

Five tables. SQL-flavored — final SQL depends on the chosen DB (Vercel Postgres or Neon).

### `customer`
- `id` (uuid, pk)
- `email` (text, unique, lowercase)
- `name` (text)
- `phone` (text, nullable)
- `street` (text)
- `city` (text)
- `postal_code` (text)
- `pickup_day` (enum: mon, tue, wed, thu, fri)
- `notes` (text, nullable — operator notes)
- `created_at`, `updated_at` (timestamps)

### `subscription`
- `id` (uuid, pk)
- `customer_id` (fk → customer)
- `cadence` (enum: monthly, bimonthly, quarterly)
- `bin_count` (int, 1–3+)
- `status` (enum: active, paused, cancelled)
- `started_on` (date)
- `cancelled_at` (timestamp, nullable)
- `created_at`, `updated_at`

A customer with no subscription has only one-off visits. A customer can have at most one active subscription. A customer with an active subscription may also book one-off visits (those rows have `subscription_id = null`).

### `visit`
- `id` (uuid, pk)
- `customer_id` (fk → customer)
- `subscription_id` (fk → subscription, nullable for one-offs)
- `scheduled_for` (date — the clean day, i.e., day after pickup)
- `status` (enum: scheduled, heading_there, done, skipped, cancelled)
- `heading_there_at` (timestamp, nullable)
- `done_at` (timestamp, nullable)
- `notes` (text, nullable)
- `created_at`, `updated_at`

### `magic_link_token`
- `token` (text, pk — random 32-byte url-safe)
- `customer_id` (fk → customer)
- `expires_at` (timestamp — 15 minutes from issue)
- `consumed_at` (timestamp, nullable — single-use)
- `created_at`

### `notification_log`
- `id` (uuid, pk)
- `customer_id` (fk → customer)
- `visit_id` (fk → visit, nullable)
- `kind` (enum: magic_link, booking_confirmed, on_our_way, done, day_before)
- `sent_at` (timestamp, nullable — null if failed)
- `failed_at` (timestamp, nullable)
- `error` (text, nullable — short failure reason)
- `gmail_message_id` (text, nullable — for debugging)

Used to prevent double-sends when operator double-taps a button (idempotency key = `(visit_id, kind)`).

### Session storage

Sessions are HTTP-only cookies signed with a server secret. No session DB table needed — cookie carries `customer_id` + expiry + signature.

## API Endpoints

All under `/api/*` as Vercel serverless functions (Node/TypeScript).

### Public (no auth)
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/api/book` | `{name, email, phone?, street, city, postal_code, pickup_day, bin_count, plan: "oneoff"\|"monthly"\|"bimonthly"\|"quarterly", oneoff_date?}` | `{ok: true}` (always; details over email) |
| POST | `/api/magic-link/send` | `{email}` | `{ok: true}` (always; doesn't leak whether email exists) |
| GET | `/api/magic-link/verify?token=...` | — | 302 redirect to `/manage` + sets session cookie |

### Customer (session-gated)
| Method | Path | Returns |
|---|---|---|
| GET | `/api/me` | `{customer, subscription, upcoming_visits[]}` |
| POST | `/api/visit/:id/skip` | `{ok: true}` |
| POST | `/api/subscription/:id/cancel` | `{ok: true}` |
| POST | `/api/subscription/:id/update` | body: `{cadence?, bin_count?}` |
| POST | `/api/logout` | clears cookie |

### Operator (password-gated)
Auth: separate cookie set by `POST /api/operator/login` with shared password from env.

| Method | Path | Returns |
|---|---|---|
| POST | `/api/operator/login` | sets operator cookie |
| GET | `/api/operator/today` | `{visits: [{id, customer_name, address, bin_count, status, notes}]}` |
| GET | `/api/operator/upcoming?days=7` | upcoming visits across the next N days |
| POST | `/api/operator/visit/:id/notify` | triggers on-our-way email, sets `heading_there_at` |
| POST | `/api/operator/visit/:id/done` | marks done, triggers done email |
| POST | `/api/operator/visit/:id/skip` | marks skipped |
| POST | `/api/operator/visit/:id/note` | body: `{text}` |

## Schedule Generation

When a recurring subscription is created, generate the first N visits (N=12 for cadences ≤ monthly, fewer for longer cadences). When the customer logs in to `/manage`, top up the schedule if fewer than N future visits exist.

Visit date = first occurrence of `pickup_day + 1 day` that fits the cadence interval after `started_on`.

Examples (pickup day = Wednesday → clean day = Thursday):
- **Monthly:** every 4 weeks. First clean = first Thursday after `started_on`; then +28 days repeating.
- **Bimonthly:** every 8 weeks.
- **Quarterly:** every 13 weeks.

Cadence is measured in weeks (not calendar months) so the day-of-week stays consistent.

Skip: marks one visit `skipped` and inserts a new visit one cadence-interval after the skipped one (extending the schedule by one slot). Honor-system commitment, no penalties.

## Emails

All sent from a Google Workspace mailbox via Gmail API (preferred) or SMTP. Templates inlined in the code (no template engine needed at v1).

| Trigger | Template | Sent when |
|---|---|---|
| Booking created | `booking_confirmed.html` | After successful `POST /api/book` |
| Magic link requested or auto-issued at booking | `magic_link.html` | After `POST /api/magic-link/send` or first booking |
| Operator taps "On my way" | `on_our_way.html` | `POST /api/operator/visit/:id/notify` |
| Operator marks done | `done.html` | `POST /api/operator/visit/:id/done` |
| Day-before reminder *(optional v1.5)* | `reminder.html` | Cron job 24 hours before visit |

Idempotency: before sending, check `notification_log` for an entry matching `(visit_id, kind)`. If found, skip silently.

## Frontend Changes

Existing JSX is preserved. New files:

- `components-booking.jsx` — **rewritten**: replaces the fake wizard with a real form that posts to `/api/book`. Same visual styling, no design regression.
- `pages/manage/` — new route (just a static HTML+JSX page) for customer self-service. Calls `/api/me`, renders upcoming visits + skip/cancel buttons.
- `pages/ops/` — new route, password-gated, calls `/api/operator/*`. Optimized for mobile portrait (big tap targets, single column).
- `pages/auth/verify` — landing page for magic-link clicks. Just redirects after `/api/magic-link/verify` sets the cookie.

The marketing pages (Hero, Pricing, FAQ, etc.) are unchanged.

## Tech Stack

- **Hosting:** Vercel (already in use)
- **Frontend:** existing React + Babel-standalone (no build step)
- **API:** Vercel Serverless Functions, TypeScript, runtime = Node 20
- **Database:** Vercel Postgres OR Neon (decide in implementation; Neon if free tier persists longer, Vercel Postgres if tighter integration matters)
- **Email:** Gmail API via service account on Google Workspace (preferred), with SMTP fallback
- **Auth:** signed cookies (`jose` or `iron-session`), no session DB
- **Validation:** `zod` for request schemas
- **DB access:** `drizzle-orm` or raw SQL via `postgres` driver (decide in implementation)
- **Date math:** `date-fns` (small, tree-shakeable)

## Configuration / Env Vars

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | HMAC key for customer session cookies |
| `OPERATOR_SECRET` | HMAC key for operator session cookies |
| `OPERATOR_PASSWORD` | Shared password for operator login |
| `GMAIL_SERVICE_ACCOUNT_JSON` | Workspace service account credentials |
| `GMAIL_SEND_AS` | The Workspace address to send from (e.g., `hello@luckyshamrock.ca`) |
| `SITE_URL` | Public base URL, used in email links |
| `SERVICE_POSTAL_PREFIX` | Default `T8L`; allows override |
| `SERVICE_CADENCES` | Default `monthly,bimonthly,quarterly` |
| `BIN_PRICES_JSON` | Pricing for display, e.g., `{"1":{"monthly":22,...}}` |

All set via Vercel project settings (not committed). `.env.example` checked in.

## Defaults

- **Service area:** postal codes starting `T8L` (Fort Saskatchewan). Others → "We don't serve your area yet" with an email-capture for a future waitlist. The waitlist email is stored in a single `waitlist` table (`email`, `postal_code`, `created_at`) — small enough to include in v1.
- **Cadences:** monthly / bimonthly (every 8 weeks) / quarterly (every 13 weeks).
- **Bin tiers:** 1 bin, 2 bins, 3-or-more bins (single flat price for the 3+ tier).
- **Clean day:** the calendar day **after** customer's pickup day.
- **Operator auth:** one shared password (env var). Fine for one operator.
- **Magic-link TTL:** 15 minutes; single-use.
- **Session TTL:** 30 days, sliding renewal.
- **Pricing display:** read from `BIN_PRICES_JSON` env var so AB can adjust without code change.

## Error Handling

- **Postal code rejected:** form shows "We don't serve your area yet" with a "Notify me when you do" email capture.
- **Email send fails:** booking is still saved (DB row persists); failure is logged to `notification_log` with a `failed_at` field; operator sees a flag on the manage/ops view to retry manually. No external alerting service at v1.
- **Magic link expired:** verify endpoint shows a "Link expired, request a new one" page with a single email-input form.
- **DB unavailable:** booking form shows a generic "Something went wrong, please try again or email us at hello@..." message. No retry magic in v1.
- **Double-tap on operator button:** idempotent by `(visit_id, kind)` row in `notification_log`. Second tap shows a toast: "Already sent at 9:42 AM."

## Testing

- **Unit:** schedule generation (cadence math, edge cases around month boundaries), postal-code validation, magic-link token issue/verify.
- **Integration:** full happy path (book → email → click link → manage → operator triggers → email). One real HTTP request via test client per endpoint.
- **Smoke:** post-deploy curl checks `/api/book` returns 200 with valid input, `/api/operator/today` returns 401 without auth.

No browser/E2E tests at v1. Tested manually in real browsers before launch.

## Open Questions

None blocking implementation. Items to revisit during execution:

- Day-before reminder email — include if Vercel Cron is straightforward in the chosen DB stack, otherwise v1.5.
- Operator multi-day view (week ahead) — `/api/operator/upcoming` is in the API spec; the UI for it can land in v1.1.
- Final DB choice (Vercel Postgres vs Neon) — pick during Phase 0 based on whichever's setup is smoother that day. Schema is identical either way.
- Final DB access library (`drizzle-orm` vs raw `postgres` driver) — pick during Phase 0; both work, drizzle adds type safety, raw is simpler.

## Rough Build Phases

1. **Phase 0 — Infra:** add Postgres, env vars, basic `/api` health endpoint, deploy. Confirm Vercel logs work.
2. **Phase 1 — Booking POST:** form posts work, customer + visit/subscription rows created, schedule generated. Email stubbed.
3. **Phase 2 — Email:** Gmail API integration, magic-link issue + verify, all four templates sending.
4. **Phase 3 — Manage page:** customer self-service (skip, cancel, change plan).
5. **Phase 4 — Operator page:** password login, today view, notify + done buttons.
6. **Phase 5 — Polish:** error states, waitlist, optional day-before reminder, smoke tests, soft launch with AB as first customer.

Each phase shippable on its own.
