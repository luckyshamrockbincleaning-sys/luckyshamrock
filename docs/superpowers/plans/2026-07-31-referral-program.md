# Referral Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer refer a neighbour with a 6-character code they can say aloud or share as a link — the friend gets $5 off their first clean, and the referrer earns $5 credit once that friend's first clean is completed and paid.

**Architecture:** Four columns on `customer` plus one on `payment` (migration `0011`) — no new table. Both the friend's $5 and the referrer's $5 are the same thing: balance in `customer.credit_cents`, spent automatically at Done. Code validation folds into `/api/book` as a new `intent` so no 13th Vercel function is created. The award helper lives in a dependency-light `lib/referral.ts` because it is called from BOTH `lib/operator-handlers.ts` and `lib/billing-webhook.ts`.

**Tech Stack:** TypeScript, Vercel Functions (Node 20), Neon Postgres via drizzle-orm, vitest, React via Babel-standalone (no build step).

## Global Constraints

- **12/12 Vercel Hobby functions — the cap is reached.** Adding ANY file under `api/` fails the build. Every new endpoint in this plan folds into an existing function via an `intent` (book) or `action` (operator) discriminator.
- **Reward is $5 = `500` cents, both sides.** Single source: `REFERRAL_REWARD_CENTS` in `lib/referral.ts`.
- **Referrer is paid only when the friend's first clean is completed AND paid.** Never at booking. A `comped` clean never pays a referrer.
- **Credit stacks and never expires.** No caps, no expiry logic.
- **Code alphabet is `ABCDEFGHJKMNPQRSTUVWXYZ23456789`** — no `0`/`O`, no `1`/`I`/`L`. Length 6, uppercase.
- **`check_referral` always returns HTTP 200** with a `valid` boolean — never 404 on an unknown code (enumeration oracle). Matches the existing rule on `/api/magic-link/send`.
- **A valid code returns the referrer's FIRST NAME ONLY.** Never full name, never email.
- **`lib/referral.ts` must not import `operator-handlers.ts`.** `billing-webhook.ts` imports it, and pulling in operator-handlers drags `sharp` + `gifenc` + the ~947 KB sprite module into the Stripe webhook bundle. This is exactly why `lib/walkup-email.ts` exists — follow that precedent.
- **Tests run against `neondb_test`**, never prod. `npm test` handles the swap.
- **Prices are server-side only** (`lib/pricing.ts`, cents). Never trust a client amount.

## Stage mapping

The spec splits this into two stages to keep the charge-path change isolated and reviewable. Tasks map as follows:

- **Stage 1 (records intent, moves no money):** Tasks 1–5, 8, 9
- **Stage 2 (spends and awards balance):** Tasks 6–7

**These must ship together or within days of each other.** After Stage 1 a friend has been promised "$5 off your first clean" and has the balance sitting on their row, but nothing spends it until Stage 2 — charging them full price would make the product a liar. If Stage 2 slips, Shea applies $5 by hand via the existing `/ops` discount box for any referred customer serviced in the gap.

---

### Task 1: Referral code generator + reward constant

**Files:**
- Create: `lib/referral.ts`
- Test: `lib/_tests/referral.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `REFERRAL_REWARD_CENTS: number` (=500), `REFERRAL_CODE_LENGTH: number` (=6), `generateReferralCode(): string`, `normalizeReferralCode(input: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/_tests/referral.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_REWARD_CENTS,
  REFERRAL_CODE_LENGTH,
} from '../referral.js';

describe('REFERRAL_REWARD_CENTS', () => {
  it('is $5 in cents', () => {
    expect(REFERRAL_REWARD_CENTS).toBe(500);
  });
});

describe('generateReferralCode', () => {
  it('returns an uppercase code of the declared length', () => {
    const code = generateReferralCode();
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    expect(code).toBe(code.toUpperCase());
  });

  it('never emits visually ambiguous characters', () => {
    // 0/O and 1/I/L get misheard over a fence and mistyped from a sticker.
    for (let i = 0; i < 500; i++) {
      expect(generateReferralCode()).not.toMatch(/[01OIL]/);
    }
  });

  it('draws from the full alphabet and does not return a constant', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateReferralCode());
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('normalizeReferralCode', () => {
  it('uppercases and strips spaces and dashes so "k7m2-qx" matches', () => {
    expect(normalizeReferralCode(' k7m2-qx ')).toBe('K7M2QX');
  });

  it('returns an empty string for null-ish input', () => {
    expect(normalizeReferralCode('')).toBe('');
    expect(normalizeReferralCode(undefined as unknown as string)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Documents/luckyshamrock && npx dotenv -e .env.local -- npx vitest run lib/_tests/referral.test.ts`
Expected: FAIL — `Failed to resolve import "../referral.js"`

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/referral.ts
/**
 * Referral codes and reward accounting.
 *
 * Kept deliberately dependency-light: this module is imported by BOTH
 * lib/operator-handlers.ts and lib/billing-webhook.ts. Importing
 * operator-handlers from the webhook would drag sharp + gifenc + the ~947 KB
 * sprite module into the Stripe webhook's serverless bundle — the same trap
 * lib/walkup-email.ts was carved out to avoid. Import only db + schema here.
 */
import { randomBytes } from 'node:crypto';

/** Both sides of a successful referral get $5. Single source of truth. */
export const REFERRAL_REWARD_CENTS = 500;

export const REFERRAL_CODE_LENGTH = 6;

// No 0/O and no 1/I/L: these codes get said out loud over a fence and typed
// from memory, so visual and audible ambiguity costs real conversions.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A fresh referral code. 31^6 ≈ 887M combinations — this is not a secret
 * (guessing one earns $5 and reveals a first name), but the space is far too
 * large to brute-force over HTTP, and `check_referral` never confirms a miss
 * differently from a hit.
 */
export function generateReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Accept what a human actually types: lowercase, spaces, hyphens. */
export function normalizeReferralCode(input: string): string {
  if (!input) return '';
  return input.replace(/[\s-]/g, '').toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Documents/luckyshamrock && npx dotenv -e .env.local -- npx vitest run lib/_tests/referral.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/referral.ts lib/_tests/referral.test.ts
git commit -m "Referral: code generator and reward constant"
```

---

### Task 2: Schema + migration 0011

**Files:**
- Modify: `db/schema.ts` (customer table, payment table, notificationKindEnum)
- Create: `db/migrations/0011_*.sql` (generated by drizzle-kit)
- Create: `db/backfill-referral-codes.ts`

**Interfaces:**
- Consumes: `generateReferralCode` from Task 1
- Produces: `customer.referralCode`, `customer.creditCents`, `customer.referredBy`, `customer.referralAwardedAt`, `payment.creditCents`, notification kind `'referral_earned'`

- [ ] **Step 1: Add the columns to `db/schema.ts`**

In the `customer` table, after `defaultPaymentMethodId`:

```typescript
    // Referral program. `referralCode` is this customer's own shareable code
    // (nullable: pre-existing rows are backfilled by db/backfill-referral-codes.ts).
    // `creditCents` is a stacking, never-expiring balance spent automatically at
    // Done — it holds BOTH the friend's welcome $5 and any earned referral $5.
    // `referredBy` is who sent them; `referralAwardedAt` stamps the moment that
    // referrer was paid, and is the idempotency guard against double payouts.
    referralCode: text('referral_code'),
    creditCents: integer('credit_cents').notNull().default(0),
    referredBy: uuid('referred_by'),
    referralAwardedAt: timestamp('referral_awarded_at', { withTimezone: true }),
```

Add to the `customer` table's constraint block (alongside `emailUnique`):

```typescript
    referralCodeUnique: unique('customer_referral_code_unique').on(t.referralCode),
    creditNonNegative: check('customer_credit_non_negative', sql`${t.creditCents} >= 0`),
```

In the `payment` table, after `discountCents`:

```typescript
    // Referral/goodwill credit consumed by this payment. Recorded so the PDF
    // receipt line items still add up to the total paid, and so spent credit is
    // auditable after the fact.
    creditCents: integer('credit_cents').notNull().default(0),
```

Add `'referral_earned'` to `notificationKindEnum`.

Ensure `integer`, `check`, and `sql` are imported at the top of `db/schema.ts` (add whichever are missing).

- [ ] **Step 2: Generate the migration**

Run: `cd ~/Documents/luckyshamrock && npm run db:generate`
Expected: a new `db/migrations/0011_*.sql` appears containing `ALTER TABLE "customer" ADD COLUMN "referral_code" text`, the three other customer columns, `ALTER TABLE "payment" ADD COLUMN "credit_cents"`, the unique + check constraints, and `ALTER TYPE ... ADD VALUE 'referral_earned'`.

- [ ] **Step 3: Add the FK by hand to the generated SQL**

Drizzle will not emit the self-referencing FK from the column definition above. Append to the generated `0011_*.sql`:

```sql
ALTER TABLE "customer"
  ADD CONSTRAINT "customer_referred_by_fk"
  FOREIGN KEY ("referred_by") REFERENCES "customer"("id") ON DELETE restrict;
```

`restrict` matches the posture of the rest of the schema — deleting a customer who referred someone must be a deliberate act, not a silent cascade.

- [ ] **Step 4: Apply to the TEST database and verify**

```bash
cd ~/Documents/luckyshamrock
set -a; source .env.local; set +a
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL_UNPOOLED" npx drizzle-kit push --force
```

Expected: applies cleanly, no errors.

- [ ] **Step 5: Write the backfill script**

```typescript
// db/backfill-referral-codes.ts
/**
 * One-off: give every pre-existing customer a referral code.
 *
 * New customers get a code at booking (see api/book.ts). This covers the rows
 * that predate the feature so /manage is never blank for them. Idempotent —
 * only touches rows where referral_code IS NULL, so it is safe to re-run.
 *
 * Run once per database:
 *   npx dotenv -e .env.local -- npx tsx db/backfill-referral-codes.ts
 */
import { isNull } from 'drizzle-orm';
import { getDb } from './client.js';
import { customer } from './schema.js';
import { generateReferralCode } from '../lib/referral.js';
import { eq } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const rows = await db.select({ id: customer.id, email: customer.email })
    .from(customer).where(isNull(customer.referralCode));
  console.log(`[backfill] ${rows.length} customer(s) without a referral code`);

  for (const row of rows) {
    // Retry on the astronomically unlikely unique collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateReferralCode();
      try {
        await db.update(customer).set({ referralCode: code }).where(eq(customer.id, row.id));
        console.log(`[backfill] ${row.email} -> ${code}`);
        break;
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
  }
  console.log('[backfill] done');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 6: Run the backfill against the TEST database**

```bash
cd ~/Documents/luckyshamrock
DATABASE_URL="$TEST_DATABASE_URL" npx dotenv -e .env.local -- npx tsx db/backfill-referral-codes.ts
```

Expected: prints a count and `[backfill] done`.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npx dotenv -e .env.local -- npx vitest run`
Expected: typecheck clean; all existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add db/schema.ts db/migrations/ db/backfill-referral-codes.ts
git commit -m "Referral: migration 0011 — credit balance, codes, attribution"
```

> **⚠️ Production migration is NOT applied here.** Prod is applied once at deploy time — see the Deployment Checklist at the end of this plan.

---

### Task 3: Issue a referral code to every new customer at booking

**Files:**
- Modify: `api/book.ts` (imports; the `tx.insert(customer)` block around line 224)
- Test: `api/_tests/book-referral.test.ts`

**Interfaces:**
- Consumes: `generateReferralCode` (Task 1), `customer.referralCode` (Task 2)
- Produces: every newly booked customer has a non-null unique `referral_code`

- [ ] **Step 1: Write the failing test**

```typescript
// api/_tests/book-referral.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../book.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { REFERRAL_CODE_LENGTH } from '../../lib/referral.js';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});
beforeEach(async () => { await truncateAllForTests(); });

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  return res;
}

const validBooking = {
  name: 'Ref Tester',
  email: 'ref-tester@example.com',
  street: '1 Rd',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 0A1',
  pickup_day: 'wednesday',
  bin_count: 1,
  plan: 'monthly',
};

describe('booking issues a referral code', () => {
  it('gives a new customer a unique code and a zero balance', async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: validBooking } as any, res);
    expect(res.statusCode).toBe(200);

    const [c] = await getDb().select().from(customer).where(eq(customer.email, 'ref-tester@example.com'));
    expect(c!.referralCode).toBeTruthy();
    expect(c!.referralCode).toHaveLength(REFERRAL_CODE_LENGTH);
    expect(c!.referralCode).not.toMatch(/[01OIL]/);
    expect(c!.creditCents).toBe(0);
    expect(c!.referredBy).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/book-referral.test.ts`
Expected: FAIL — `expected null to be truthy` on `referralCode`

- [ ] **Step 3: Implement**

In `api/book.ts`, add to the imports:

```typescript
import { generateReferralCode } from '../lib/referral.js';
```

Immediately before the `await db.transaction(async (tx) => {` block (next to where `tokenPlain` is created):

```typescript
    // Every customer gets their own shareable code at booking. Generated here
    // rather than lazily so /manage and the done email can always show one.
    const newReferralCode = generateReferralCode();
```

Inside the transaction, in the `tx.insert(customer).values({...})` call, add:

```typescript
          referralCode: newReferralCode,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/book-referral.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/book.ts api/_tests/book-referral.test.ts
git commit -m "Referral: issue a code to every new customer at booking"
```

---

### Task 4: `check_referral` intent on `/api/book`

**Files:**
- Modify: `api/book.ts` (add an intent branch beside the existing `payment_setup` branch, ~line 45)
- Test: `api/_tests/book-referral.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeReferralCode` (Task 1), `customer.referralCode` (Task 2)
- Produces: `POST /api/book {intent:'check_referral', code}` → `200 {status:'ok', valid: boolean, referrer_first_name?: string}`

- [ ] **Step 1: Write the failing test**

```typescript
// append to api/_tests/book-referral.test.ts
describe('POST /api/book {intent:check_referral}', () => {
  async function seedReferrer(): Promise<string> {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {},
      body: { ...validBooking, name: 'Richelle Regehr', email: 'richelle@example.com' } } as any, res);
    const [c] = await getDb().select().from(customer).where(eq(customer.email, 'richelle@example.com'));
    return c!.referralCode!;
  }

  it('accepts a real code and returns the referrer FIRST NAME only', async () => {
    const code = await seedReferrer();
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: { intent: 'check_referral', code } } as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.referrer_first_name).toBe('Richelle');
    // Never leak the surname or the email to someone holding only a code.
    expect(JSON.stringify(res.body)).not.toContain('Regehr');
    expect(JSON.stringify(res.body)).not.toContain('richelle@example.com');
  });

  it('is case- and punctuation-insensitive', async () => {
    const code = await seedReferrer();
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {},
      body: { intent: 'check_referral', code: ` ${code.toLowerCase()} ` } } as any, res);
    expect(res.body.valid).toBe(true);
  });

  it('returns 200 valid:false for an unknown code — never 404 (enumeration oracle)', async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: { intent: 'check_referral', code: 'ZZZZZZ' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.referrer_first_name).toBeUndefined();
  });

  it('returns 200 valid:false for a missing or malformed code', async () => {
    for (const code of ['', '!!', 'TOOLONGCODE']) {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, query: {}, body: { intent: 'check_referral', code } } as any, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.valid).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/book-referral.test.ts -t check_referral`
Expected: FAIL — the intent is unhandled, so the request falls through to the booking schema and 400s.

- [ ] **Step 3: Implement**

In `api/book.ts`, add to imports:

```typescript
import { normalizeReferralCode, REFERRAL_CODE_LENGTH } from '../lib/referral.js';
```

Immediately AFTER the `if (req.body?.intent === 'payment_setup') { ... }` block closes, add:

```typescript
  // Look up a referral code typed (or link-carried) by a prospective customer.
  //
  // ALWAYS 200 with a `valid` flag — never 404 on a miss. A distinguishable
  // "not found" turns this into a free oracle for enumerating live codes, the
  // same reason /api/magic-link/send always returns 200 regardless of whether
  // the email exists. Only the referrer's FIRST NAME is returned: enough to
  // make "$5 off, courtesy of Richelle" feel real, not enough to hand a
  // stranger who guessed a code someone's full identity.
  if (req.body?.intent === 'check_referral') {
    const code = normalizeReferralCode(String(req.body?.code ?? ''));
    if (code.length !== REFERRAL_CODE_LENGTH) {
      res.status(200).json({ status: 'ok', valid: false });
      return;
    }
    try {
      const db = getDb();
      const [owner] = await db
        .select({ name: customer.name })
        .from(customer)
        .where(eq(customer.referralCode, code));
      if (!owner) {
        res.status(200).json({ status: 'ok', valid: false });
        return;
      }
      res.status(200).json({
        status: 'ok',
        valid: true,
        referrer_first_name: owner.name.trim().split(/\s+/)[0] ?? '',
      });
    } catch (err) {
      console.error('[book:check_referral] failed', err);
      // Degrade to "no discount" rather than blocking the booking entirely.
      res.status(200).json({ status: 'ok', valid: false });
    }
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/book-referral.test.ts`
Expected: PASS, all tests

- [ ] **Step 5: Confirm the function count is still 12**

Run: `find api -name '*.ts' -not -path '*/_tests/*' | wc -l`
Expected: `12`

- [ ] **Step 6: Commit**

```bash
git add api/book.ts api/_tests/book-referral.test.ts
git commit -m "Referral: check_referral intent on /api/book (no new function)"
```

---

### Task 5: Capture `referred_by` and seed the friend's $5 at booking

**Files:**
- Modify: `lib/validation.ts` (add `referral_code` to `bookRequestSchema`)
- Modify: `api/book.ts` (resolve the referrer; set `referredBy` + `creditCents` on insert)
- Test: `api/_tests/book-referral.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: a booking carrying a valid `referral_code` sets `customer.referredBy` and `customer.creditCents = REFERRAL_REWARD_CENTS`

- [ ] **Step 1: Write the failing test**

```typescript
// append to api/_tests/book-referral.test.ts
import { REFERRAL_REWARD_CENTS } from '../../lib/referral.js';

describe('booking with a referral code', () => {
  async function seedReferrer(email = 'richelle@example.com'): Promise<{ code: string; id: string }> {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {},
      body: { ...validBooking, name: 'Richelle Regehr', email } } as any, res);
    const [c] = await getDb().select().from(customer).where(eq(customer.email, email));
    return { code: c!.referralCode!, id: c!.id };
  }

  it('links the friend to the referrer and seeds their $5', async () => {
    const referrer = await seedReferrer();
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {},
      body: { ...validBooking, name: 'New Friend', email: 'friend@example.com', referral_code: referrer.code } } as any, res);
    expect(res.statusCode).toBe(200);

    const [friend] = await getDb().select().from(customer).where(eq(customer.email, 'friend@example.com'));
    expect(friend!.referredBy).toBe(referrer.id);
    expect(friend!.creditCents).toBe(REFERRAL_REWARD_CENTS);
    expect(friend!.referralAwardedAt).toBeNull();
    // The referrer is NOT paid yet — not until the friend's first clean is paid.
    const [ref] = await getDb().select().from(customer).where(eq(customer.id, referrer.id));
    expect(ref!.creditCents).toBe(0);
  });

  it('ignores an unknown code instead of failing the booking', async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {},
      body: { ...validBooking, email: 'nocode@example.com', referral_code: 'ZZZZZZ' } } as any, res);
    expect(res.statusCode).toBe(200);
    const [c] = await getDb().select().from(customer).where(eq(customer.email, 'nocode@example.com'));
    expect(c!.referredBy).toBeNull();
    expect(c!.creditCents).toBe(0);
  });

  it('blocks self-referral: reusing your own code earns nothing', async () => {
    const referrer = await seedReferrer('self@example.com');
    const res = mockRes();
    // Same email re-books (existing customer path) quoting their own code.
    await handler({ method: 'POST', headers: {}, query: {},
      body: { ...validBooking, plan: 'oneoff', oneoff_date: '2026-12-02',
              name: 'Richelle Regehr', email: 'self@example.com', referral_code: referrer.code } } as any, res);

    const [c] = await getDb().select().from(customer).where(eq(customer.id, referrer.id));
    expect(c!.referredBy).toBeNull();
    expect(c!.creditCents).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/book-referral.test.ts -t "referral code"`
Expected: FAIL — `expected null to be <uuid>` on `referredBy`

- [ ] **Step 3: Add the field to the booking schema**

In `lib/validation.ts`, inside the `bookRequestSchema` object (beside `payment_setup`):

```typescript
    referral_code: z.string().trim().max(32).optional(),
```

No format validation here on purpose — an unknown or malformed code must degrade to "no discount", never reject an otherwise-valid booking.

- [ ] **Step 4: Resolve the referrer in `api/book.ts`**

Add to imports:

```typescript
import { REFERRAL_REWARD_CENTS } from '../lib/referral.js';
```

After `const [existing] = ...` / `customerId` / `isNewCustomer` are resolved and BEFORE the transaction, add:

```typescript
    // Resolve an inbound referral code. A bad code silently yields no discount —
    // never block a real booking over it. Self-referral is rejected by comparing
    // the resolved owner against the booking customer.
    let referrerId: string | null = null;
    const inboundCode = normalizeReferralCode(data.referral_code ?? '');
    if (inboundCode.length === REFERRAL_CODE_LENGTH) {
      const [owner] = await db
        .select({ id: customer.id })
        .from(customer)
        .where(eq(customer.referralCode, inboundCode));
      if (owner && owner.id !== customerId) referrerId = owner.id;
    }
```

- [ ] **Step 5: Apply it on insert**

In the `tx.insert(customer).values({...})` block, add:

```typescript
          referredBy: referrerId,
          creditCents: referrerId ? REFERRAL_REWARD_CENTS : 0,
```

Leave the `else` (existing-customer update) branch alone: a returning customer keeps whatever balance they already have, and `referred_by` is set once and never rewritten.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/book-referral.test.ts`
Expected: PASS, all tests

- [ ] **Step 7: Commit**

```bash
git add lib/validation.ts api/book.ts api/_tests/book-referral.test.ts
git commit -m "Referral: capture referred_by and seed the friend's \$5 at booking"
```

---

### Task 6: Spend credit at Done

**Files:**
- Modify: `lib/referral.ts` (add `spendCredit`)
- Modify: `lib/operator-handlers.ts` (`handleDone`: select balance, apply, record)
- Modify: `lib/receipt-pdf.ts` (credit line item)
- Test: `lib/_tests/referral.test.ts`, `api/_tests/operator-done.test.ts` (append)

**Interfaces:**
- Consumes: `customer.creditCents`, `payment.creditCents` (Task 2)
- Produces: `spendCredit(db, customerId, maxCents): Promise<number>` — atomically consumes up to `maxCents` and returns the amount actually consumed

- [ ] **Step 1: Write the failing test**

```typescript
// append to api/_tests/operator-done.test.ts
import { customer as customerTable } from '../../db/schema.js';
import { REFERRAL_REWARD_CENTS } from '../../lib/referral.js';

describe('referral credit at Done', () => {
  async function giveCredit(customerId: string, cents: number) {
    await getDb().update(customerTable).set({ creditCents: cents }).where(eq(customerTable.id, customerId));
  }

  it('reduces a cash settlement by the balance and spends it', async () => {
    const c = await seedCustomer();
    await giveCredit(c, REFERRAL_REWARD_CENTS); // $5
    const v1 = await addVisit(c, '2026-08-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), res);
    expect(res.statusCode).toBe(200);

    // One-off, 1 bin = $45.00; less $5 credit = $40.00
    expect(res.body.charge.amount_cents).toBe(4000);
    const [p] = await getDb().select().from(payment).where(eq(payment.visitId, v1));
    expect(p!.amountCents).toBe(4000);
    expect(p!.creditCents).toBe(REFERRAL_REWARD_CENTS);
    const [after] = await getDb().select().from(customerTable).where(eq(customerTable.id, c));
    expect(after!.creditCents).toBe(0);
  });

  it('applies credit on top of the operator discount, never below zero', async () => {
    const c = await seedCustomer();
    await giveCredit(c, 100000); // absurd balance
    const v1 = await addVisit(c, '2026-08-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash', discount_cents: 1000 }), res);

    expect(res.body.charge.amount_cents).toBe(0);
    const [after] = await getDb().select().from(customerTable).where(eq(customerTable.id, c));
    // $45 base − $10 discount = $35 consumed; the rest of the balance survives.
    expect(after!.creditCents).toBe(100000 - 3500);
  });

  it('leaves the balance alone when there is none', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-08-10');
    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), res);
    expect(res.body.charge.amount_cents).toBe(4500);
    const [p] = await getDb().select().from(payment).where(eq(payment.visitId, v1));
    expect(p!.creditCents).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/operator-done.test.ts -t "referral credit"`
Expected: FAIL — `expected 4500 to be 4000`

- [ ] **Step 3: Add `spendCredit` to `lib/referral.ts`**

```typescript
import { and, eq, gte, sql } from 'drizzle-orm';
import { customer } from '../db/schema.js';

/**
 * Atomically consume up to `maxCents` of a customer's credit. Returns the
 * amount actually consumed (0 if they had none).
 *
 * The `gte` guard in the WHERE clause is what makes this safe: two visits for
 * the same customer completed concurrently cannot both spend the same dollar,
 * because only one UPDATE will match. A caller that gets 0 back simply charges
 * full price — never a negative balance, never a double-spend.
 */
export async function spendCredit(
  db: { update: any; select: any },
  customerId: string,
  maxCents: number,
): Promise<number> {
  if (maxCents <= 0) return 0;
  const [row] = await db
    .select({ creditCents: customer.creditCents })
    .from(customer)
    .where(eq(customer.id, customerId));
  const available = row?.creditCents ?? 0;
  const applied = Math.min(available, maxCents);
  if (applied <= 0) return 0;

  const updated = await db
    .update(customer)
    .set({ creditCents: sql`${customer.creditCents} - ${applied}` })
    .where(and(eq(customer.id, customerId), gte(customer.creditCents, applied)))
    .returning({ id: customer.id });

  return updated.length > 0 ? applied : 0;
}
```

- [ ] **Step 4: Apply it in `handleDone`**

In `lib/operator-handlers.ts`, add `spendCredit` to the `./referral.js` import.

Add `creditCents: customer.creditCents,` to the `db.select({...})` that loads `row` at the top of `handleDone`.

Replace the single `effectiveBaseCents` derivation so every settlement branch shares one credit-reduced amount. Immediately after `const effectiveBaseCents = ...`, insert:

```typescript
    // Referral/goodwill credit applies AFTER the operator's discount and before
    // any money is taken, on every settlement path — a customer paying cash
    // must not silently forfeit their balance. Reserved (decremented) up front
    // so a later Stripe decline can't hand out the same credit twice; the
    // reduced figure is what lands on the payment row, so a retry re-charges
    // the correct amount.
    const afterDiscountCents = finalChargeCents(effectiveBaseCents, discountCents);
    const creditAppliedCents = alreadyBilled ? 0 : await spendCredit(db, row.customerId, afterDiscountCents);
```

In EACH of the four settlement branches (`qr`, `cash`/`terminal`, `card_on_file`), replace
`const amount = finalChargeCents(effectiveBaseCents, discountCents);`
with:

```typescript
      const amount = afterDiscountCents - creditAppliedCents;
```

and add `creditCents: creditAppliedCents,` to every `db.insert(payment).values({...})` in the handler.

> **Expected behaviour worth knowing before you see it:** in the `card_on_file` branch, the existing `if (amount <= 0)` guard comps the visit and skips Stripe. Credit large enough to cover the whole clean therefore lands the visit in `payment_status = 'comped'`. That is correct and intentional — the `payment_status` enum has no `paid_credit` state, no Stripe call should be made for a $0 charge, and the `payment` row still records `creditCents`, so the money is fully auditable. Do NOT add a new enum value for this.

- [ ] **Step 5: Show the credit on the receipt**

In `lib/receipt-pdf.ts`, add `creditCents?: number` to the input interface and render a line item `Referral credit   −$X.XX` beneath the discount line whenever it is greater than zero. In `handleDone`, pass `creditCents: creditAppliedCents` into `generateReceiptPdf({...})`.

- [ ] **Step 6: Run tests**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/operator-done.test.ts lib/_tests/referral.test.ts`
Expected: PASS, including all pre-existing done tests

- [ ] **Step 7: Commit**

```bash
git add lib/referral.ts lib/operator-handlers.ts lib/receipt-pdf.ts api/_tests/operator-done.test.ts lib/_tests/referral.test.ts
git commit -m "Referral: spend credit at Done across all four settlement methods"
```

---

### Task 7: Award the referrer when the friend's first clean is paid

**Files:**
- Modify: `lib/referral.ts` (add `awardReferralIfEarned`)
- Modify: `lib/operator-handlers.ts` (call it after settlement in `handleDone`)
- Modify: `lib/billing-webhook.ts` (call it on `checkout.session.completed` for QR)
- Modify: `lib/email/templates.ts` (add `referralEarnedTemplate`)
- Test: `api/_tests/operator-done.test.ts` (append)

**Interfaces:**
- Consumes: `spendCredit` (Task 6), notification kind `'referral_earned'` (Task 2)
- Produces: `awardReferralIfEarned(db, friendCustomerId): Promise<{ awarded: boolean; referrerId: string | null }>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to api/_tests/operator-done.test.ts
describe('referrer payout', () => {
  async function seedPair() {
    const db = getDb();
    const referrerId = await seedCustomer();
    const friendId = await seedCustomer();
    await db.update(customerTable).set({ referredBy: referrerId }).where(eq(customerTable.id, friendId));
    return { referrerId, friendId };
  }

  it('pays the referrer $5 once the friend\'s clean is done and paid', async () => {
    const { referrerId, friendId } = await seedPair();
    const v1 = await addVisit(friendId, '2026-08-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), res);
    expect(res.statusCode).toBe(200);

    const [ref] = await getDb().select().from(customerTable).where(eq(customerTable.id, referrerId));
    expect(ref!.creditCents).toBe(REFERRAL_REWARD_CENTS);
    const [friend] = await getDb().select().from(customerTable).where(eq(customerTable.id, friendId));
    expect(friend!.referralAwardedAt).not.toBeNull();
  });

  it('never pays twice, even across two separate cleans', async () => {
    const { referrerId, friendId } = await seedPair();
    const v1 = await addVisit(friendId, '2026-08-10');
    const v2 = await addVisit(friendId, '2026-09-10');
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), mockRes());
    await handler(await req(true, v2, 'POST', { payment_method: 'cash' }), mockRes());

    const [ref] = await getDb().select().from(customerTable).where(eq(customerTable.id, referrerId));
    expect(ref!.creditCents).toBe(REFERRAL_REWARD_CENTS); // not 1000
  });

  it('does NOT pay on a fully comped clean — no money changed hands', async () => {
    const { referrerId, friendId } = await seedPair();
    const v1 = await addVisit(friendId, '2026-08-10');
    // Discount exceeding the price comps the visit.
    await handler(await req(true, v1, 'POST', { payment_method: 'cash', discount_cents: 100000 }), mockRes());

    const [ref] = await getDb().select().from(customerTable).where(eq(customerTable.id, referrerId));
    expect(ref!.creditCents).toBe(0);
    const [friend] = await getDb().select().from(customerTable).where(eq(customerTable.id, friendId));
    expect(friend!.referralAwardedAt).toBeNull();
  });

  it('does nothing for a customer who was never referred', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-08-10');
    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), res);
    expect(res.statusCode).toBe(200);
    const [after] = await getDb().select().from(customerTable).where(eq(customerTable.id, c));
    expect(after!.creditCents).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/operator-done.test.ts -t "referrer payout"`
Expected: FAIL — `expected 0 to be 500`

- [ ] **Step 3: Add `awardReferralIfEarned` to `lib/referral.ts`**

```typescript
import { isNull } from 'drizzle-orm';

/**
 * Pay a referrer, exactly once, for a friend whose first clean just settled.
 *
 * Called from TWO places — handleDone (card/cash/terminal settle synchronously)
 * and billing-webhook (a QR payment confirms asynchronously). Idempotency comes
 * from the `referral_awarded_at IS NULL` guard in the WHERE clause: the second
 * caller updates zero rows and returns without crediting anyone, so a Stripe
 * redelivery or a double-tapped Done cannot pay twice.
 *
 * Callers must only invoke this when money actually moved. A comped clean must
 * never trigger it.
 */
export async function awardReferralIfEarned(
  db: { update: any; select: any },
  friendCustomerId: string,
): Promise<{ awarded: boolean; referrerId: string | null }> {
  const [friend] = await db
    .select({ referredBy: customer.referredBy, awardedAt: customer.referralAwardedAt })
    .from(customer)
    .where(eq(customer.id, friendCustomerId));

  if (!friend?.referredBy || friend.awardedAt) return { awarded: false, referrerId: null };

  // Claim the payout first. Whoever wins this UPDATE owns the credit.
  const claimed = await db
    .update(customer)
    .set({ referralAwardedAt: new Date() })
    .where(and(eq(customer.id, friendCustomerId), isNull(customer.referralAwardedAt)))
    .returning({ id: customer.id });
  if (claimed.length === 0) return { awarded: false, referrerId: null };

  await db
    .update(customer)
    .set({ creditCents: sql`${customer.creditCents} + ${REFERRAL_REWARD_CENTS}` })
    .where(eq(customer.id, friend.referredBy));

  return { awarded: true, referrerId: friend.referredBy };
}
```

- [ ] **Step 4: Add the email template**

In `lib/email/templates.ts`:

```typescript
export function referralEarnedTemplate(p: { name: string; creditCents: number }): RenderedEmail {
  const subject = `You earned $5 — thanks for the referral`;
  const amount = formatCad(p.creditCents);
  const text =
    `Hi ${p.name},\n\n` +
    `Your neighbour's bin is clean — thanks for sending them our way.\n\n` +
    `You've got ${amount} credit waiting. It comes off your next clean automatically, ` +
    `and it never expires.\n\n` +
    FOOTER_TEXT;
  const html = brandWrap(
    `<p>Hi ${escapeHtml(p.name)},</p>` +
    `<p>Your neighbour's bin is clean — thanks for sending them our way. 🍀</p>` +
    `<p>You've got <strong>${amount}</strong> credit waiting. It comes off your next clean ` +
    `automatically, and it never expires.</p>`,
  );
  return { subject, html, text };
}
```

- [ ] **Step 5: Call it from `handleDone`**

In `lib/operator-handlers.ts`, add `awardReferralIfEarned` to the `./referral.js` import and `referralEarnedTemplate` to the templates import.

After the settlement branches complete and BEFORE the done email is sent, add:

```typescript
    // Pay the referrer only when money actually moved on this clean. `comped`
    // and an unscanned QR are both excluded — QR is awarded later by the
    // checkout.session.completed webhook, once the customer has really paid.
    const settledForReferral =
      charge.attempted && charge.ok && (charge.amount_cents ?? 0) > 0 && paymentMethod !== 'qr';
    if (settledForReferral) {
      try {
        const award = await awardReferralIfEarned(db, row.customerId);
        if (award.awarded && award.referrerId) {
          const [ref] = await db
            .select({ email: customer.email, name: customer.name, creditCents: customer.creditCents })
            .from(customer)
            .where(eq(customer.id, award.referrerId));
          if (ref && !isPlaceholderEmail(ref.email)) {
            const tpl = referralEarnedTemplate({ name: ref.name, creditCents: ref.creditCents });
            await sendAndLog({
              kind: 'referral_earned',
              to: ref.email,
              subject: tpl.subject,
              body: tpl.text,
              html: tpl.html,
              customerId: award.referrerId,
              visitId,
            });
          }
        }
      } catch (err) {
        console.error('[operator/visit/done] referral award failed (clean unaffected)', err);
      }
    }
```

- [ ] **Step 6: Call it from the QR webhook**

In `lib/billing-webhook.ts`, inside the `checkout.session.completed` branch — after the payment row is marked succeeded and the visit flipped to paid — add the same award call, using the visit's `customerId`. Import `awardReferralIfEarned` from `./referral.js` and `referralEarnedTemplate` from `./email/templates.js`. **Do not import `operator-handlers.ts`** (bundle bloat — see Global Constraints).

- [ ] **Step 7: Run tests**

Run: `npx dotenv -e .env.local -- npx vitest run`
Expected: PASS, full suite

- [ ] **Step 8: Commit**

```bash
git add lib/referral.ts lib/operator-handlers.ts lib/billing-webhook.ts lib/email/templates.ts api/_tests/operator-done.test.ts
git commit -m "Referral: award the referrer once the friend's first clean is paid"
```

---

### Task 8: Surface the code — `/api/me`, `/manage`, `/ops`, done email

**Files:**
- Modify: `api/me.ts` (return referral fields)
- Modify: `manage/components-manage.jsx` (referral card)
- Modify: `lib/operator-handlers.ts` (`stopColumns` + done-email referral block)
- Modify: `lib/email/templates.ts` (`doneTemplate` referral block)
- Modify: `ops/components-ops.jsx` (credit badge on the stop card)
- Test: `api/_tests/me.test.ts`, `lib/_tests/templates.test.ts` (append)

**Interfaces:**
- Consumes: everything above
- Produces: `GET /api/me` returns `referral: { code, credit_cents, referred_count }`

- [ ] **Step 1: Write the failing test**

```typescript
// append to api/_tests/me.test.ts
it('returns the referral code, balance and referred count', async () => {
  // Seed a customer with a code, $5 balance, and one person they referred.
  // (Reuse this file's existing session/seed helpers.)
  const res = mockRes();
  await handler(await authedReq(customerId), res);
  expect(res.statusCode).toBe(200);
  expect(res.body.referral.code).toHaveLength(6);
  expect(res.body.referral.credit_cents).toBe(500);
  expect(res.body.referral.referred_count).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx dotenv -e .env.local -- npx vitest run api/_tests/me.test.ts -t referral`
Expected: FAIL — `Cannot read properties of undefined (reading 'code')`

- [ ] **Step 3: Implement `/api/me`**

Add `referralCode`, `creditCents` to the existing customer select, then before `res.status(200).json({...})`:

```typescript
    const [referredCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customer)
      .where(eq(customer.referredBy, customerId));
```

and add to the response body:

```typescript
      referral: {
        code: me.referralCode,
        credit_cents: me.creditCents,
        referred_count: referredCount?.n ?? 0,
      },
```

- [ ] **Step 4: Add the `/manage` referral card**

In `manage/components-manage.jsx`, render a card showing the code in a large monospace block, a copyable share link `${window.location.origin}/?ref=<code>`, the balance when greater than zero ("$5 credit — comes off your next clean"), and the referred count. Guard on `referral?.code` being present so a legacy row without a code renders nothing rather than `undefined`.

- [ ] **Step 5: Add the referral block to the done email**

In `doneTemplate`, add to the props interface:

```typescript
  /**
   * The customer's own code, so a happy customer can pass it to a neighbour
   * while the clean bin is still in front of them. Rendered BELOW the star row
   * — never above it. The stars route 4-5★ straight to the Google review page
   * and are the strongest growth lever in this email; the referral ask must
   * not displace them.
   */
  referral?: { code: string; shareUrl: string };
```

Build the block:

```typescript
  const referralHtml = p.referral?.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:340px;margin:18px auto 0;border-top:1px solid #eef3ee;padding-top:14px">` +
      `<tr><td style="font-size:14px;color:#3d4a3a;text-align:center">` +
      `Know a neighbour with a bin that needs this? Send them your code and you both get $5.` +
      `</td></tr>` +
      `<tr><td style="text-align:center;padding-top:8px">` +
      `<span style="font-family:monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#1d7a3d">${escapeHtml(p.referral.code)}</span>` +
      `</td></tr>` +
      `<tr><td style="text-align:center;padding-top:6px">` +
      `<a href="${escapeAttr(p.referral.shareUrl)}" style="color:#1d7a3d;font-size:13px">or share your link →</a>` +
      `</td></tr></table>`
    : '';

  const referralText = p.referral?.code
    ? `\n\nKnow a neighbour who needs this? Give them your code ${p.referral.code} — you both get $5. ${p.referral.shareUrl}`
    : '';
```

Splice `referralHtml` into the `brandWrap(...)` call **after** `starsHtml` and `reviewHtml`, and `referralText` into the `text` body after `reviewText`.

Pass it from `handleDone` (add `referralCode: customer.referralCode` to the select that builds `row`):

```typescript
      referral: row.referralCode
        ? { code: row.referralCode, shareUrl: `${siteUrl}/?ref=${encodeURIComponent(row.referralCode)}` }
        : undefined,
```

- [ ] **Step 6: Show credit on the `/ops` stop card**

Add `creditCents` to `stopColumns` in `lib/operator-handlers.ts` and surface it in the operator DTO. In `ops/components-ops.jsx`, render a badge in `StopCard` when the balance is greater than zero: `💳 $5 credit applies`. Shea must see this BEFORE tapping Done so a smaller charge is never a surprise.

- [ ] **Step 7: Run the full suite, typecheck, and parse-check the JSX**

```bash
npm run typecheck
npx dotenv -e .env.local -- npx vitest run
npx esbuild ops/components-ops.jsx --loader:.jsx=jsx --outfile=/dev/null
npx esbuild manage/components-manage.jsx --loader:.jsx=jsx --outfile=/dev/null
```

Expected: typecheck clean, all tests pass, both JSX files parse.

- [ ] **Step 8: Commit**

```bash
git add api/me.ts manage/components-manage.jsx ops/components-ops.jsx lib/operator-handlers.ts lib/email/templates.ts api/_tests/me.test.ts lib/_tests/templates.test.ts
git commit -m "Referral: surface code and balance in /manage, /ops and the done email"
```

---

### Task 9: Booking-form referral entry (link + typed code)

**Files:**
- Modify: `components-booking.jsx` (read `?ref=`, add the optional field, send `referral_code`)
- Test: manual browser verification (no build step; this file has no unit-test harness)

- [ ] **Step 1: Read the code from the URL on mount**

```javascript
  // A neighbour who was texted a link arrives with ?ref=K7M2QX. Someone told
  // over the fence types it instead — both paths must work.
  const [referral, setReferral] = React.useState({ code: '', valid: false, firstName: '' });

  React.useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('ref');
    if (fromUrl) checkReferral(fromUrl);
  }, []);

  async function checkReferral(raw) {
    const code = (raw || '').replace(/[\s-]/g, '').toUpperCase();
    if (code.length !== 6) { setReferral({ code, valid: false, firstName: '' }); return; }
    try {
      const r = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'check_referral', code }),
      });
      const d = await r.json().catch(() => ({}));
      setReferral({ code, valid: !!d.valid, firstName: d.referrer_first_name || '' });
    } catch {
      setReferral({ code, valid: false, firstName: '' });
    }
  }
```

- [ ] **Step 2: Add the optional field to the Your Info step**

A "Referral code (optional)" input that calls `checkReferral` on blur. When `referral.valid`, show a green confirmation: `$5 off, courtesy of {referral.firstName} 🍀`.

- [ ] **Step 3: Send it with the booking**

In `submitBooking`'s payload object:

```javascript
      ...(referral.valid && referral.code ? { referral_code: referral.code } : {}),
```

- [ ] **Step 4: Parse-check and verify in a browser**

```bash
npx esbuild components-booking.jsx --loader:.jsx=jsx --outfile=/dev/null
```

Then against a preview deploy: load `/?ref=<real code>`, confirm the green "$5 off, courtesy of X" line appears; load `/?ref=ZZZZZZ` and confirm no discount is claimed and booking still works.

- [ ] **Step 5: Commit**

```bash
git add components-booking.jsx
git commit -m "Referral: accept a code by link or typed entry in the booking form"
```

---

## Deployment Checklist

Production migration is deliberately NOT part of any task above — it happens once, deliberately, at deploy.

- [ ] `npm run typecheck` clean and the full suite green
- [ ] `find api -name '*.ts' -not -path '*/_tests/*' | wc -l` still returns **12**
- [ ] Apply migration `0011` to **production** Neon:
      `npx drizzle-kit push --force` with prod `DATABASE_URL`/`DATABASE_URL_UNPOOLED`
- [ ] Run the backfill against **production** so existing customers get codes:
      `npx dotenv -e .env.local -- npx tsx db/backfill-referral-codes.ts`
- [ ] Verify: every `customer` row has a non-null `referral_code`; `credit_cents` is 0 everywhere
- [ ] Deploy, then confirm `/api/health` reports `db:true`
- [ ] Live-check `POST /api/book {intent:'check_referral', code:'ZZZZZZ'}` returns `200 {valid:false}`
- [ ] Live-check a real code returns `valid:true` with a first name only
- [ ] Update repo `CLAUDE.md` with a Referral conventions section
- [ ] Append a dated entry to `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md`

## Out of Scope

- **The tip option.** Deferred by design — see the spec. Most likely a Stripe Checkout link riding the existing `checkout.session.completed` webhook, needing no new function.
- **Credit expiry or caps.** Explicitly rejected: credit stacks and never expires.
- **Restoring credit after a refund.** Accepted v1 behaviour; revisit if it ever happens.
- **The `/ops` order-history tab.** Separate, smaller feature — ship it first.
