# Referral Program — Design

**Date:** 2026-07-31
**Goal:** Let a happy customer refer a neighbour with a code they can say out
loud or share as a link. The friend gets $5 off their first clean; the referrer
earns $5 credit once that friend's first clean is actually completed and paid.

## Why

AB's framing, after a run of successful cleans: a tip prompt in the done email
would follow the Uber-Eats pattern, but a referral "goes further and helps a
business grow." The referral half is the one that compounds, so it ships first
and the tip is deliberately deferred (see Out of scope).

There is a strategic caveat worth stating plainly, because it shapes
expectations rather than the build: **every real customer today is a one-off**
(Sherri, Richelle, James — zero active subscriptions). "$5 off your next clean"
is only worth something to somebody who books another clean, so for the current
base the *friend's* $5 carries most of the conversion weight while the
*referrer's* $5 functions as a retention nudge. That is acceptable — an unused
balance is a standing reason to rebook — but uptake on the referrer side may be
slow until there are recurring customers.

## Decisions (AB, 2026-07-31)

| Decision | Value |
|---|---|
| Reward | **$5 each side** ($500 cents) |
| Referrer payout trigger | Friend's first clean **completed AND paid** — never at booking |
| Stacking | Credit **stacks**, **never expires** |
| Delivery | **Both** a share link and a typed code |
| Application | Referrer credit applies **automatically** at Done, not operator-entered |

Rewarding at booking was rejected: booking is free and nothing is charged until
the bin is clean, so paying out on signup would pay for fake accounts that never
convert.

## Staging

The charge path in this repo is deliberately hardened (atomic Done-claim,
`pending` payment row written before the Stripe call, a "needs attention" queue
for declines). Referral credit must not be bolted onto it in one pass.

**Stage 1 — codes, attribution, and the ask.** Generate codes, capture
`referred_by` at booking, seed the friend's $5 onto their balance, and surface
the ask in the done email and on `/manage`. Nothing in this stage changes how any
customer is charged — it only records intent.

**Stage 2 — spending credit.** Auto-apply an accumulated balance at Done across
all four settlement methods. This covers **both** the friend's seeded $5 and the
referrer's earned $5, because both are just balance.

Note what this split means: **no money actually moves until Stage 2.** Stage 1
banks balances and collects attribution; Stage 2 is what lets anyone spend it.
The two are therefore only safely separable if Stage 2 follows within days — a
customer promised "$5 off your first clean" who gets charged full price has been
lied to by the product. Either ship them together, or have Shea apply $5 by hand
via the existing `/ops` discount box for any referred customer serviced in the
gap. The staging exists to keep the risky charge-path change isolated and
reviewable, not to defer it indefinitely.

## Data model — migration 0011

Four columns on `customer`. No new table: at this volume, columns plus the
`referral_awarded_at` idempotency stamp carry the whole feature, and a join
table would be ceremony without a consumer.

| Column | Type | Notes |
|---|---|---|
| `referral_code` | `text` UNIQUE | 6 chars, unambiguous alphabet. Generated for every customer at booking. |
| `credit_cents` | `integer NOT NULL DEFAULT 0` | Stacking balance. Never expires. CHECK `>= 0`. |
| `referred_by` | `uuid REFERENCES customer(id)` | Set once at booking when a valid code is used. Nullable. |
| `referral_awarded_at` | `timestamptz` | Null until the referrer has been paid out for this customer. |

`referral_awarded_at` is the idempotency guard: a redelivered Stripe webhook or a
double-tapped Done must never pay a referrer twice.

**Backfill:** existing customers have no code. Generate codes for all existing
rows in the migration so `/manage` is never blank for them.

### Code format

Six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `0`/`O`, no `1`/`I`/`L`.
Uppercase, e.g. `K7M2QX`. Short enough to say over a fence, unambiguous enough to
retype correctly. Generate-and-retry on unique-violation.

Codes are **not** derived from the customer's name: that leaks one customer's
identity to another and collides badly.

## Flow — the friend

Two entry paths, both required. The share link covers "I texted my neighbour";
the typed code covers "I told my neighbour over the fence," which is the actual
use case AB described and which produces no link click.

1. **Link:** `https://www.luckyshamrock.ca/?ref=K7M2QX`. The booking widget reads
   `ref` from the URL, validates it, and prefills.
2. **Typed:** an optional "Referral code" field at the Your Info step.

Either way the friend sees confirmation *before* committing — "$5 off, courtesy
of Richelle" (referrer's **first name only**) — so the discount is not a surprise
at the end.

### Validating the code without a 13th function

The project is at **12/12 Vercel Hobby functions**; any new file fails the build.
Code validation folds into `/api/book` as a new intent, exactly as
`{intent:'payment_setup'}` was folded in:

```
POST /api/book { intent: 'check_referral', code: 'K7M2QX' }
  → 200 { status:'ok', valid:true, referrer_first_name:'Richelle' }
  → 200 { status:'ok', valid:false }
```

Always 200 with a `valid` boolean — never 404 on an unknown code. A 404 would
turn this endpoint into an oracle for enumerating valid codes, and the repo's
existing customer-enumeration-safety rule (`/api/magic-link/send` always returns
200) applies here for the same reason.

Returning only the referrer's **first name** is deliberate: enough to make the
discount feel real, not enough to leak a full identity or email to a stranger who
guessed a code.

### Applying the friend's $5

The friend's discount lands at their **first clean**, not at booking — booking
charges nothing, so there is nothing to discount yet.

Implementation: seed the friend's own `credit_cents` with $5 at booking. The
friend's discount and the referrer's reward then flow through **one** mechanism
(Stage 2's credit application) rather than two parallel ones. `referral_awarded_at`
is reserved solely for "has the referrer been paid for this friend," and is not
overloaded to also mean "has the friend used their discount" — that balance is
tracked by `credit_cents` like any other.

## Flow — the referrer

Nothing is earned until the referred friend's first visit reaches `done` **and**
its payment settles (`charged`, `paid_cash`, `paid_terminal`, or a `qr` payment
confirmed by `checkout.session.completed`). A `comped` clean does **not** trigger
a payout — no money changed hands.

On that event, inside the same transaction that settles the visit:

1. `UPDATE customer SET credit_cents = credit_cents + 500 WHERE id = <referrer>`
2. `UPDATE customer SET referral_awarded_at = now() WHERE id = <friend> AND referral_awarded_at IS NULL` — guarded so a double-tap awards once.

Then, best-effort and outside the transaction, email the referrer: "your
neighbour's bin is clean — here's $5 off your next one." New notification kind
`referral_earned`, idempotent on `(visit_id, kind)` like every other send.

### Where the referrer sees their code

- **`/manage`** — permanent home. Code, share link, current balance, and a count
  of successful referrals.
- **Done email** — the ask goes **below the existing star-rating row**, not above
  it. The star row routes 4–5★ straight to the Google review page and is
  currently the single best growth lever in that email; the referral block must
  not displace it. Keep it to one line plus the code and link.

## Credit application at Done (Stage 2)

The delicate half. Credit must work on **all four settlement paths** — card on
file, cash, tap-in-Stripe, QR — not just the card one, or a customer who pays
cash silently loses their balance.

Ordering in `handleDone`, after `effectiveBaseCents` is resolved:

1. Operator discount applies first (existing `discountCents`, already clamped).
2. Credit applies on top: `applied = min(customer.credit_cents, remaining)`.
3. Charge `remaining - applied`. Decrement the balance by `applied` **only**.
4. Balance never goes negative; leftover credit stays on the account.

If credit covers the clean entirely the visit is `comped` and no Stripe call is
made — matching the existing full-discount branch.

**Guards built in without further asking:**

- **Self-referral blocked.** A customer cannot use their own code.
- **Credit is decremented in the same atomic step that claims the visit**, so two
  concurrent Done taps cannot spend the same $5 twice — the same race the
  existing atomic Done-claim already defends against.
- **The PDF receipt shows credit as its own line item**, so the arithmetic on the
  receipt still adds up to the total paid.
- **`/ops` shows "$10 credit applies" on the stop card** before Shea taps Done,
  so a smaller-than-expected charge is never a surprise.

### Known edge cases

- **Refund after credit was applied.** A refunded clean does not automatically
  restore spent credit. Documented as accepted behaviour for v1; revisit if it
  ever happens.
- **Referrer deleted / email changed.** `referred_by` is a real FK with the same
  `restrict` posture as the rest of the schema; deleting a customer who referred
  someone requires clearing the link first.
- **Walk-up jobs** use placeholder emails and get no referral email. Credit still
  applies if a real customer somehow has a balance.

## Testing

Follows the repo's existing split — integration tests against `neondb_test`,
unit tests with a mocked DB.

- Code generation: uniqueness, alphabet excludes ambiguous characters, retry on
  collision.
- `check_referral` intent: valid code, unknown code (200 `valid:false`, not 404),
  own code rejected.
- Award fires exactly once on a paid Done; does **not** fire on `comped`; does
  **not** fire twice on a double-tapped Done.
- Credit application across all four settlement methods.
- Credit + operator discount together; credit exceeding price → `comped` with
  leftover retained.
- Balance never negative.

## Out of scope (deliberately)

- **The tip option.** A second money path. AB's own instinct was that referrals
  matter more; ship this, see whether it lands, and add tips later — most likely
  as a Stripe Checkout link riding the `checkout.session.completed` webhook that
  already exists, so it needs no new function.
- **Expiry or caps on credit.** Explicitly rejected — credit stacks and never
  expires.
- **Referral leaderboards, tiers, or multi-level rewards.** YAGNI.
- **The `/ops` order-history tab.** Separate, smaller, independent feature; ship
  it first (roughly a day, read-only, no money path) before this multi-day build.

## Success criteria

1. A customer can find their code on `/manage` and share it as a link or say it aloud.
2. A friend using either path sees "$5 off, courtesy of <first name>" before committing.
3. The friend's first clean is $5 cheaper.
4. The referrer's balance increases by $5 only after that clean is completed and paid.
5. The referrer's balance is spent automatically at their next clean, on any settlement method.
6. No path pays a referrer twice.
