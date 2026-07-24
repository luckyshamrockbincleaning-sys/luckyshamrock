# Doorstep Payments & Walk-Up Jobs — Design

**Date:** 2026-07-24
**Goal:** Let the operator (a) create a job on the spot for someone who flags him
down, and (b) take payment at the door by QR, tap-in-Stripe-app, or cash — not
just the saved card.

## Why

Today `/ops` can only charge a card on file, and every payment must attach to a
pre-booked visit. That misses two real situations: the neighbour who sees the
truck and wants a clean now, and the customer who wants to pay cash or by phone
at the door.

**Hard constraint discovered:** Stripe **Tap to Pay is native-SDK only** (iOS,
Android, React Native — confirmed in Stripe docs 2026-07-24). It is not in
Stripe.js, and mobile browsers cannot access payment NFC. A true tap button
inside the `/ops` web page is impossible without shipping a native app, which is
out of proportion here. QR + a deep link into Stripe's own app covers the same
ground with no hardware.

## Part 1 — Walk-up jobs

New **"+ New job here"** button at the top of the `/ops` Today view.

- **Form (roadside-fast):** street address, bin count (1–3), email *(optional)*,
  name *(optional)*, postal code. City defaults to Fort Saskatchewan.
- **No service-area gate.** The operator is physically there; the T8L check is a
  self-serve-booking guard and does not apply.
- **Creates:** a `customer` row + a one-off `visit` (no subscription), scheduled
  today, status `scheduled` so it appears immediately in Today and is actionable.
- **No email given:** store a placeholder `walkup+<visit-short-id>@luckyshamrock.ca`
  so the not-null/unique constraints hold, and skip all customer emails for that
  visit (receipt, rating). Cash sale still records revenue.
  *Implementation note: confirm `customer.email` uniqueness/not-null and
  `postal_code` not-null before finalizing the placeholder shape.*
- **Existing email:** reuse the existing customer record rather than creating a
  duplicate (match on normalized email), so walk-ups merge with any history.
- **Upside:** a walk-up becomes a real customer — receipt, wash GIF, star-rating
  funnel, and a future plan upsell all work unchanged.

## Part 2 — Payment methods at Done

`POST /api/operator/act {op:'done'}` gains `payment_method`:

| Method | Behaviour | Resulting `visit.payment_status` |
|---|---|---|
| `card_on_file` (default) | Existing off-session charge. Unchanged. | `charged` / `failed` / `comped` |
| `cash` | Records the amount as collected; no Stripe call. | `paid_cash` |
| `terminal` | Operator collected via the Stripe app (tap). Records amount. | `paid_terminal` |
| `qr` | Creates a Stripe Checkout Session; `/ops` renders its URL as a QR code for the customer to scan. Visit completes immediately; payment confirms asynchronously. | `awaiting_payment` → `charged` on webhook |

- **Amount:** pre-filled from `baseChargeCents(cadence, bins)` (one-off = $45
  first bin + $12 each extra), **editable** by the operator, then the existing
  discount logic applies. Server clamps to ≥ 0 and re-derives the default; a
  client-sent amount is only honoured within a sane band (never trusted blindly).
- **A payment never blocks Done.** Same rule as today: the clean completes, the
  money state is recorded alongside it.
- **Receipt:** the existing PDF receipt is attached for `cash`, `terminal`, and
  (on webhook confirmation) `qr`, with the payment method named on it. Extend
  `ReceiptInput.outcome` with `cash` and `terminal`.

### QR flow detail

1. Ops sends `{op:'done', payment_method:'qr'}`.
2. Server creates a **Stripe Checkout Session** (`mode: 'payment'`, dynamic
   `price_data` for the exact amount, `metadata.visit_id`) and returns
   `session.url`.
3. `/ops` renders that URL as a **QR code** (client-side QR lib from unpkg with
   SRI, same pattern as React/Stripe.js) plus a tappable link fallback.
4. Customer scans → Stripe-hosted checkout (Apple Pay / Google Pay / card) → pays.
5. `checkout.session.completed` webhook → `lib/billing-webhook.ts` marks the
   `payment` row succeeded and the visit `charged`, then sends the receipt.
6. **Zero new serverless functions** — Stripe hosts the payment page, and the
   existing `/api/stripe/webhook` handles confirmation. (We are at 12/12.)

**⚠️ Launch step:** `checkout.session.completed` must be added to the live Stripe
webhook's event list, or QR payments will never confirm. Same class of gotcha as
`charge.refunded`. Document in `.env.example` + repo CLAUDE.md.

### Tap-in-Stripe-app flow detail

- Button shows the amount in large type and opens the Stripe Dashboard app
  (app scheme, falling back to the universal link / app store).
- Stripe publishes no way to pre-fill an amount, so the operator types it there.
  That payment is **not** auto-linked to the visit; ops records
  `paid_terminal` with the amount and reconciliation happens in Stripe by
  amount/time. Accepted trade-off, documented in the UI copy ("record it here
  after collecting").

## Part 3 — Data model

Migration `0009`, additive only:

- `payment_status` enum gains `paid_cash`, `paid_terminal`, `awaiting_payment`.
- `payment.method` column (`card` | `cash` | `terminal` | `qr`), default `card`,
  so revenue can be split by channel later.
- No changes to `visit`/`customer` shape beyond existing columns.

## Part 4 — Routing (function cap)

Both features ride existing files, adding **no** serverless functions:

- Walk-up creation → new `job` action in `api/operator/[action].ts`'s dispatcher
  (same file, `handleNewJob` in `lib/operator-handlers.ts`).
- Payment methods → extra fields on the existing `act`/`done` op.
- QR confirmation → existing `api/stripe/webhook.ts`.

## Testing

- Walk-up: creates customer+visit; reuses existing customer on email match;
  placeholder email path sends no customer email; appears in Today.
- Payments: each method sets the right `payment_status` and `payment.method`;
  amount override respected and clamped; Done still succeeds when Stripe is
  unconfigured (graceful-degradation rule).
- QR: session created with correct amount + `visit_id` metadata (Stripe mocked);
  `checkout.session.completed` webhook marks paid, is idempotent on redelivery,
  and no-ops for an unknown visit.
- Receipt renders for cash/terminal outcomes.

## Out of scope

- Native app / true in-browser Tap to Pay (platform-impossible; see above).
- Partial payments, tips, split payments.
- Automatic matching of Stripe-app terminal payments to visits.
- Walk-up customers choosing a recurring plan on the spot (they can self-serve
  later from the receipt email).
