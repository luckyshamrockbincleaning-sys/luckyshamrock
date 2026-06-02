# Phase 6 — Stripe Payments

**Date:** 2026-06-02
**Status:** Plan / design — not yet started
**Depends on:** Phases 0–5 shipped. v1 deliberately collected **no** payment
(operator took e-transfer/cash). This phase turns the site's existing
"card on file / charged after service" copy into reality.
**Prereqs from AB:** Stripe account + Products already created ✅. Need the
**API keys** (test + live secret keys, publishable key) and the webhook signing
secret (created during setup).

---

## Goal

Automate getting paid: capture a **card on file** when a customer books, then
**charge it automatically when the operator marks a visit Done** — with the
ability to **apply a one-off discount** at charge time. Plus a realistic answer
for **in-person Tap-to-Pay** collection.

---

## The three asks — honest assessment

### 1. Automated charging — ✅ clean fit

Stripe's standard "save now, charge later" flow maps perfectly onto what we
already built:

- **At booking:** create a Stripe **Customer** + a **SetupIntent** to save the
  card (no charge yet). This is exactly the "card on file" the site promises.
- **At operator "Done":** the `/ops` Done tap already fires the done-email and
  marks the visit done. We add: create an **off-session PaymentIntent** against
  the saved card and charge it. One tap = clean + charge + receipt.
- **Recurring plans:** each visit's Done triggers its own charge, so monthly /
  Three Wash Season bill per-clean automatically. No Stripe Subscriptions object
  needed — we keep our own schedule and charge per-visit (more flexible for
  skips/discounts/seasonal).

### 2. Discount on the spot — ✅ trivial

Before charging, the operator can enter a discount (% or $) on the stop in
`/ops`. The backend computes `amount = plan_price * bins - discount` and charges
that. Stored on the `payment` row so it shows on the receipt and in reporting.
No Stripe Coupons needed — it's just a smaller PaymentIntent amount.

### 3. Tap-to-Pay on your phone — ⚠️ real, but needs a native app

**This is the one with a catch.** "Tap to Pay on iPhone" is a genuine Stripe
feature (part of **Stripe Terminal**), but it has a hard requirement:

> Tap to Pay on iPhone requires a **native iOS app** built with the Stripe
> Terminal iOS SDK. It **cannot** run inside a web page — so it can't live in
> our `/ops` React page (which is just HTML/JS in the phone's browser).

So there's no way to bolt Tap-to-Pay onto the current web-based `/ops`. The
realistic options, cheapest first:

- **Option A — Stripe Dashboard app's built-in Tap to Pay (zero dev).**
  Stripe's own iOS **Dashboard app** has Tap to Pay built in. For a walk-up /
  "charge a different card than the one on file" moment, AB opens the Stripe app
  and taps the customer's card. **Downside:** it's disconnected from our booking
  data — the charge lands in Stripe but our `payment` table doesn't know about
  it unless we reconcile via webhook (we can: match by amount/customer, or AB
  just notes it). Good enough for the rare in-person case at launch.
- **Option B — card on file is the default (recommended for 95% of charges).**
  Most cleans happen when the customer isn't home ("no need to be home" is a
  selling point), so **there's nobody to tap a card anyway.** The card-on-file
  auto-charge covers the overwhelming majority. Tap-to-Pay is only for the
  occasional in-person exception.
- **Option C — native iOS app later (big lift).** A real Lucky Shamrock iOS app
  with the Terminal SDK + a `connection_token` backend endpoint. Only worth it
  if in-person tapping becomes common. **Not recommended for a one-operator shop
  at launch** — it's weeks of work + App Store review for a rare case.

**Recommendation:** Build **card-on-file auto-charge + on-the-spot discount**
now (Phase 6 below). Use the **Stripe Dashboard app (Option A)** for the rare
in-person tap, reconciled by webhook. Revisit a native app (Option C) only if
in-person volume justifies it. This plan implements card-on-file; Tap-to-Pay
proper is explicitly out of scope (documented as a follow-up).

---

## ⚠️ Hard constraint: Vercel Hobby 12-function limit

We're at **11/12** serverless functions. Stripe needs at minimum:
- **1 webhook receiver** (`/api/stripe/webhook`) — must be its own function
  (raw-body signature verification; can't share a route).
- card-setup + charge logic.

Naive implementation = 13–14 functions → **build fails** (we hit this exact wall
in Phase 4). Mitigations, in order of preference:
1. **Consolidate to stay ≤12:** put the webhook as the one new function, and
   fold all *operator* charge actions into the existing `/api/operator/act`
   dispatcher (add ops `charge` / `set_discount`), and the *customer* card-setup
   into `/api/me` or a tiny addition to an existing route. Net new functions: **1**
   (webhook) → lands at **12**. Tight but works.
2. **Upgrade to Vercel Pro** (~$20/mo) — lifts the limit, removes the squeeze,
   and you'll want it once there's real traffic anyway. **Recommended** the
   moment money is involved; $20/mo against real revenue is nothing and it stops
   us contorting the architecture.

Decision needed from AB before build: **stay on Hobby (consolidate hard) or go
Pro.** Plan below assumes we *can* add 1–2 functions; if Pro, no consolidation
gymnastics.

---

## Data model changes

### `customer` — add billing identifiers
- `stripe_customer_id` (text, nullable) — the Stripe Customer.
- `default_payment_method_id` (text, nullable) — saved card after SetupIntent.

(Or a separate `billing` table; inline columns are simpler for one card.)

### New `payment` table
- `id` (uuid, pk)
- `customer_id` (fk → customer)
- `visit_id` (fk → visit, nullable) — the clean being charged
- `stripe_payment_intent_id` (text, unique) — idempotency + reconciliation
- `amount_cents` (int) — what we actually charged
- `discount_cents` (int, default 0) — operator's on-the-spot discount
- `currency` (text, default 'cad')
- `status` (enum: pending, succeeded, failed, refunded)
- `failure_reason` (text, nullable)
- `created_at`, `updated_at`

### `visit` — add charge link
- `payment_status` (enum: unpaid, charged, comped, failed; default 'unpaid')
  — lets `/ops` show "💳 charged" vs "needs payment" per stop.

Migration is additive (new table + nullable columns + enum) → safe on the
(currently empty) prod DB, same pattern as migrations 0002/0003.

---

## New env vars (Vercel)

| Name | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | server-side API key (test `sk_test_…`, live `sk_live_…`) |
| `STRIPE_PUBLISHABLE_KEY` | client-side key for the card-collection UI |
| `STRIPE_WEBHOOK_SECRET` | verifies webhook signatures (`whsec_…`) |
| `STRIPE_PRICE_*` *(optional)* | if we read prices from Stripe instead of hardcoding |

Add `stripe` to `package.json` dependencies.

---

## Build phases (each shippable)

### Phase 6a — Card on file at booking
1. `lib/stripe.ts` — lazy Stripe client singleton (mirrors `db/client.ts`).
2. Schema: add `stripe_customer_id` + `default_payment_method_id` to customer;
   migration; push test + prod.
3. `book.ts`: after creating the customer, create a Stripe Customer, store the id.
4. Card collection UI: after a successful booking, the success screen mounts
   **Stripe Elements** (publishable key) with a **SetupIntent** to save the card.
   Endpoint to create the SetupIntent (fold into an existing route to save a
   function, or `/api/billing/setup` if going Pro).
5. Webhook `/api/stripe/webhook`: on `setup_intent.succeeded` /
   `payment_method.attached`, store `default_payment_method_id`. Signature-verify
   with `STRIPE_WEBHOOK_SECRET`.
6. TDD: mock the Stripe client; assert Customer created at booking, payment
   method stored on webhook. Smoke in Stripe **test mode** with a test card.

### Phase 6b — Auto-charge on operator "Done" + on-the-spot discount
1. `/ops`: add a discount input (per stop) + show plan price. Operator sets an
   optional discount before tapping Done.
2. Extend the `done` op (in `/api/operator/act`) — accept an optional
   `discount_cents`. On Done: compute amount, create an **off-session
   PaymentIntent** (`customer`, `payment_method`, `off_session:true`,
   `confirm:true`), write a `payment` row, set `visit.payment_status`.
3. Handle the no-card / charge-failed case gracefully: mark `payment_status`
   `failed`, surface a flag in `/ops` so AB can retry or collect another way.
   **Never block marking the clean Done because a charge failed.**
4. Webhook: on `payment_intent.succeeded` / `payment_intent.payment_failed`,
   update the `payment` row (source of truth = webhook, not the API response).
5. Receipt: Stripe can email its own receipt, or extend our `done` email with
   "Charged $X (–$Y discount)". TDD + test-mode smoke (success card, declined
   card `4000000000000341` off-session-fail).

### Phase 6c — Reconciliation + polish (optional / later)
- `/ops` "needs payment" filter; manual "charge now" retry for failed/unpaid.
- Reconcile Option-A (Stripe Dashboard Tap to Pay) charges back to visits via
  webhook matching, or a manual "mark paid (external)" button.
- Refund button (operator-initiated) for comps/complaints.

---

## Testing

- **Unit/integration:** mock `lib/stripe.ts` (like we mock `db/client.ts`);
  assert Customer creation, SetupIntent, off-session PaymentIntent params,
  discount math, webhook row updates, and the charge-failed-but-still-done path.
- **Test mode end-to-end:** real Stripe **test** keys, test cards (success +
  off-session decline), real webhook via Stripe CLI `stripe listen` →
  `localhost`, then a deployed test-mode smoke.
- **Never test against live keys.** Gate live keys behind a deliberate cutover.

---

## Decisions needed from AB before build

1. **Hobby + consolidate, or upgrade to Vercel Pro?** (Recommend Pro once money
   is real — removes the function-count squeeze.)
2. **Tap-to-Pay:** confirm card-on-file is the default and the Stripe Dashboard
   app covers in-person (Option A), i.e. we do NOT build a native app now.
3. **Charge timing:** charge on operator **Done** (recommended — matches "card
   isn't charged until your bin is clean"), or at booking? 
4. **Receipts:** Stripe's auto-receipt, or our own done-email line, or both?
5. Hand over the **Stripe test keys** to start in test mode.

---

## Sequencing recommendation

**Do a real soft-launch first (manual e-transfer/cash for the first ~5–10
cleans), THEN build Phase 6.** Validating that people actually pay costs nothing
and de-risks a meaningful build. Phase 6a (card on file) is the natural first
increment once you're ready to automate.

---

## Out of scope (explicit follow-ups)
- Native iOS app + Stripe Terminal SDK for in-app Tap-to-Pay (Option C).
- Stripe Subscriptions objects (we bill per-visit instead — keeps skip/discount/
  seasonal logic in our control).
- ACH / bank-debit, Apple Pay / Google Pay on the web booking form (nice-to-have).
- Dunning/retry automation for failed cards (start manual in `/ops`).
