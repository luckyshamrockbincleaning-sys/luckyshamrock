# Doorstep Payments & Walk-Up Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator create a job on the spot for a walk-up customer, and take payment at the door by QR code, Stripe-app tap, or cash — not just the card on file.

**Architecture:** Both features ride existing files and add **zero** serverless functions (the project is at Vercel Hobby's 12/12 cap). Walk-up creation becomes a new `job` action inside the existing `api/operator/[action].ts` dispatcher; payment methods become extra fields on the existing `done` op; QR payments use a Stripe-hosted Checkout Session confirmed by the existing `api/stripe/webhook.ts`.

**Tech Stack:** TypeScript on Vercel Node 20, Drizzle + Neon Postgres, Stripe SDK 22 (`apiVersion` pinned in `lib/stripe.ts`), `qrcode` (server-side SVG), vitest, React via Babel-standalone (no build step) for `/ops`.

## Global Constraints

- **Never add a serverless function.** `api/` currently holds exactly 12 `.ts` files and Vercel Hobby fails the build at 13. New endpoints go into `api/operator/[action].ts`'s `ONE_SEG` map or into the `act` op body.
- **Multi-segment dynamic routes 404 in this project's Vercel runtime.** Single dynamic segment only; put the rest in the body.
- **Stripe degrades gracefully.** `lib/stripe.ts`/`lib/billing.ts` return null / `{ok:false}` and never throw when keys are absent; booking and Done must work with Stripe unconfigured.
- **A payment problem never blocks Done.** The clean completes; money state is recorded alongside.
- **Prices are server-side only** (`lib/pricing.ts`, cents). Never trust a client-sent amount blindly.
- **Customer-facing 500s stay generic.** Log the real error server-side; return `{status:'error', message:'Something went wrong…'}`.
- **Tests:** `npm test` runs against `neondb_test`; integration tests call `truncateAllForTests()` in `beforeEach`. Run `npm run typecheck` before every commit.
- **Existing enum values are never renamed or removed** — migrations are additive.
- **No new third-party CDN scripts.** Every existing `<script>` in this project
  carries an SRI hash; rather than add another supply-chain dependency, the QR
  code is rendered to SVG **server-side** with the `qrcode` npm package.

---

### Task 1: Migration — payment method + new payment states

**Files:**
- Modify: `db/schema.ts` (`paymentStatusEnum`, `payment` table)
- Create: `db/migrations/0009_*.sql` (generated)
- Test: `lib/_tests/payment-method.test.ts`

**Interfaces:**
- Produces: `paymentStatusEnum` values `'paid_cash' | 'paid_terminal' | 'awaiting_payment'`; `payment.method` column typed by `paymentMethodEnum` with values `'card' | 'cash' | 'terminal' | 'qr'`.

- [ ] **Step 1: Write the failing test**

Create `lib/_tests/payment-method.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/client.js';
import { customer, visit, payment } from '../../db/schema.js';
import { truncateAllForTests } from '../../api/_tests/_db_cleanup.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});
beforeEach(async () => {
  await truncateAllForTests();
});

describe('payment method + doorstep payment states', () => {
  it('stores a cash payment with method=cash and visit paid_cash', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId,
      email: `cash-${customerId.slice(0, 8)}@e.com`,
      name: 'Cash Customer',
      street: '1 Rd',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L1A1',
      pickupDay: 'wednesday',
    });
    const visitId = crypto.randomUUID();
    await db.insert(visit).values({
      id: visitId,
      customerId,
      subscriptionId: null,
      scheduledFor: new Date('2026-07-24T12:00:00Z'),
      status: 'done',
      paymentStatus: 'paid_cash',
    });
    const paymentId = crypto.randomUUID();
    await db.insert(payment).values({
      id: paymentId,
      customerId,
      visitId,
      amountCents: 4500,
      status: 'succeeded',
      method: 'cash',
    });

    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    expect(v!.paymentStatus).toBe('paid_cash');
    expect(p!.method).toBe('cash');
  });

  it('defaults method to card for existing-style rows', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId,
      email: `card-${customerId.slice(0, 8)}@e.com`,
      name: 'Card Customer',
      street: '1 Rd',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L1A1',
      pickupDay: 'wednesday',
    });
    const paymentId = crypto.randomUUID();
    await db.insert(payment).values({
      id: paymentId,
      customerId,
      visitId: null,
      amountCents: 3500,
      status: 'pending',
    });
    const [p] = await getDb().select().from(payment).where(eq(payment.id, paymentId));
    expect(p!.method).toBe('card');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/payment-method.test.ts`
Expected: FAIL — `method` is not a known column / invalid input value for enum `payment_status: "paid_cash"`.

- [ ] **Step 3: Add the enum values and column to the schema**

In `db/schema.ts`, extend `paymentStatusEnum` (append only — never reorder):

```typescript
export const paymentStatusEnum = pgEnum('payment_status', [
  'unpaid', // not yet charged
  'charged', // successfully charged
  'comped', // intentionally not charged (full discount / freebie)
  'failed', // charge attempted and declined — needs retry / another method
  'refunded', // charge was refunded (e.g. from the Stripe dashboard)
  'paid_cash', // collected in cash at the door
  'paid_terminal', // collected via tap in the Stripe app; reconciled in Stripe
  'awaiting_payment', // QR issued, waiting for checkout.session.completed
]);

// How the money arrived. Lets revenue be split by channel later.
export const paymentMethodEnum = pgEnum('payment_method', ['card', 'cash', 'terminal', 'qr']);
```

Add to the `payment` table definition, immediately after `status`:

```typescript
    method: paymentMethodEnum('method').notNull().default('card'),
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate
DBURL=$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')
TESTURL=$(grep '^TEST_DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')
for U in "$DBURL" "$TESTURL"; do
  psql "$U" -c "ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'paid_cash';"
  psql "$U" -c "ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'paid_terminal';"
  psql "$U" -c "ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'awaiting_payment';"
  psql "$U" -c "DO \$\$ BEGIN CREATE TYPE payment_method AS ENUM ('card','cash','terminal','qr'); EXCEPTION WHEN duplicate_object THEN null; END \$\$;"
  psql "$U" -c "ALTER TABLE payment ADD COLUMN IF NOT EXISTS method payment_method NOT NULL DEFAULT 'card';"
done
```

Expected: each statement prints `ALTER TYPE` / `ALTER TABLE` / `DO`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/payment-method.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add db/schema.ts db/migrations lib/_tests/payment-method.test.ts
git commit -m "Add payment method + doorstep payment states (migration 0009)"
```

---

### Task 2: Receipt PDF supports cash and terminal outcomes

**Files:**
- Modify: `lib/receipt-pdf.ts` (`ReceiptInput.outcome`, the paid-by line)
- Test: `lib/_tests/receipt-pdf.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ReceiptInput.outcome: 'charged' | 'comped' | 'cash' | 'terminal'` — Task 3 and Task 5 pass these values.

- [ ] **Step 1: Write the failing test**

Append to `lib/_tests/receipt-pdf.test.ts`:

```typescript
  it('renders a cash receipt', async () => {
    const pdf = await generateReceiptPdf({
      receiptNumber: 'LS-CASH01',
      serviceDate: 'Fri, Jul 24, 2026',
      paidDate: 'Fri, Jul 24, 2026',
      customerName: 'Walk Up',
      address: '9 Curb Lane, Fort Saskatchewan T8L 0A1',
      planLabel: 'One-Time Clean',
      binCount: 1,
      baseCents: 4500,
      discountCents: 0,
      totalCents: 4500,
      outcome: 'cash',
    });
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a terminal (tap) receipt', async () => {
    const pdf = await generateReceiptPdf({
      receiptNumber: 'LS-TAP001',
      serviceDate: 'Fri, Jul 24, 2026',
      paidDate: 'Fri, Jul 24, 2026',
      customerName: 'Walk Up',
      address: '9 Curb Lane, Fort Saskatchewan T8L 0A1',
      planLabel: 'One-Time Clean',
      binCount: 2,
      baseCents: 5700,
      discountCents: 0,
      totalCents: 5700,
      outcome: 'terminal',
    });
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/receipt-pdf.test.ts`
Expected: FAIL — TypeScript rejects `outcome: 'cash'` (not assignable).

- [ ] **Step 3: Widen the type and the paid-by line**

In `lib/receipt-pdf.ts`, change the `outcome` field of `ReceiptInput`:

```typescript
  /** How this clean was settled — drives the line under the total. */
  outcome: 'charged' | 'comped' | 'cash' | 'terminal';
```

Replace the paid-by `page.drawText(...)` call near the end of `generateReceiptPdf`:

```typescript
  const paidByLine =
    r.outcome === 'comped'
      ? 'This clean was on us — no charge.'
      : r.outcome === 'cash'
        ? 'Paid in cash — thank you!'
        : r.outcome === 'terminal'
          ? 'Paid by card in person.'
          : 'Paid by card on file.';
  page.drawText(paidByLine, { x: left, y, size: 9, font: helv, color: MUTED });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/receipt-pdf.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add lib/receipt-pdf.ts lib/_tests/receipt-pdf.test.ts
git commit -m "Receipt PDF: cash and in-person card outcomes"
```

---

### Task 3: Cash and terminal payment at Done (server)

**Files:**
- Modify: `lib/operator-handlers.ts` (`actSchema`, `handleDone`)
- Test: `api/_tests/operator-done.test.ts`

**Interfaces:**
- Consumes: `paymentMethodEnum` values (Task 1); `ReceiptInput.outcome` (Task 2); existing `baseChargeCents(cadence, binCount)` and `finalChargeCents(base, discountCents)` from `lib/pricing.ts`.
- Produces: `done` op accepts `payment_method: 'card_on_file' | 'cash' | 'terminal' | 'qr'` (default `card_on_file`) and `amount_cents?: number`. Task 4 adds the `qr` branch; Task 7 sends these fields.

- [ ] **Step 1: Write the failing test**

Append to `api/_tests/operator-done.test.ts` (inside the main `describe`):

```typescript
  it('records a cash payment without calling Stripe', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('paid_cash');
    const rows = await db.select().from(payment).where(eq(payment.visitId, v1));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe('cash');
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[0]!.amountCents).toBe(4500); // one-off, 1 bin
  });

  it('honours an operator amount override on cash', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash', amount_cents: 4000 }), res);

    expect(res.statusCode).toBe(200);
    const rows = await getDb().select().from(payment).where(eq(payment.visitId, v1));
    expect(rows[0]!.amountCents).toBe(4000);
  });

  it('records a terminal (tap in Stripe app) payment', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'terminal' }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.paymentStatus).toBe('paid_terminal');
    const rows = await db.select().from(payment).where(eq(payment.visitId, v1));
    expect(rows[0]!.method).toBe('terminal');
  });

  it('rejects a negative amount override', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash', amount_cents: -100 }), res);

    expect(res.statusCode).toBe(400);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('scheduled');
  });
```

Add `payment` to the schema import at the top of that file if absent:

```typescript
import { customer, visit, notificationLog, payment } from '../../db/schema.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run api/_tests/operator-done.test.ts`
Expected: FAIL — `paymentStatus` is `unpaid`, no `payment` row.

- [ ] **Step 3: Parse and validate the new fields**

In `lib/operator-handlers.ts`, add near the other zod schemas:

```typescript
const donePaymentSchema = z.object({
  payment_method: z.enum(['card_on_file', 'cash', 'terminal', 'qr']).default('card_on_file'),
  // Operator override for doorstep deals ("$40 cash"). Server still floors it
  // at 0 and ignores absurd values; the default comes from lib/pricing.ts.
  amount_cents: z.number().int().min(0).max(100_000).optional(),
});
```

In `handleDone`, immediately after the existing `discountCents` parsing, insert:

```typescript
  const paymentParsed = donePaymentSchema.safeParse({
    payment_method: req.body?.payment_method,
    amount_cents: req.body?.amount_cents,
  });
  if (!paymentParsed.success) {
    res.status(400).json({ status: 'invalid', message: 'payment_method or amount_cents is invalid' });
    return;
  }
  const paymentMethod = paymentParsed.data.payment_method;
```

- [ ] **Step 4: Branch the money logic**

In `handleDone`, replace the line that opens the billing branch:

```typescript
    if (!alreadyBilled && isStripeConfigured() && row.stripeCustomerId && row.defaultPaymentMethodId) {
```

with a doorstep branch first, then the existing card path (note `baseCents` is
already hoisted above this point by earlier work):

```typescript
    // Doorstep settlement: the operator collected in person. No Stripe call —
    // the money is already in hand (cash) or captured in the Stripe app
    // (terminal, reconciled there by amount/time).
    if (!alreadyBilled && (paymentMethod === 'cash' || paymentMethod === 'terminal')) {
      const amount = finalChargeCents(
        paymentParsed.data.amount_cents ?? baseCents,
        discountCents,
      );
      const status = paymentMethod === 'cash' ? 'paid_cash' : 'paid_terminal';
      await db.update(visit).set({ paymentStatus: status }).where(eq(visit.id, visitId));
      await db.insert(payment).values({
        id: crypto.randomUUID(),
        customerId: row.customerId,
        visitId,
        amountCents: amount,
        discountCents,
        status: 'succeeded',
        method: paymentMethod,
      });
      charge = { attempted: true, ok: true, amount_cents: amount };
    } else if (!alreadyBilled && paymentMethod === 'card_on_file' && isStripeConfigured() && row.stripeCustomerId && row.defaultPaymentMethodId) {
```

- [ ] **Step 5: Pass the right receipt outcome**

In the receipt block of `handleDone`, replace the `outcome` line:

```typescript
          outcome:
            paymentMethod === 'cash'
              ? 'cash'
              : paymentMethod === 'terminal'
                ? 'terminal'
                : (charge.amount_cents ?? 0) === 0
                  ? 'comped'
                  : 'charged',
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx dotenv -e .env.local -- vitest run api/_tests/operator-done.test.ts`
Expected: PASS (all existing tests plus the 4 new ones).

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add lib/operator-handlers.ts api/_tests/operator-done.test.ts
git commit -m "Done: accept cash and in-person card payments"
```

---

### Task 4: QR payment — create the Stripe Checkout Session

**Files:**
- Modify: `lib/billing.ts` (new `createDoorstepCheckoutSession`)
- Modify: `lib/operator-handlers.ts` (`qr` branch in `handleDone`)
- Test: `lib/_tests/billing-doorstep.test.ts`, `api/_tests/operator-done.test.ts`

**Interfaces:**
- Consumes: `paymentMethod === 'qr'` (Task 3).
- Produces: `createDoorstepCheckoutSession({visitId, amountCents, description}): Promise<{url: string, sessionId: string} | null>`; `handleDone` returns `payment_url` **and** `payment_qr_svg` (an inline SVG string) in its JSON when the method is `qr`. Task 5 consumes `metadata.visit_id`; Task 7 renders both.

- [ ] **Step 1: Write the failing test**

Create `lib/_tests/billing-doorstep.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createSession = vi.fn();
vi.mock('../stripe.js', () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({ checkout: { sessions: { create: createSession } } }),
}));

import { createDoorstepCheckoutSession } from '../billing.js';

beforeEach(() => {
  createSession.mockReset();
  process.env.SITE_URL = 'https://www.luckyshamrock.ca';
});
afterEach(() => {
  delete process.env.SITE_URL;
});

describe('createDoorstepCheckoutSession', () => {
  it('creates a CAD session for the exact amount and tags the visit', async () => {
    createSession.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const result = await createDoorstepCheckoutSession({
      visitId: 'visit-123',
      amountCents: 5700,
      description: 'Garbage bin cleaning — 2 bins',
    });

    expect(result).toEqual({ sessionId: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const arg = createSession.mock.calls[0]![0];
    expect(arg.mode).toBe('payment');
    expect(arg.metadata.visit_id).toBe('visit-123');
    expect(arg.line_items[0].price_data.currency).toBe('cad');
    expect(arg.line_items[0].price_data.unit_amount).toBe(5700);
  });

  it('returns null when Stripe throws instead of propagating', async () => {
    createSession.mockRejectedValue(new Error('stripe down'));
    const result = await createDoorstepCheckoutSession({
      visitId: 'visit-123',
      amountCents: 4500,
      description: 'Garbage bin cleaning',
    });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/billing-doorstep.test.ts`
Expected: FAIL — `createDoorstepCheckoutSession is not a function`.

- [ ] **Step 3: Implement the session helper**

Append to `lib/billing.ts`:

```typescript
export interface DoorstepCheckoutInput {
  visitId: string;
  amountCents: number;
  description: string;
}

export interface DoorstepCheckoutResult {
  url: string;
  sessionId: string;
}

/**
 * Stripe-hosted checkout for a doorstep QR payment. The customer scans the QR
 * on the operator's phone and pays on Stripe's page (Apple Pay / Google Pay /
 * card), so we host no payment UI and add no serverless function. Confirmation
 * arrives as `checkout.session.completed` on the existing webhook.
 *
 * Returns null (never throws) when Stripe is unconfigured or the call fails —
 * the caller falls back to another payment method and Done still completes.
 */
export async function createDoorstepCheckoutSession(
  input: DoorstepCheckoutInput,
): Promise<DoorstepCheckoutResult | null> {
  if (!isStripeConfigured()) return null;
  const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'cad',
            unit_amount: input.amountCents,
            product_data: { name: input.description },
          },
        },
      ],
      metadata: { visit_id: input.visitId },
      payment_intent_data: { metadata: { visit_id: input.visitId } },
      success_url: `${siteUrl}/paid.html`,
      cancel_url: `${siteUrl}/`,
    });
    if (!session.url) return null;
    return { url: session.url, sessionId: session.id };
  } catch (err) {
    console.error('[billing] doorstep checkout session failed', err);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/billing-doorstep.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing handler test**

Append to `api/_tests/operator-done.test.ts`:

```typescript
  it('marks a QR payment awaiting_payment and returns no url when Stripe is unconfigured', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'qr' }), res);

    expect(res.statusCode).toBe(200);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
    // Stripe is unconfigured in tests: the clean still completes.
    expect(['awaiting_payment', 'unpaid']).toContain(v!.paymentStatus);
  });
```

- [ ] **Step 6: Wire the qr branch into handleDone**

In `lib/operator-handlers.ts`, import the helper:

```typescript
import { chargeOffSession, createDoorstepCheckoutSession } from './billing.js';
```

Add these declarations next to the `charge` declaration:

```typescript
    let paymentUrl: string | null = null;
    let paymentQrSvg: string | null = null;
```

and import the QR renderer at the top of the file:

```typescript
import QRCode from 'qrcode';
```

Add this branch immediately before the `cash`/`terminal` branch from Task 3:

```typescript
    // QR: Stripe hosts the payment page; we only hand the customer a link.
    // The visit completes now and the money confirms asynchronously via the
    // checkout.session.completed webhook.
    if (!alreadyBilled && paymentMethod === 'qr') {
      const amount = finalChargeCents(
        paymentParsed.data.amount_cents ?? baseCents,
        discountCents,
      );
      const session = await createDoorstepCheckoutSession({
        visitId,
        amountCents: amount,
        description: `Garbage bin cleaning — ${binCount} bin${binCount > 1 ? 's' : ''}`,
      });
      if (session) {
        paymentUrl = session.url;
        // Rendered server-side so /ops needs no QR library (and no extra CDN
        // script). ~2 KB of SVG, injected straight into the page.
        try {
          paymentQrSvg = await QRCode.toString(session.url, { type: 'svg', margin: 1, width: 240 });
        } catch (err) {
          console.error('[operator/visit/done] qr render failed (link still returned)', err);
        }
        await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));
        await db.insert(payment).values({
          id: crypto.randomUUID(),
          customerId: row.customerId,
          visitId,
          amountCents: amount,
          discountCents,
          status: 'pending',
          method: 'qr',
        });
        charge = { attempted: true, ok: true, amount_cents: amount };
      }
    } else if (!alreadyBilled && (paymentMethod === 'cash' || paymentMethod === 'terminal')) {
```

In the final `res.status(200).json({...})` of `handleDone`, add both fields:

```typescript
      payment_url: paymentUrl,
      payment_qr_svg: paymentQrSvg,
```

- [ ] **Step 7: Skip the receipt for unconfirmed QR payments**

The receipt must not claim payment before the webhook confirms. Change the receipt guard in `handleDone`:

```typescript
    if (charge.attempted && charge.ok && paymentMethod !== 'qr') {
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx dotenv -e .env.local -- vitest run api/_tests/operator-done.test.ts lib/_tests/billing-doorstep.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm run typecheck
npm i qrcode && npm i -D @types/qrcode
git add lib/billing.ts lib/operator-handlers.ts lib/_tests/billing-doorstep.test.ts api/_tests/operator-done.test.ts package.json package-lock.json
git commit -m "QR payments: Stripe-hosted checkout session from the Done tap"
```

---

### Task 5: QR confirmation via webhook

**Files:**
- Modify: `lib/billing-webhook.ts` (new `checkout.session.completed` case)
- Modify: `.env.example` (webhook event list)
- Test: `lib/_tests/billing-webhook.test.ts`

**Interfaces:**
- Consumes: `metadata.visit_id` set in Task 4; `payment.method = 'qr'`.
- Produces: `applyStripeEvent` returns `'checkout.session.completed:applied' | 'checkout.session.completed:no_row' | 'checkout.session.completed:missing_id'`.

- [ ] **Step 1: Write the failing test**

Append to `lib/_tests/billing-webhook.test.ts`:

```typescript
  it('checkout.session.completed marks the QR payment and visit charged', async () => {
    const cid = await makeCustomer('cus_qr');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_qr_1');
    const db = getDb();
    await db.update(payment).set({ status: 'pending', method: 'qr' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));

    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_status: 'paid', metadata: { visit_id: visitId }, payment_intent: 'pi_qr_1' } },
    });

    expect(tag).toBe('checkout.session.completed:applied');
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(p!.status).toBe('succeeded');
    expect(v!.paymentStatus).toBe('charged');
  });

  it('checkout.session.completed for an unknown visit is a safe no-op', async () => {
    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', payment_status: 'paid', metadata: { visit_id: crypto.randomUUID() } } },
    });
    expect(tag).toBe('checkout.session.completed:no_row');
  });

  it('ignores an unpaid checkout session', async () => {
    const cid = await makeCustomer('cus_qr2');
    const { visitId } = await makeVisitWithPayment(cid, 'pi_qr_2');
    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', payment_status: 'unpaid', metadata: { visit_id: visitId } } },
    });
    expect(tag).toBe('checkout.session.completed:ignored_unpaid');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/billing-webhook.test.ts`
Expected: FAIL — tag is `'ignored'`.

- [ ] **Step 3: Implement the case**

In `lib/billing-webhook.ts`, add before `default:`:

```typescript
    // A doorstep QR payment completed on Stripe's hosted page. The session
    // carries our visit id in metadata (set in createDoorstepCheckoutSession).
    case 'checkout.session.completed': {
      const visitId = typeof obj.metadata?.visit_id === 'string' ? obj.metadata.visit_id : null;
      if (!visitId) return 'checkout.session.completed:missing_id';
      if (obj.payment_status !== 'paid') return 'checkout.session.completed:ignored_unpaid';

      const piId = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      const [p] = await db
        .update(payment)
        .set({
          status: 'succeeded',
          ...(piId ? { stripePaymentIntentId: piId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(payment.visitId, visitId))
        .returning();
      if (!p) return 'checkout.session.completed:no_row';

      await db.update(visit).set({ paymentStatus: 'charged' }).where(eq(visit.id, visitId));
      return 'checkout.session.completed:applied';
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx dotenv -e .env.local -- vitest run lib/_tests/billing-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Document the required Stripe event**

In `.env.example`, update the webhook events comment to list `checkout.session.completed` alongside the existing five events, with the note: *"QR doorstep payments never confirm without this event."*

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add lib/billing-webhook.ts lib/_tests/billing-webhook.test.ts .env.example
git commit -m "Webhook: confirm doorstep QR payments via checkout.session.completed"
```

---

### Task 6: Walk-up job creation (server)

**Files:**
- Modify: `lib/operator-handlers.ts` (new `handleNewJob`)
- Modify: `api/operator/[action].ts` (`ONE_SEG` map + route docs)
- Test: `api/_tests/operator-job.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `POST /api/operator/job` with body `{street, postal_code, bin_count, email?, name?}` → `201 {status:'ok', visit_id, customer_id}`. Task 8 calls this.

- [ ] **Step 1: Write the failing test**

Create `api/_tests/operator-job.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleNewJob as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});
beforeEach(async () => {
  await truncateAllForTests();
});

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return res;
}

async function req(authed: boolean, body: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method: 'POST', headers, query: {}, body };
}

const validJob = { street: '9 Curb Lane', postal_code: 'T8L 0A1', bin_count: 1, email: 'walkup@example.com', name: 'Curb Neighbour' };

describe('POST /api/operator/job (walk-up)', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req(false, validJob), res);
    expect(res.statusCode).toBe(401);
  });

  it('creates a customer and a one-off visit scheduled today', async () => {
    const res = mockRes();
    await handler(await req(true, validJob), res);

    expect(res.statusCode).toBe(201);
    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'walkup@example.com'));
    expect(c).toBeDefined();
    expect(c!.street).toBe('9 Curb Lane');
    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(1);
    expect(visits[0]!.subscriptionId).toBeNull();
    expect(visits[0]!.binCount).toBe(1);
    expect(visits[0]!.status).toBe('scheduled');
  });

  it('accepts an out-of-area postal code (operator is standing there)', async () => {
    const res = mockRes();
    await handler(await req(true, { ...validJob, email: 'oot@example.com', postal_code: 'T5J 0N3' }), res);
    expect(res.statusCode).toBe(201);
  });

  it('generates a placeholder email when none is given', async () => {
    const res = mockRes();
    await handler(await req(true, { street: '11 Curb Lane', postal_code: 'T8L 0A1', bin_count: 2 }), res);

    expect(res.statusCode).toBe(201);
    const rows = await getDb().select().from(customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toMatch(/^walkup\+[0-9a-f]{8}@luckyshamrock\.ca$/);
  });

  it('reuses an existing customer with the same email', async () => {
    const first = mockRes();
    await handler(await req(true, validJob), first);
    const second = mockRes();
    await handler(await req(true, { ...validJob, bin_count: 3 }), second);

    expect(second.statusCode).toBe(201);
    const customers = await getDb().select().from(customer).where(eq(customer.email, 'walkup@example.com'));
    expect(customers).toHaveLength(1);
    const visits = await getDb().select().from(visit).where(eq(visit.customerId, customers[0]!.id));
    expect(visits).toHaveLength(2);
  });

  it('rejects a missing street', async () => {
    const res = mockRes();
    await handler(await req(true, { postal_code: 'T8L 0A1', bin_count: 1 }), res);
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- vitest run api/_tests/operator-job.test.ts`
Expected: FAIL — `handleNewJob is not exported`.

- [ ] **Step 3: Implement handleNewJob**

Add to `lib/operator-handlers.ts` (import `normalizePostalCode` from `./postal.js` at the top):

```typescript
const newJobSchema = z.object({
  street: z.string().trim().min(1).max(200),
  postal_code: z.string().trim().min(1).max(10),
  bin_count: z.number().int().min(1).max(3).default(1),
  email: z.string().trim().toLowerCase().email().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(120).optional(),
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/operator/job — create a job for a walk-up customer
// ─────────────────────────────────────────────────────────────────────
/**
 * The neighbour who flags the truck down. Deliberately skips the service-area
 * gate: that guard exists to stop out-of-area self-serve bookings, and the
 * operator is physically standing at the bin. Creates a real customer so the
 * receipt, wash GIF, and rating funnel all work and the customer can be
 * upsold a plan later.
 */
export async function handleNewJob(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const parsed = newJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  const data = parsed.data;

  try {
    const db = getDb();
    const visitId = crypto.randomUUID();
    // customer.email is NOT NULL + UNIQUE. A walk-up who won't share an email
    // still needs a valid row, so mint a routable-looking placeholder; the
    // send path skips these (see notifications).
    const email = data.email ?? `walkup+${visitId.slice(0, 8)}@luckyshamrock.ca`;

    const [existing] = await db.select().from(customer).where(eq(customer.email, email));
    const customerId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await db.insert(customer).values({
        id: customerId,
        email,
        name: data.name ?? 'Walk-up customer',
        street: data.street,
        city: data.city ?? 'Fort Saskatchewan',
        postalCode: normalizePostalCode(data.postal_code),
        pickupDay: 'wednesday', // unused for one-offs; column is NOT NULL
      });
    }

    await db.insert(visit).values({
      id: visitId,
      customerId,
      subscriptionId: null,
      binCount: data.bin_count,
      scheduledFor: new Date(`${operatorTodayISO()}T12:00:00Z`),
      status: 'scheduled',
    });

    res.status(201).json({ status: 'ok', visit_id: visitId, customer_id: customerId });
  } catch (err) {
    console.error('[operator/job] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
```

- [ ] **Step 4: Skip customer emails for placeholder addresses**

A walk-up who gave no email gets a `walkup+…@luckyshamrock.ca` address. Mail to
it would bounce against our own domain and dent sender reputation, so the done
email must be skipped for those. Add the predicate to `lib/operator-handlers.ts`
next to `newJobSchema`:

```typescript
/** Walk-up customers who gave no email get a placeholder — never mail those. */
export function isPlaceholderEmail(email: string): boolean {
  return /^walkup\+[0-9a-f]{8}@luckyshamrock\.ca$/i.test(email);
}
```

In `handleDone`, guard the customer send (leave the operator-facing sends alone):

```typescript
    const result = isPlaceholderEmail(row.email)
      ? { skipped: true as const }
      : await sendAndLog({
```

...keeping the existing `sendAndLog({...})` argument object and closing paren
unchanged.

Add the covering test to `api/_tests/operator-job.test.ts`:

```typescript
  it('sends no customer email to a placeholder walk-up address', async () => {
    const res = mockRes();
    await handler(await req(true, { street: '12 Curb Lane', postal_code: 'T8L 0A1', bin_count: 1 }), res);
    expect(res.statusCode).toBe(201);

    const { visit_id } = res.body as { visit_id: string };
    const doneRes = mockRes();
    const cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
    await doneHandler(
      { method: 'POST', headers: { cookie }, query: { id: visit_id }, body: { payment_method: 'cash' } } as any,
      doneRes,
    );
    expect(doneRes.statusCode).toBe(200);

    const logs = await getDb().select().from(notificationLog);
    expect(logs.filter((l) => l.kind === 'done')).toHaveLength(0);
  });
```

Add these imports to that test file:

```typescript
import { handleDone as doneHandler } from '../../lib/operator-handlers.js';
import { notificationLog } from '../../db/schema.js';
```

- [ ] **Step 5: Register the route**

In `api/operator/[action].ts`, import `handleNewJob` and add to `ONE_SEG`:

```typescript
  job: handleNewJob,
```

Add to the route list in that file's header comment:

```
 *   POST /api/operator/job       ← walk-up: create customer + one-off visit
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx dotenv -e .env.local -- vitest run api/_tests/operator-job.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add lib/operator-handlers.ts "api/operator/[action].ts" api/_tests/operator-job.test.ts
git commit -m "Walk-up jobs: create customer + one-off visit from /ops"
```

---

### Task 7: Ops UI — payment method picker and QR display

**Files:**
- Modify: `ops/components-ops.jsx` (`StopCard`)
- Modify: `ops/index.html` (QR library script tag)
- Create: `paid.html` (customer-facing "payment received" page)

**Interfaces:**
- Consumes: `done` op fields `payment_method`, `amount_cents` (Task 3/4); `payment_url` in the Done response (Task 4).
- Produces: no server interface.

- [ ] **Step 1: Create the customer success page**

Create `paid.html` — the page Stripe redirects the payer to after a QR payment:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Payment received — Lucky Shamrock</title>
  <link rel="icon" href="assets/logo.png">
  <style>
    body { margin:0; font-family:'Avenir Next','Segoe UI',system-ui,sans-serif; background:#f2f7f2; color:#26332a; }
    .card { max-width:420px; margin:64px auto; background:#fff; border:1px solid #e2ece2; border-radius:12px; overflow:hidden; text-align:center; }
    .head { background:#1d7a3d; padding:18px 24px; color:#fff; font-weight:700; font-size:19px; }
    .body { padding:28px 24px; }
    h1 { font-size:21px; margin:0 0 8px; }
    p { margin:0 0 12px; font-size:15px; line-height:1.5; color:#3d4a3a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="head">🍀 Lucky Shamrock</div>
    <div class="body">
      <h1>Payment received — thank you!</h1>
      <p>Your bin is clean and your receipt is on its way by email.</p>
      <p><a href="/" style="color:#1d7a3d;font-weight:600">Back to luckyshamrock.ca</a></p>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 2: Add payment state and the picker to StopCard**

In `ops/components-ops.jsx`, inside `StopCard`, add state next to the existing `discount` state:

```jsx
  const [payMethod, setPayMethod] = useState('card_on_file');
  const [amountOverride, setAmountOverride] = useState('');
  const [qrUrl, setQrUrl] = useState('');
```

Replace the body of `doneWithDiscount` payload construction so the method and
amount ride along (keep the existing photo checks above it untouched):

```jsx
    const dollars = parseFloat(discount);
    const discount_cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    const payload = { discount_cents, clean_photo: photoState.photo, payment_method: payMethod };
    const amt = parseFloat(amountOverride);
    if (Number.isFinite(amt) && amt > 0) payload.amount_cents = Math.round(amt * 100);
    if (beforeState.photo) payload.before_photo = beforeState.photo;
    clearPhotos(stop.id);
    onAction('done', stop, payload);
```

- [ ] **Step 3: Render the picker**

Insert this block just above the existing discount row in `StopCard`'s JSX:

```jsx
      {!isDone && !isCancelled && (
        <div className="ops-pay" style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-3, #6b6b6b)', marginBottom: 6 }}>
            How are they paying?
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[
              ['card_on_file', '💳 Card on file'],
              ['qr', '📱 QR code'],
              ['terminal', '🔖 Tap in Stripe'],
              ['cash', '💵 Cash'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => setPayMethod(value)}
                style={{
                  padding: '7px 10px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  border: payMethod === value ? '2px solid #1f7a1f' : '1px solid rgba(0,0,0,0.15)',
                  background: payMethod === value ? 'var(--green-soft, #eef6ef)' : '#fff',
                  fontWeight: payMethod === value ? 600 : 400,
                }}
              >{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>Amount&nbsp;$</label>
            <input
              type="number" min="0" step="1" inputMode="decimal" placeholder="auto"
              value={amountOverride} onChange={(e) => setAmountOverride(e.target.value)}
              style={{ width: 90, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15 }}
            />
            <span style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>blank = standard price</span>
          </div>
          {payMethod === 'terminal' && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>
              <a
                href="https://dashboard.stripe.com/payments"
                target="_blank"
                rel="noopener"
                style={{ color: '#1d7a3d', fontWeight: 600 }}
              >Open Stripe app to tap →</a>
              <div>Collect there, then tap Done here to record it.</div>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 4: Render the QR returned by the server**

`onAction` must hand the response back. In `OpsApp`'s action handler, return the
parsed JSON to the caller, then in `StopCard`'s `doneWithDiscount` await it:

```jsx
    const result = await onAction('done', stop, payload);
    if (result && result.payment_url) {
      setQrUrl(result.payment_url);
      setQrSvg(result.payment_qr_svg || '');
    }
```

Add `qrSvg` to the state declared in Step 2:

```jsx
  const [qrSvg, setQrSvg] = useState('');
```

Add the QR panel to `StopCard`'s JSX, after the actions row. The SVG comes from
our own server (never from user input), so injecting it is safe:

```jsx
      {qrUrl && (
        <div style={{ marginTop: 12, textAlign: 'center', padding: 12, border: '1px solid #cde3cd', borderRadius: 10, background: '#f7fbf7' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Have them scan to pay</div>
          {qrSvg
            ? <div style={{ display: 'flex', justifyContent: 'center' }} dangerouslySetInnerHTML={{ __html: qrSvg }} />
            : <div style={{ fontSize: 12 }}>QR unavailable — use the link below.</div>}
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <a href={qrUrl} target="_blank" rel="noopener" style={{ color: '#1d7a3d' }}>or open the payment link</a>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Verify the JSX parses and check it in a browser**

```bash
npx esbuild ops/components-ops.jsx --loader:.jsx=jsx --outfile=/dev/null
```
Expected: no output (success).

Then load `/ops` locally or on a preview deploy, open a stop, and confirm the
four payment buttons render and toggle.

- [ ] **Step 6: Commit**

```bash
git add ops/components-ops.jsx paid.html
git commit -m "Ops: payment method picker, amount override, QR display"
```

---

### Task 8: Ops UI — walk-up job form

**Files:**
- Modify: `ops/components-ops.jsx` (new `NewJobCard`, rendered in the Today view)

**Interfaces:**
- Consumes: `POST /api/operator/job` (Task 6).
- Produces: no server interface.

- [ ] **Step 1: Add the NewJobCard component**

Add above `StopCard` in `ops/components-ops.jsx`:

```jsx
// Walk-up job: someone flags the truck down. Deliberately minimal — street,
// bins, and an optional email are all that's needed to start cleaning.
function NewJobCard({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ street: '', postal_code: '', bin_count: 1, email: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (!form.street.trim() || !form.postal_code.trim()) {
      setErr('Street and postal code are required.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        street: form.street.trim(),
        postal_code: form.postal_code.trim(),
        bin_count: Number(form.bin_count) || 1,
      };
      if (form.email.trim()) body.email = form.email.trim();
      if (form.name.trim()) body.name = form.name.trim();
      const r = await fetch('/api/operator/job', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('could not create job');
      setForm({ street: '', postal_code: '', bin_count: 1, email: '', name: '' });
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr('Could not create the job — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-primary ops-btn" style={{ width: '100%', marginBottom: 12 }} onClick={() => setOpen(true)}>
        + New job here
      </button>
    );
  }

  const field = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15, marginBottom: 8 };
  return (
    <div className="ops-card" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 17 }}>New job at this address</h2>
      <Flash kind="err" text={err} />
      <input style={field} placeholder="Street address *" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
      <input style={field} placeholder="Postal code *" value={form.postal_code} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} />
      <select style={field} value={form.bin_count} onChange={(e) => setForm({ ...form, bin_count: e.target.value })}>
        <option value={1}>1 bin</option>
        <option value={2}>2 bins</option>
        <option value={3}>3 bins</option>
      </select>
      <input style={field} placeholder="Email (optional — for receipt)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <input style={field} placeholder="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-go ops-btn" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Start job'}</button>
        <button className="btn btn-ghost ops-btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render it in the Today view**

In `OpsApp`'s Today tab JSX, immediately above the stop list, add:

```jsx
        <NewJobCard onCreated={load} />
```

(`load` is the existing function that refetches the day's stops — reuse it so
the new job appears immediately.)

- [ ] **Step 3: Verify the JSX parses**

```bash
npx esbuild ops/components-ops.jsx --loader:.jsx=jsx --outfile=/dev/null
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add ops/components-ops.jsx
git commit -m "Ops: walk-up job form on the Today view"
```

---

### Task 9: Docs, full suite, deploy, live verification

**Files:**
- Modify: `CLAUDE.md` (operator + payments conventions)
- Modify: `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md` (session log)
- Modify: `~/Documents/My Brain/Projects/Lucky Shamrock/Billing Log.md`

- [ ] **Step 1: Document the conventions**

Add to `CLAUDE.md` under the Payments section:

```markdown
- **Doorstep payments.** `POST /api/operator/act {op:'done'}` takes
  `payment_method` ∈ {card_on_file (default), cash, terminal, qr} and an
  optional `amount_cents` override (server clamps 0–100000; blank = standard
  price). cash/terminal record a succeeded `payment` row with that `method` and
  set `visit.payment_status` to `paid_cash`/`paid_terminal` — no Stripe call.
  qr creates a Stripe **Checkout Session** (`lib/billing.ts
  createDoorstepCheckoutSession`), returns `payment_url` for /ops to render as a
  QR, and leaves the visit `awaiting_payment` until
  `checkout.session.completed` lands. **That event MUST be in the live webhook's
  event list** or QR payments never confirm.
- **Tap to Pay is native-SDK only** (Stripe iOS/Android/React Native). It cannot
  work in the /ops web page. The `terminal` method means "operator collected in
  the Stripe app"; it is reconciled in Stripe by amount/time, not auto-linked.
- **Walk-up jobs.** `POST /api/operator/job` creates a customer + one-off visit
  for someone who flags the truck down. Deliberately **skips the service-area
  gate**. A missing email becomes `walkup+<8hex>@luckyshamrock.ca` so the
  NOT NULL/UNIQUE constraints hold; those addresses receive no customer email.
```

- [ ] **Step 2: Run the full suite and typecheck**

```bash
npm run typecheck && npm test
```
Expected: typecheck silent; all tests pass (306 existing + ~18 new).

- [ ] **Step 3: Deploy**

```bash
git push origin main
```
Then poll for the deployment to reach READY and confirm `/api/health` returns `db:true`.

- [ ] **Step 4: Add the Stripe webhook event (AB, dashboard)**

In the Stripe dashboard → Developers → Webhooks → the live
`https://www.luckyshamrock.ca/api/stripe/webhook` endpoint → add
**`checkout.session.completed`** to the event list. Without it, QR payments stay
`awaiting_payment` forever.

- [ ] **Step 5: Live-verify each path**

Seed a throwaway customer+visit in prod, then via `/ops`:
1. Cash → visit `paid_cash`, `payment.method='cash'`, receipt email arrives.
2. QR → `payment_url` returned, QR renders, visit `awaiting_payment`; complete
   the Stripe checkout in test/live as appropriate and confirm the webhook flips
   it to `charged`.
3. Walk-up → `+ New job here` creates a stop that appears in Today immediately.

Then delete the throwaway rows.

- [ ] **Step 6: Update the notes and billing log**

Append a dated entry to the project note's Session Log and a row to
`Billing Log.md` (date, what shipped, hours, type `F`).

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "Document doorstep payment + walk-up job conventions"
git push origin main
```
