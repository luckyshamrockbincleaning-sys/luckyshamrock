# Phase 1 — Booking POST Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the booking form on `www.luckyshamrock.ca` actually create rows in Postgres and generate a real cleaning schedule, with stubbed email so Phase 2 only has to wire the real Gmail send.

**Architecture:** Add five tables to `db/schema.ts` (`customer`, `subscription`, `visit`, `magic_link_token`, `notification_log`) plus a sixth `waitlist` table for out-of-area emails. Three pure utility modules (`lib/postal.ts`, `lib/schedule.ts`, `lib/validation.ts`) make the cadence math and request validation cheaply testable. Two new endpoints (`api/book.ts`, `api/waitlist.ts`) wire those utilities to the DB. The fake booking wizard in `components-booking.jsx` is replaced with a real POST submit. Email is stubbed (`lib/email.ts` logs to console) so Phase 1 produces working state without depending on Gmail API setup.

**Tech Stack:** TypeScript / Vercel Functions / Postgres via drizzle / zod / vitest. No new runtime dependencies — `zod` and `date-fns` are already installed (zod) or will be added (date-fns).

**Decisions locked for this phase** (some deviate from the spec; documented inline below):

1. **App-side UUID generation** via `crypto.randomUUID()` rather than `gen_random_uuid()` in Postgres. Avoids the `pgcrypto` extension dependency and keeps one source of truth.
2. **No `updated_at` columns yet.** YAGNI — add when something actually consumes them.
3. **`/api/book` response codes deviate from spec** which said `{ok: true}` always. Returns 200/400/409/422 with structured body so the frontend can show inline errors. Spec is updated by this plan to reflect the new contract.
4. **Cadence math is in weeks**, not calendar months: monthly = 4 weeks, bimonthly = 8 weeks, quarterly = 13 weeks. Keeps the day-of-week aligned with the customer's pickup day forever.
5. **Cleaning day = pickup day + 1 calendar day.** Hard-coded for v1. Configurable via env var later if AB's route ever needs same-day cleans.
6. **Email is stubbed.** `lib/email.ts` writes a row to `notification_log` and prints the would-be content to `console.log`. Phase 2 swaps the print for a real Gmail send without touching anything else.
7. **Idempotency on `/api/book`**: if the submitted email already has an active subscription, return 409 with a "manage your existing booking" message. If it has only a cancelled/no subscription, allow creating a new one. One-off visits are always allowed regardless of subscription state.
8. **`date-fns` adds ~13 KB gzipped** to the function bundle. Acceptable cost for sane date math.

---

## File Structure

Created in this phase:

```
db/schema.ts                            # extended (was empty stub) — six tables + enums
db/migrations/0000_*.sql                # drizzle-generated (filename includes a random word)
db/migrations/meta/0000_snapshot.json   # drizzle-generated
db/migrations/meta/_journal.json        # updated (entries[] gets first entry)

lib/postal.ts                           # isInServiceArea(postalCode) — pure
lib/schedule.ts                         # generateVisitDates(...) — pure
lib/validation.ts                       # zod schemas for /book and /waitlist
lib/email.ts                            # stubbed sender + notification_log writer

api/book.ts                             # POST /api/book
api/waitlist.ts                         # POST /api/waitlist

api/_tests/_helpers.ts                  # extracted mockReq/mockRes
api/_tests/book.test.ts                 # integration tests (real DB) for /api/book
api/_tests/book.failure.test.ts         # unit tests (mocked DB) for /api/book error paths
api/_tests/waitlist.test.ts             # integration test for /api/waitlist
lib/_tests/postal.test.ts               # unit tests for postal check
lib/_tests/schedule.test.ts             # unit tests for cadence math
lib/_tests/email.test.ts                # unit tests for stubbed email
```

Modified in this phase:

```
db/client.ts                            # export sql helper for cleanup in tests (small addition)
api/_tests/health.test.ts               # use new shared helpers
api/_tests/health.failure.test.ts       # use new shared helpers
components-booking.jsx                  # replace fake submit with real POST → /api/book
package.json                            # add `date-fns` dependency
.env.example                            # no change — Phase 1 adds no env vars
```

Untouched (do not edit):

```
index.html, app.jsx, components-core.jsx, components-mid.jsx, components-footer.jsx
tweaks-panel.jsx, styles.css
assets/, uploads/
api/health.ts
```

---

## Pre-work: extract test helpers

The Phase 0 final review flagged that `mockReq`/`mockRes`/`MockRes` would be duplicated as soon as a second endpoint test landed. We're about to land two more endpoints with multiple test files. Pull the helpers into `api/_tests/_helpers.ts` BEFORE writing any new tests so the new tests are written against the shared module from day one.

---

## Task 1: Extract test helpers to `api/_tests/_helpers.ts`

**Files:**
- Create: `api/_tests/_helpers.ts`
- Modify: `api/_tests/health.test.ts`
- Modify: `api/_tests/health.failure.test.ts`

- [ ] **Step 1: Create the helpers module**

`api/_tests/_helpers.ts`:

```typescript
/**
 * Shared test helpers for Vercel function tests.
 *
 * Tests should construct request/response mocks via these factories rather than
 * hand-rolling per test file. The handler's parameter types are recovered via
 * a generic so callers don't have to import @vercel/node types directly.
 */

export type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (payload: unknown) => MockRes;
};

export function mockReq<H extends (...args: any[]) => any>(
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Parameters<H>[0] {
  const { method = 'GET', body, query = {} } = init;
  return { method, body, query, headers: {} } as unknown as Parameters<H>[0];
}

export function mockRes<H extends (...args: any[]) => any>(): MockRes & Parameters<H>[1] {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res as MockRes & Parameters<H>[1];
}
```

Notes for the implementer:
- The generic `H` parameter lets test files pass their handler's type so the mocks fit without casts.
- `body` and `query` are populated now because `/api/book` will need them. `health.ts` ignores both — no behavior change.
- The double-cast `as unknown as ...` is the same pattern used in the existing tests.

- [ ] **Step 2: Update `api/_tests/health.test.ts` to use the helpers**

Replace the file with:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import handler from '../health.js';
import { mockReq, mockRes } from './_helpers.js';

describe('GET /api/health', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set (run `vercel env pull .env.local`)');
    }
  });

  it('returns 200 with status=ok and db=true when DB is reachable', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('ok');
    expect(body.db).toBe(true);
    expect(typeof body.time).toBe('string');
    expect(body.error).toBe(null);
  });

  it('returns 405 for non-GET methods', async () => {
    const req = mockReq<typeof handler>({ method: 'POST' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 3: Update `api/_tests/health.failure.test.ts` to use the helpers**

Replace the file with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../../db/client.js', () => ({
  getRawClient: () => mockSql,
}));

const { default: handler } = await import('../health.js');
const { mockReq, mockRes } = await import('./_helpers.js');

describe('GET /api/health — failure modes', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    mockSql.mockReset();
  });

  it('returns 503 with db=false and error=null when DB returns unexpected data', async () => {
    mockSql.mockResolvedValueOnce([{ ok: 0 }]);
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
    expect(body.error).toBe(null);
    expect(typeof body.time).toBe('string');
  });

  it('returns 503 with db=false and an error message when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
    expect(body.error).toBe('connection refused');
    expect(typeof body.time).toBe('string');
  });
});
```

Note the `_helpers.js` import is dynamic (`await import(...)`) in this file because `vi.mock` must hoist above all top-level imports of the handler.

- [ ] **Step 4: Verify tests still pass**

Run: `npm test`
Expected: `Test Files 2 passed (2), Tests 4 passed (4)`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/homie/Documents/luckyshamrock
git add api/_tests/_helpers.ts api/_tests/health.test.ts api/_tests/health.failure.test.ts
git commit -m "$(cat <<'EOF'
refactor(tests): extract mock helpers to api/_tests/_helpers.ts

Both health tests now consume mockReq/mockRes from a shared module
instead of hand-rolling. Helpers are generic over the handler's type
so tests in subsequent phases don't need to import @vercel/node types
directly.

Pre-work for Phase 1 (booking POST + waitlist endpoints land next).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `date-fns` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install date-fns**

Run: `npm install date-fns@^4.1.0`
Expected: `added 1 package`. `package.json` now lists `"date-fns": "^4.1.0"` under `dependencies` (NOT devDependencies — it ships with the function bundle).

- [ ] **Step 2: Confirm package-lock updated**

Run: `git diff package.json package-lock.json --stat`
Expected: both files modified, lockfile has many lines (it adds the date-fns subtree).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add date-fns@^4 for cadence date math

Adds ~13 KB gzipped to the function bundle. Used by lib/schedule.ts
for sane date arithmetic (addDays, addWeeks, getDay, etc.). Pure ESM.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Define the schema in `db/schema.ts`

**Files:**
- Modify: `db/schema.ts` (was the `export {}` stub)

- [ ] **Step 1: Replace `db/schema.ts` with the full schema**

```typescript
import {
  pgTable,
  text,
  varchar,
  integer,
  timestamp,
  date,
  pgEnum,
  uuid,
  unique,
  index,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────

export const pickupDayEnum = pgEnum('pickup_day', [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
]);

export const cadenceEnum = pgEnum('cadence', [
  'monthly',
  'bimonthly',
  'quarterly',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'paused',
  'cancelled',
]);

export const visitStatusEnum = pgEnum('visit_status', [
  'scheduled',
  'heading_there',
  'done',
  'skipped',
  'cancelled',
]);

export const notificationKindEnum = pgEnum('notification_kind', [
  'magic_link',
  'booking_confirmed',
  'on_our_way',
  'done',
  'day_before',
]);

// ─────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────

export const customer = pgTable(
  'customer',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    street: text('street').notNull(),
    city: text('city').notNull(),
    postalCode: varchar('postal_code', { length: 10 }).notNull(),
    pickupDay: pickupDayEnum('pickup_day').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: unique('customer_email_unique').on(t.email),
  }),
);

export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    cadence: cadenceEnum('cadence').notNull(),
    binCount: integer('bin_count').notNull(),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    startedOn: date('started_on', { mode: 'date' }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('subscription_customer_idx').on(t.customerId),
  }),
);

export const visit = pgTable(
  'visit',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    subscriptionId: uuid('subscription_id').references(() => subscription.id, {
      onDelete: 'set null',
    }),
    scheduledFor: date('scheduled_for', { mode: 'date' }).notNull(),
    status: visitStatusEnum('status').notNull().default('scheduled'),
    headingThereAt: timestamp('heading_there_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('visit_customer_idx').on(t.customerId),
    scheduledForIdx: index('visit_scheduled_for_idx').on(t.scheduledFor),
    statusIdx: index('visit_status_idx').on(t.status),
  }),
);

export const magicLinkToken = pgTable('magic_link_token', {
  token: text('token').primaryKey(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customer.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    visitId: uuid('visit_id').references(() => visit.id, { onDelete: 'set null' }),
    kind: notificationKindEnum('kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    error: text('error'),
    gmailMessageId: text('gmail_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('notification_customer_idx').on(t.customerId),
    visitKindUnique: unique('notification_visit_kind_unique').on(t.visitId, t.kind),
  }),
);

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  postalCode: varchar('postal_code', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Notes on design choices the implementer should NOT change:

- **No `gen_random_uuid()` default** — UUIDs are generated app-side via `crypto.randomUUID()`. This avoids the pgcrypto extension dependency. Drizzle's `.defaultRandom()` is intentionally absent.
- **`notification_visit_kind_unique` on `(visit_id, kind)`** is the idempotency key that prevents double-sending when the operator double-taps "on my way". The unique constraint enforces it at the DB level so even race conditions can't sneak through.
- **`onDelete: 'restrict'`** preserves history — you can't delete a customer who has visits, you have to cancel.
- **`onDelete: 'set null'`** for `subscription_id` on `visit` allows cancelling a subscription without losing the visit history (visits become unanchored one-offs in the data model).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. No type errors from drizzle introspection.

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected output mentions one new SQL file (filename like `0000_<adjective>_<noun>.sql`) under `db/migrations/`, and `meta/0000_snapshot.json`. The `meta/_journal.json` gets one entry appended.

- [ ] **Step 4: Inspect the generated SQL**

Run: `ls db/migrations/*.sql && head -40 db/migrations/0000_*.sql`
Expected: six `CREATE TABLE` statements, five `CREATE TYPE ... AS ENUM` statements, plus indexes. No `CREATE EXTENSION pgcrypto` (we're not using `gen_random_uuid`).

If the SQL contains `gen_random_uuid()`, the schema accidentally used `.defaultRandom()` somewhere — go back to Step 1 and remove it.

- [ ] **Step 5: Push the migration to Neon**

Run: `npm run db:push`
Expected: drizzle-kit prompts to confirm the changes; type `y` and Enter. Output shows tables and indexes being created.

If drizzle-kit complains about a `text → uuid` cast or similar destructive change, that means the local snapshot disagrees with Neon. Run `npm run db:push -- --force` only after confirming with controller — this can drop tables.

- [ ] **Step 6: Verify in Neon**

Use the Neon SQL Editor (console.neon.tech → project → SQL Editor) or `psql`:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Expected rows: `customer`, `magic_link_token`, `notification_log`, `subscription`, `visit`, `waitlist` (plus drizzle's own `__drizzle_migrations` bookkeeping).

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations/
git commit -m "$(cat <<'EOF'
feat(db): add six tables for booking domain

customer, subscription, visit, magic_link_token, notification_log,
waitlist — covers Phase 1 (booking POST + waitlist) plus the auth and
notification tables that Phase 2-3 will fill in.

Design choices:
- UUIDs generated app-side via crypto.randomUUID() (no pgcrypto dep).
- visit.subscription_id is nullable so one-off visits exist standalone
  AND cancelling a subscription preserves its visit history.
- (visit_id, kind) unique on notification_log enforces idempotency at
  the DB layer — double-tapping "on my way" cannot send twice.
- Indexes on customer_id and scheduled_for support the operator's
  "today's stops" and "customer's upcoming visits" queries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `lib/postal.ts` — service-area check (TDD)

**Files:**
- Create: `lib/postal.ts`
- Create: `lib/_tests/postal.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/postal.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isInServiceArea, normalizePostalCode } from '../postal.js';

describe('normalizePostalCode', () => {
  it('uppercases and strips internal whitespace', () => {
    expect(normalizePostalCode('t8l 1a1')).toBe('T8L1A1');
    expect(normalizePostalCode('  t8l1a1  ')).toBe('T8L1A1');
    expect(normalizePostalCode('T8L-1A1')).toBe('T8L1A1');
  });

  it('returns empty string for null-ish input', () => {
    expect(normalizePostalCode('')).toBe('');
    expect(normalizePostalCode('   ')).toBe('');
  });
});

describe('isInServiceArea', () => {
  it('accepts any postal code whose normalized form starts with T8L', () => {
    expect(isInServiceArea('T8L 1A1')).toBe(true);
    expect(isInServiceArea('t8l2b3')).toBe(true);
    expect(isInServiceArea('T8L 9Z9')).toBe(true);
  });

  it('rejects postal codes outside the T8L prefix', () => {
    expect(isInServiceArea('T5J 1A1')).toBe(false); // Edmonton
    expect(isInServiceArea('T6E 2H4')).toBe(false); // Edmonton
    expect(isInServiceArea('K1A 0B1')).toBe(false); // Ottawa
    expect(isInServiceArea('')).toBe(false);
    expect(isInServiceArea('GARBAGE')).toBe(false);
  });

  it('honors SERVICE_POSTAL_PREFIX env override when set', () => {
    const prev = process.env.SERVICE_POSTAL_PREFIX;
    process.env.SERVICE_POSTAL_PREFIX = 'T5J';
    try {
      expect(isInServiceArea('T5J 1A1')).toBe(true);
      expect(isInServiceArea('T8L 1A1')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SERVICE_POSTAL_PREFIX;
      else process.env.SERVICE_POSTAL_PREFIX = prev;
    }
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- lib/_tests/postal.test.ts`
Expected: module-not-found error for `../postal.js`. Do not commit.

- [ ] **Step 3: Implement `lib/postal.ts`**

```typescript
/**
 * Postal-code utilities for Lucky Shamrock's service area.
 *
 * Default service area is Fort Saskatchewan (postal prefix `T8L`). The
 * prefix can be overridden at runtime via the `SERVICE_POSTAL_PREFIX`
 * env var so AB can test other cities without redeploying.
 */

const DEFAULT_PREFIX = 'T8L';

export function normalizePostalCode(input: string): string {
  if (!input) return '';
  return input.replace(/[\s\-]/g, '').toUpperCase();
}

export function isInServiceArea(postalCode: string): boolean {
  const normalized = normalizePostalCode(postalCode);
  if (!normalized) return false;
  const prefix = (process.env.SERVICE_POSTAL_PREFIX ?? DEFAULT_PREFIX).toUpperCase();
  return normalized.startsWith(prefix);
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npm test -- lib/_tests/postal.test.ts`
Expected: 7 tests passing (2 in normalizePostalCode, 3 in isInServiceArea).

Wait — recount: 2 in normalize, 3 in isInServiceArea = 5 tests. Verify your terminal shows 5.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/postal.ts lib/_tests/postal.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add postal-code service-area check

normalizePostalCode strips whitespace, hyphens, and uppercases input
(handles common user typo patterns: 't8l 1a1', 'T8L-1A1', '  T8L1A1 ').

isInServiceArea checks the normalized prefix against SERVICE_POSTAL_PREFIX
env var (default 'T8L' for Fort Saskatchewan). The override exists so AB
can flip the gate to test a different city without code changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `lib/schedule.ts` — cadence date math (TDD)

**Files:**
- Create: `lib/schedule.ts`
- Create: `lib/_tests/schedule.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/schedule.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateVisitDates, type PickupDay, type Cadence } from '../schedule.js';

// Helpers
function d(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('generateVisitDates', () => {
  describe('one-off (count=1)', () => {
    it('schedules a single visit on (pickup_day + 1) of the following week when start_date is the pickup day', () => {
      // Wed Apr 1, 2026. Pickup = wed. Clean = next thu (apr 9), since today IS pickup day.
      const dates = generateVisitDates({
        startDate: d('2026-04-01'),
        pickupDay: 'wednesday',
        cadence: 'monthly',
        count: 1,
      });
      expect(dates).toHaveLength(1);
      expect(iso(dates[0]!)).toBe('2026-04-09');
    });

    it('schedules the next clean day after start_date when start_date is earlier in the week', () => {
      // Mon Apr 6, 2026. Pickup = wed. Clean = next thu (apr 9).
      const dates = generateVisitDates({
        startDate: d('2026-04-06'),
        pickupDay: 'wednesday',
        cadence: 'monthly',
        count: 1,
      });
      expect(iso(dates[0]!)).toBe('2026-04-09');
    });
  });

  describe('recurring (count > 1)', () => {
    it('monthly produces 12 visits, 28 days apart', () => {
      const dates = generateVisitDates({
        startDate: d('2026-04-01'), // wednesday
        pickupDay: 'wednesday',
        cadence: 'monthly',
        count: 12,
      });
      expect(dates).toHaveLength(12);
      expect(iso(dates[0]!)).toBe('2026-04-09'); // next thursday
      expect(iso(dates[1]!)).toBe('2026-05-07'); // +28 days
      expect(iso(dates[2]!)).toBe('2026-06-04');
      expect(iso(dates[11]!)).toBe('2027-03-11'); // 11 * 28 = 308 days after first
    });

    it('bimonthly produces 6 visits, 56 days apart', () => {
      const dates = generateVisitDates({
        startDate: d('2026-04-01'),
        pickupDay: 'wednesday',
        cadence: 'bimonthly',
        count: 6,
      });
      expect(dates).toHaveLength(6);
      expect(iso(dates[0]!)).toBe('2026-04-09');
      expect(iso(dates[1]!)).toBe('2026-06-04'); // +56 days
    });

    it('quarterly produces 4 visits, 91 days apart', () => {
      const dates = generateVisitDates({
        startDate: d('2026-04-01'),
        pickupDay: 'wednesday',
        cadence: 'quarterly',
        count: 4,
      });
      expect(dates).toHaveLength(4);
      expect(iso(dates[0]!)).toBe('2026-04-09');
      expect(iso(dates[1]!)).toBe('2026-07-09'); // +91 days
    });
  });

  describe('day-of-week alignment', () => {
    const cases: Array<{ pickup: PickupDay; expectedClean: string }> = [
      { pickup: 'monday',    expectedClean: '2026-04-07' }, // Tue Apr 7
      { pickup: 'tuesday',   expectedClean: '2026-04-08' }, // Wed Apr 8
      { pickup: 'wednesday', expectedClean: '2026-04-09' }, // Thu Apr 9
      { pickup: 'thursday',  expectedClean: '2026-04-03' }, // Fri Apr 3
      { pickup: 'friday',    expectedClean: '2026-04-04' }, // Sat Apr 4
    ];

    cases.forEach(({ pickup, expectedClean }) => {
      it(`pickup_day=${pickup} schedules clean on the right weekday starting Apr 1 2026 (wed)`, () => {
        const dates = generateVisitDates({
          startDate: d('2026-04-01'),
          pickupDay: pickup,
          cadence: 'monthly',
          count: 1,
        });
        expect(iso(dates[0]!)).toBe(expectedClean);
      });
    });
  });

  describe('input validation', () => {
    it('throws when count is < 1', () => {
      expect(() =>
        generateVisitDates({
          startDate: d('2026-04-01'),
          pickupDay: 'wednesday',
          cadence: 'monthly',
          count: 0,
        }),
      ).toThrow(/count must be at least 1/i);
    });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- lib/_tests/schedule.test.ts`
Expected: module-not-found error. Do not commit.

- [ ] **Step 3: Implement `lib/schedule.ts`**

```typescript
import { addDays, addWeeks, getDay } from 'date-fns';

export type PickupDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
export type Cadence = 'monthly' | 'bimonthly' | 'quarterly';

const DAY_INDEX: Record<PickupDay, number> = {
  // date-fns getDay returns 0=Sunday..6=Saturday
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
};

const CADENCE_WEEKS: Record<Cadence, number> = {
  monthly: 4,
  bimonthly: 8,
  quarterly: 13,
};

/**
 * Compute the next calendar date matching `targetDow` strictly AFTER `from`.
 * If `from` itself is the target day, returns 7 days later (the NEXT occurrence).
 */
function nextWeekday(from: Date, targetDow: number): Date {
  const fromDow = getDay(from);
  let delta = targetDow - fromDow;
  if (delta <= 0) delta += 7;
  return addDays(from, delta);
}

export interface GenerateVisitDatesInput {
  startDate: Date;
  pickupDay: PickupDay;
  cadence: Cadence;
  count: number;
}

/**
 * Returns an array of `count` dates starting with the first cleaning day
 * after `startDate`. Cleaning day = customer's pickup day + 1.
 *
 * Subsequent dates are spaced by CADENCE_WEEKS[cadence] weeks each, so the
 * day-of-week stays aligned forever.
 */
export function generateVisitDates(input: GenerateVisitDatesInput): Date[] {
  const { startDate, pickupDay, cadence, count } = input;
  if (count < 1) {
    throw new Error('count must be at least 1');
  }

  const pickupDow = DAY_INDEX[pickupDay];
  const nextPickup = nextWeekday(startDate, pickupDow);
  const firstClean = addDays(nextPickup, 1);

  const dates: Date[] = [firstClean];
  const stepWeeks = CADENCE_WEEKS[cadence];
  for (let i = 1; i < count; i++) {
    dates.push(addWeeks(firstClean, i * stepWeeks));
  }
  return dates;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- lib/_tests/schedule.test.ts`
Expected: 11 tests passing (2 one-off + 3 recurring + 5 day-of-week + 1 validation = 11).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/schedule.ts lib/_tests/schedule.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add cadence-based visit date generator

generateVisitDates({startDate, pickupDay, cadence, count}) returns the
first N cleaning dates following the customer's signup. First clean is
(pickup_day + 1) on the next calendar week containing that pickup. After
that, each visit is CADENCE_WEEKS apart so the day-of-week stays aligned.

monthly=4w, bimonthly=8w, quarterly=13w. Hard-coded; spec doesn't allow
custom cadences for v1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `lib/email.ts` — stubbed email sender (TDD)

**Files:**
- Create: `lib/email.ts`
- Create: `lib/_tests/email.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/email.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, type EmailKind } from '../email.js';

describe('sendEmail (stubbed for Phase 1)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns ok=true and a synthetic gmail_message_id', async () => {
    const result = await sendEmail({
      kind: 'booking_confirmed',
      to: 'sam@example.com',
      subject: 'You are booked',
      body: 'See you Thursday.',
    });
    expect(result.ok).toBe(true);
    expect(result.gmailMessageId).toMatch(/^stub-[a-f0-9-]{36}$/);
    expect(result.error).toBeUndefined();
  });

  it('logs the email payload via console.log so AB can see what would have shipped', async () => {
    await sendEmail({
      kind: 'magic_link',
      to: 'sam@example.com',
      subject: 'Manage your booking',
      body: 'Click here: https://...',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = logSpy.mock.calls[0]!;
    expect(tag).toBe('[email:stub]');
    expect(payload).toMatchObject({
      kind: 'magic_link',
      to: 'sam@example.com',
      subject: 'Manage your booking',
    });
  });

  it('rejects an obviously malformed recipient address', async () => {
    const result = await sendEmail({
      kind: 'booking_confirmed',
      to: 'not-an-email',
      subject: '',
      body: '',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid recipient/i);
    expect(result.gmailMessageId).toBeUndefined();
  });

  it('accepts all five EmailKind values without throwing', async () => {
    const kinds: EmailKind[] = ['magic_link', 'booking_confirmed', 'on_our_way', 'done', 'day_before'];
    for (const kind of kinds) {
      const result = await sendEmail({
        kind,
        to: 'sam@example.com',
        subject: 's',
        body: 'b',
      });
      expect(result.ok).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- lib/_tests/email.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `lib/email.ts`**

```typescript
/**
 * Email sender. STUBBED for Phase 1: writes the would-be email to console
 * and returns a synthetic gmail_message_id. Phase 2 swaps the body of
 * sendEmail() for a real Gmail API call without changing the signature.
 *
 * Callers should also write a notification_log row themselves; this module
 * only handles the send side and reports whether it succeeded.
 */

export type EmailKind =
  | 'magic_link'
  | 'booking_confirmed'
  | 'on_our_way'
  | 'done'
  | 'day_before';

export interface SendEmailInput {
  kind: EmailKind;
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { kind, to, subject, body } = input;

  if (!SIMPLE_EMAIL_RE.test(to)) {
    return { ok: false, error: `invalid recipient: ${to}` };
  }

  console.log('[email:stub]', { kind, to, subject, bodyPreview: body.slice(0, 80) });

  return {
    ok: true,
    gmailMessageId: `stub-${crypto.randomUUID()}`,
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- lib/_tests/email.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/email.ts lib/_tests/email.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add stubbed email sender for Phase 1

sendEmail({kind, to, subject, body}) returns a SendEmailResult and prints
the payload via console.log with the [email:stub] tag so AB can see what
would have shipped during local dev / staging. Synthetic gmail_message_id
of the form 'stub-<uuid>' allows the notification_log to record sends
even when no real Gmail call happened yet.

Phase 2 will swap the body of sendEmail() for a real Gmail API call. The
signature and SendEmailResult shape are designed to survive that change
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `lib/validation.ts` — zod schemas (TDD)

**Files:**
- Create: `lib/validation.ts`
- Create: `lib/_tests/validation.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/_tests/validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { bookRequestSchema, waitlistRequestSchema } from '../validation.js';

describe('bookRequestSchema', () => {
  const valid = {
    name: 'Sam Customer',
    email: 'sam@example.com',
    phone: '780-555-0100',
    street: '123 Main St',
    city: 'Fort Saskatchewan',
    postal_code: 'T8L 1A1',
    pickup_day: 'wednesday',
    bin_count: 2,
    plan: 'monthly',
  };

  it('accepts a complete, valid recurring booking', () => {
    const result = bookRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts a one-off booking with oneoff_date', () => {
    const result = bookRequestSchema.safeParse({
      ...valid,
      plan: 'oneoff',
      oneoff_date: '2026-06-15',
    });
    expect(result.success).toBe(true);
  });

  it('rejects one-off booking without oneoff_date', () => {
    const result = bookRequestSchema.safeParse({ ...valid, plan: 'oneoff' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('oneoff_date'));
      expect(issue).toBeDefined();
    }
  });

  it('rejects recurring booking that includes oneoff_date', () => {
    const result = bookRequestSchema.safeParse({
      ...valid,
      plan: 'monthly',
      oneoff_date: '2026-06-15',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed email', () => {
    expect(bookRequestSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects bin_count outside 1-3', () => {
    expect(bookRequestSchema.safeParse({ ...valid, bin_count: 0 }).success).toBe(false);
    expect(bookRequestSchema.safeParse({ ...valid, bin_count: 4 }).success).toBe(false);
  });

  it('rejects invalid pickup_day', () => {
    expect(bookRequestSchema.safeParse({ ...valid, pickup_day: 'saturday' }).success).toBe(false);
  });

  it('rejects invalid plan', () => {
    expect(bookRequestSchema.safeParse({ ...valid, plan: 'weekly' }).success).toBe(false);
  });

  it('allows omitting phone', () => {
    const { phone: _, ...withoutPhone } = valid;
    expect(bookRequestSchema.safeParse(withoutPhone).success).toBe(true);
  });

  it('trims and lowercases email', () => {
    const result = bookRequestSchema.safeParse({ ...valid, email: '  SAM@Example.com  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('sam@example.com');
    }
  });
});

describe('waitlistRequestSchema', () => {
  it('accepts a valid email + postal code pair', () => {
    expect(
      waitlistRequestSchema.safeParse({ email: 'sam@example.com', postal_code: 'T5J 1A1' }).success,
    ).toBe(true);
  });

  it('rejects a missing email', () => {
    expect(waitlistRequestSchema.safeParse({ postal_code: 'T5J 1A1' }).success).toBe(false);
  });

  it('rejects a missing postal code', () => {
    expect(waitlistRequestSchema.safeParse({ email: 'sam@example.com' }).success).toBe(false);
  });

  it('lowercases email', () => {
    const result = waitlistRequestSchema.safeParse({ email: 'SAM@example.com', postal_code: 'T5J' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('sam@example.com');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- lib/_tests/validation.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `lib/validation.ts`**

```typescript
import { z } from 'zod';

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('invalid email');

const pickupDay = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
const cadence = z.enum(['monthly', 'bimonthly', 'quarterly']);
const planField = z.enum(['oneoff', 'monthly', 'bimonthly', 'quarterly']);
const binCount = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const bookRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'name required').max(120),
    email: emailField,
    phone: z.string().trim().min(1).max(40).optional(),
    street: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(80),
    postal_code: z.string().trim().min(1).max(10),
    pickup_day: pickupDay,
    bin_count: binCount,
    plan: planField,
    oneoff_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'oneoff_date must be YYYY-MM-DD').optional(),
  })
  .refine(
    (data) => (data.plan === 'oneoff' ? data.oneoff_date !== undefined : data.oneoff_date === undefined),
    {
      message: 'oneoff_date is required when plan=oneoff and forbidden otherwise',
      path: ['oneoff_date'],
    },
  );

export type BookRequest = z.infer<typeof bookRequestSchema>;

export const waitlistRequestSchema = z.object({
  email: emailField,
  postal_code: z.string().trim().min(1).max(10),
});

export type WaitlistRequest = z.infer<typeof waitlistRequestSchema>;

export { cadence, pickupDay };
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- lib/_tests/validation.test.ts`
Expected: 14 tests passing.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/validation.ts lib/_tests/validation.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add zod schemas for booking + waitlist requests

bookRequestSchema enforces:
- emails are trimmed + lowercased
- bin_count is 1, 2, or 3 (literal union)
- pickup_day is mon-fri only (no weekend service)
- plan is oneoff or one of the three cadences
- oneoff_date is required iff plan=oneoff, must be YYYY-MM-DD

waitlistRequestSchema is the minimal lead-capture shape for postal codes
outside the service area.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Test DB cleanup helper

**Files:**
- Modify: `db/client.ts`
- Create: `api/_tests/_db_cleanup.ts`

Integration tests need a way to wipe rows between tests so a previous test's customer doesn't trip the email-unique constraint in the next one. We'll add a tiny helper that truncates the booking-domain tables.

- [ ] **Step 1: Add a small helper to `db/client.ts`**

Add this export at the bottom of `db/client.ts` (the rest of the file stays as is):

```typescript
/**
 * Test-only helper. Truncates all booking-domain tables in dependency order.
 * Do NOT call from application code. Imported only by integration tests.
 */
export async function truncateAllForTests(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('truncateAllForTests must not run in production');
  }
  const sql = getRawClient();
  await sql`TRUNCATE
    notification_log,
    magic_link_token,
    visit,
    subscription,
    customer,
    waitlist
  CASCADE`;
}
```

- [ ] **Step 2: Create `api/_tests/_db_cleanup.ts`** as a thin re-export so tests don't reach into `db/`:

```typescript
export { truncateAllForTests } from '../../db/client.js';
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add db/client.ts api/_tests/_db_cleanup.ts
git commit -m "$(cat <<'EOF'
test: add truncateAllForTests helper for integration tests

Booking integration tests create real customer rows; without cleanup,
the second test in a run hits the email-unique constraint. The helper
TRUNCATEs the six domain tables in CASCADE order and refuses to run
when NODE_ENV=production.

Re-exported via api/_tests/_db_cleanup.ts so tests stay decoupled
from the db/ path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `POST /api/book` — happy path (integration test, TDD)

**Files:**
- Create: `api/book.ts`
- Create: `api/_tests/book.test.ts`

- [ ] **Step 1: Write the failing test**

`api/_tests/book.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../book.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set (run `vercel env pull .env.local`)');
  }
});

beforeEach(async () => {
  await truncateAllForTests();
});

const validBody = {
  name: 'Sam Customer',
  email: 'sam@example.com',
  phone: '780-555-0100',
  street: '123 Main St',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 1A1',
  pickup_day: 'wednesday',
  bin_count: 2,
};

describe('POST /api/book — happy path', () => {
  it('creates a recurring monthly subscription and 12 visits', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'monthly' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; customer_id: string; first_visit_date: string };
    expect(body.status).toBe('ok');
    expect(body.customer_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.first_visit_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam@example.com'));
    expect(c).toBeDefined();
    expect(c!.name).toBe('Sam Customer');
    expect(c!.postalCode).toBe('T8L1A1');

    const subs = await db.select().from(subscription).where(eq(subscription.customerId, c!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cadence).toBe('monthly');
    expect(subs[0]!.binCount).toBe(2);

    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(12);
  });

  it('creates a one-off visit with no subscription', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'oneoff', oneoff_date: '2026-07-15' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);

    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam@example.com'));
    expect(c).toBeDefined();

    const subs = await db.select().from(subscription).where(eq(subscription.customerId, c!.id));
    expect(subs).toHaveLength(0);

    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(1);
    expect(visits[0]!.subscriptionId).toBeNull();
    expect(visits[0]!.scheduledFor.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('returns 405 for non-POST', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- api/_tests/book.test.ts`
Expected: module not found for `../book.js`.

- [ ] **Step 3: Implement `api/book.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customer, subscription, visit } from '../db/schema.js';
import { bookRequestSchema } from '../lib/validation.js';
import { isInServiceArea, normalizePostalCode } from '../lib/postal.js';
import { generateVisitDates, type Cadence } from '../lib/schedule.js';
import { sendEmail } from '../lib/email.js';

const RECURRING_COUNT: Record<Cadence, number> = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Validation
  const parsed = bookRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: 'invalid',
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  const data = parsed.data;

  // Service-area check
  if (!isInServiceArea(data.postal_code)) {
    res.status(422).json({
      status: 'out_of_area',
      message: "We don't serve your area yet. Join the waitlist and we'll let you know when we do.",
    });
    return;
  }

  const db = getDb();

  try {
    // Look up existing customer by email
    const [existing] = await db
      .select()
      .from(customer)
      .where(eq(customer.email, data.email));

    let customerId: string;
    if (existing) {
      // Check for active subscription
      const [activeSub] = await db
        .select()
        .from(subscription)
        .where(eq(subscription.customerId, existing.id));
      if (activeSub && activeSub.status === 'active') {
        res.status(409).json({
          status: 'already_subscribed',
          message: 'This email is already on an active plan. Check your inbox for the manage link or visit /manage.',
        });
        return;
      }
      customerId = existing.id;
    } else {
      customerId = crypto.randomUUID();
      await db.insert(customer).values({
        id: customerId,
        email: data.email,
        name: data.name,
        phone: data.phone ?? null,
        street: data.street,
        city: data.city,
        postalCode: normalizePostalCode(data.postal_code),
        pickupDay: data.pickup_day,
      });
    }

    // Generate visits
    let visitDates: Date[];
    let subscriptionId: string | null = null;

    if (data.plan === 'oneoff') {
      visitDates = [new Date(`${data.oneoff_date!}T12:00:00Z`)];
    } else {
      subscriptionId = crypto.randomUUID();
      const startDate = new Date();
      await db.insert(subscription).values({
        id: subscriptionId,
        customerId,
        cadence: data.plan,
        binCount: data.bin_count,
        startedOn: startDate,
      });
      visitDates = generateVisitDates({
        startDate,
        pickupDay: data.pickup_day,
        cadence: data.plan,
        count: RECURRING_COUNT[data.plan],
      });
    }

    await db.insert(visit).values(
      visitDates.map((scheduledFor) => ({
        id: crypto.randomUUID(),
        customerId,
        subscriptionId,
        scheduledFor,
      })),
    );

    // Stubbed emails (Phase 2 wires real Gmail send)
    const firstVisitDate = visitDates[0]!.toISOString().slice(0, 10);
    await sendEmail({
      kind: 'booking_confirmed',
      to: data.email,
      subject: 'You are booked with Lucky Shamrock',
      body: `Hi ${data.name},\n\nYour first clean is scheduled for ${firstVisitDate}.\n\nManage your booking: https://www.luckyshamrock.ca/manage`,
    });
    await sendEmail({
      kind: 'magic_link',
      to: data.email,
      subject: 'Your Lucky Shamrock manage link',
      body: `Click to manage: https://www.luckyshamrock.ca/manage?token=PLACEHOLDER`,
    });

    res.status(200).json({
      status: 'ok',
      customer_id: customerId,
      first_visit_date: firstVisitDate,
    });
  } catch (err) {
    console.error('[book] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- api/_tests/book.test.ts`
Expected: 3 tests passing.

If the integration test fails with "permission denied for schema public" or similar, the Neon role may need GRANT — check that `neondb_owner` has rights on the booking tables (it should by default for tables you created via drizzle).

- [ ] **Step 5: Run full test suite to make sure nothing else broke**

Run: `npm test`
Expected: all tests passing (`/api/health` + `/api/book` + the lib tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add api/book.ts api/_tests/book.test.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /api/book — happy paths

Recurring subscriptions (monthly/bimonthly/quarterly) generate 12/6/4
visits respectively, all aligned to the customer's pickup day + 1.
One-off bookings create a single visit on the requested date with no
subscription anchor.

Response: 200 with {status, customer_id, first_visit_date}. 405 for
non-POST. 400/422/409 paths covered by the next dispatch (failure tests).

Stubbed email sends fire on success — both booking_confirmed and an
initial magic_link with a placeholder token. Real Gmail send + real
magic-link tokens land in Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `POST /api/book` — failure paths (unit tests with mocked DB)

**Files:**
- Create: `api/_tests/book.failure.test.ts`

These tests don't need a real DB — they cover the validation, postal-code, and idempotency branches that fail BEFORE the first DB call (or with controllable DB responses).

- [ ] **Step 1: Write the failing test**

`api/_tests/book.failure.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the db client BEFORE importing the handler.
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockWhere = vi.fn();
const mockValues = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    select: () => ({ from: mockFrom }),
    insert: () => ({ values: mockValues }),
  }),
}));

vi.mock('../../lib/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, gmailMessageId: 'stub' }),
}));

const { default: handler } = await import('../book.js');
const { mockReq, mockRes } = await import('./_helpers.js');

const validBody = {
  name: 'Sam Customer',
  email: 'sam@example.com',
  street: '123 Main St',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 1A1',
  pickup_day: 'wednesday' as const,
  bin_count: 2,
  plan: 'monthly' as const,
};

describe('POST /api/book — failure modes', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockWhere.mockReset();
    mockValues.mockClear();
  });

  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns 400 with field errors when body is invalid', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, email: 'not-an-email', bin_count: 99 },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    const body = res.body as { status: string; errors: Record<string, string[]> };
    expect(body.status).toBe('invalid');
    expect(body.errors).toHaveProperty('email');
    expect(body.errors).toHaveProperty('bin_count');
  });

  it('returns 422 when postal code is outside service area', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, postal_code: 'K1A 0B1' }, // Ottawa
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(422);
    const body = res.body as { status: string; message: string };
    expect(body.status).toBe('out_of_area');
    expect(body.message).toMatch(/serve your area/i);
  });

  it('returns 409 when email already has an active subscription', async () => {
    // First lookup: existing customer
    mockWhere.mockResolvedValueOnce([
      { id: 'existing-cust-id', email: 'sam@example.com' },
    ]);
    // Second lookup: active sub
    mockWhere.mockResolvedValueOnce([{ id: 'sub-id', status: 'active' }]);

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    const body = res.body as { status: string; message: string };
    expect(body.status).toBe('already_subscribed');
  });

  it('returns 500 when the DB throws unexpectedly', async () => {
    mockWhere.mockRejectedValueOnce(new Error('connection lost'));
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const body = res.body as { status: string; message: string };
    expect(body.status).toBe('error');
    expect(body.message).toBe('connection lost');
  });
});
```

- [ ] **Step 2: Run tests — expect PASS (handler already exists)**

Run: `npm test -- api/_tests/book.failure.test.ts`
Expected: 4 tests passing.

If a test fails because the mock isn't being called in the expected order, the handler's lookup sequence might have changed. Re-check `api/book.ts` against the mock expectations.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/_tests/book.failure.test.ts
git commit -m "$(cat <<'EOF'
test(api): cover /api/book failure modes with mocked DB

Four cases without touching real Neon:
- 400 on invalid body (zod errors surface as field map)
- 422 on out-of-service-area postal code
- 409 when an active subscription already exists for the email
- 500 when the DB throws unexpectedly

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `POST /api/waitlist` (TDD)

**Files:**
- Create: `api/waitlist.ts`
- Create: `api/_tests/waitlist.test.ts`

- [ ] **Step 1: Write the failing test**

`api/_tests/waitlist.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../waitlist.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { waitlist } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
});

beforeEach(async () => {
  await truncateAllForTests();
});

describe('POST /api/waitlist', () => {
  it('creates a waitlist row for a valid email + postal code', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'sam@example.com', postal_code: 'T5J 1A1' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe('ok');

    const db = getDb();
    const rows = await db.select().from(waitlist).where(eq(waitlist.email, 'sam@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.postalCode).toBe('T5J1A1');
  });

  it('allows the same email to sign up multiple times without erroring', async () => {
    const body = { email: 'sam@example.com', postal_code: 'T5J 1A1' };
    const req1 = mockReq<typeof handler>({ method: 'POST', body });
    const res1 = mockRes<typeof handler>();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(200);

    const req2 = mockReq<typeof handler>({ method: 'POST', body });
    const res2 = mockRes<typeof handler>();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);

    const db = getDb();
    const rows = await db.select().from(waitlist).where(eq(waitlist.email, 'sam@example.com'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 400 for invalid body', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'not-an-email' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-POST', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- api/_tests/waitlist.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `api/waitlist.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/client.js';
import { waitlist } from '../db/schema.js';
import { waitlistRequestSchema } from '../lib/validation.js';
import { normalizePostalCode } from '../lib/postal.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = waitlistRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: 'invalid',
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  const data = parsed.data;

  try {
    const db = getDb();
    await db.insert(waitlist).values({
      id: crypto.randomUUID(),
      email: data.email,
      postalCode: normalizePostalCode(data.postal_code),
    });
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[waitlist] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- api/_tests/waitlist.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add api/waitlist.ts api/_tests/waitlist.test.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /api/waitlist for out-of-area lead capture

Minimal endpoint: stores {email, normalized postal_code} so AB has a
list of people to notify when service expands beyond Fort Saskatchewan.
Allows duplicate signups (no unique constraint on email) — Phase 5
could add dedupe if the list gets noisy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Wire the booking form to the real endpoint

**Files:**
- Modify: `components-booking.jsx`

The current `components-booking.jsx` is a multi-step React wizard with a fake "you're booked!" animation. We replace the success-path of the final step with a real `fetch('/api/book', ...)`. The visual flow is preserved — only the submit handler changes.

- [ ] **Step 1: Read the current file to find the fake-submit code**

Run: `grep -n -E "onSubmit|setStep|setShow|booked|success" components-booking.jsx | head -30`

Look for the function that handles the final "Submit" / "Book now" click — it currently sets state to show the success animation without any HTTP call.

- [ ] **Step 2: Modify the submit handler**

Find the function that handles submitting the booking (it should be near the end of the wizard component, probably named `handleSubmit`, `onConfirm`, or `submitBooking`). Replace its body with:

```jsx
async function submitBooking() {
  setSubmitState({ phase: 'sending' });

  const payload = {
    name: contact.name,
    email: contact.email,
    phone: contact.phone || undefined,
    street: address.street,
    city: address.city || 'Fort Saskatchewan',
    postal_code: address.postalCode,
    pickup_day: address.pickupDay,
    bin_count: bins,
    plan: plan === 'oneoff' ? 'oneoff' : cadence,
    ...(plan === 'oneoff' ? { oneoff_date: chosenDate } : {}),
  };

  try {
    const response = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (response.status === 200 && data.status === 'ok') {
      setSubmitState({ phase: 'success', firstVisitDate: data.first_visit_date });
      return;
    }
    if (response.status === 422 && data.status === 'out_of_area') {
      setSubmitState({ phase: 'out_of_area', message: data.message });
      return;
    }
    if (response.status === 409 && data.status === 'already_subscribed') {
      setSubmitState({ phase: 'already_subscribed', message: data.message });
      return;
    }
    if (response.status === 400 && data.status === 'invalid') {
      setSubmitState({ phase: 'invalid', fieldErrors: data.errors });
      return;
    }
    setSubmitState({ phase: 'error', message: data.message || 'Something went wrong. Please try again or email hello@luckyshamrock.ca.' });
  } catch (err) {
    setSubmitState({ phase: 'error', message: 'Network error. Check your connection and try again.' });
  }
}
```

The local variable names (`contact`, `address`, `bins`, `plan`, `cadence`, `chosenDate`, `setSubmitState`) must be wired to whatever the existing component already uses. If they don't exist, add `const [submitState, setSubmitState] = useState({ phase: 'idle' })` near the top of the component.

- [ ] **Step 3: Update the rendered success / error states**

The wizard's final-step JSX should branch on `submitState.phase` instead of unconditionally showing the success animation. The branches:

```jsx
{submitState.phase === 'idle' && (
  <button onClick={submitBooking} className="booking-cta">Confirm booking</button>
)}
{submitState.phase === 'sending' && <div className="booking-loading">Booking…</div>}
{submitState.phase === 'success' && (
  <div className="booking-success">
    <h3>You're booked!</h3>
    <p>Your first clean is scheduled for <strong>{submitState.firstVisitDate}</strong>.</p>
    <p>Check your email for a link to manage your booking.</p>
  </div>
)}
{submitState.phase === 'out_of_area' && (
  <WaitlistCapture
    email={contact.email}
    postalCode={address.postalCode}
    message={submitState.message}
  />
)}
{submitState.phase === 'already_subscribed' && (
  <div className="booking-warning">
    <p>{submitState.message}</p>
  </div>
)}
{submitState.phase === 'invalid' && (
  <div className="booking-error">
    <p>Please fix the highlighted fields and try again.</p>
    <ul>
      {Object.entries(submitState.fieldErrors).map(([field, msgs]) => (
        <li key={field}><strong>{field}:</strong> {msgs.join(', ')}</li>
      ))}
    </ul>
  </div>
)}
{submitState.phase === 'error' && (
  <div className="booking-error">
    <p>{submitState.message}</p>
    <button onClick={() => setSubmitState({ phase: 'idle' })}>Try again</button>
  </div>
)}
```

Add `WaitlistCapture` as a small inline component below the wizard:

```jsx
function WaitlistCapture({ email, postalCode, message }) {
  const [state, setState] = useState('idle');

  async function joinWaitlist() {
    setState('sending');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, postal_code: postalCode }),
      });
      setState(res.ok ? 'joined' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'joined') {
    return <div className="booking-success"><p>You're on the waitlist. We'll email you when service reaches your area.</p></div>;
  }
  return (
    <div className="booking-warning">
      <p>{message}</p>
      <button onClick={joinWaitlist} disabled={state === 'sending'}>
        {state === 'sending' ? 'Joining…' : 'Notify me when you serve my area'}
      </button>
      {state === 'error' && <p>Couldn't join the waitlist — try again or email us at hello@luckyshamrock.ca.</p>}
    </div>
  );
}
```

- [ ] **Step 4: Visually inspect the change in the local site**

Run: `cd ~/Documents/luckyshamrock && python3 -m http.server 8000 &`

Open http://localhost:8000 in a browser. Walk through the booking flow. At submit, open DevTools Network tab and watch for a `POST /api/book` call.

Note: `python3 -m http.server` doesn't run the serverless functions. The fetch will fail with a 404/CORS error locally. That's expected — we're only verifying the JSX renders without errors and the form collects the right data. The real end-to-end test happens after deploy.

When done, stop the server: `pkill -f "python3 -m http.server"`.

- [ ] **Step 5: Commit**

```bash
git add components-booking.jsx
git commit -m "$(cat <<'EOF'
feat(ui): wire booking form to real /api/book endpoint

Replaces the fake success animation with a real fetch to /api/book.
The final step now branches on submit state:
- idle: show Confirm button
- sending: spinner
- success: show first_visit_date + "check email" copy
- out_of_area: render WaitlistCapture component
- already_subscribed: show "manage existing booking" message
- invalid: list zod field errors
- error: generic retry message

WaitlistCapture handles the /api/waitlist POST for out-of-area users.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Manual smoke test in production (AB action)

This task has no code. After Task 12's commit is pushed, Vercel auto-deploys. AB exercises the live booking flow to confirm everything wires together.

- [ ] **Step 1: Push and wait for the deploy**

Run: `git push`
Wait ~90 seconds. Watch Vercel dashboard → Deployments tab for the new deploy to go green.

- [ ] **Step 2: Verify the /api/health endpoint still works**

```bash
curl -s https://www.luckyshamrock.ca/api/health
```
Expected: `{"status":"ok","db":true,"error":null,...}` — confirms the new code didn't break Phase 0.

- [ ] **Step 3: Submit a real booking via curl (recurring)**

```bash
curl -s -X POST https://www.luckyshamrock.ca/api/book \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Test Customer (DELETE ME)",
    "email": "smoketest+monthly@luckyshamrockbincleaning.com",
    "street": "100 Test St",
    "city": "Fort Saskatchewan",
    "postal_code": "T8L 1A1",
    "pickup_day": "wednesday",
    "bin_count": 1,
    "plan": "monthly"
  }'
```
Expected: `{"status":"ok","customer_id":"...","first_visit_date":"..."}`. 

- [ ] **Step 4: Submit a one-off booking via curl**

```bash
curl -s -X POST https://www.luckyshamrock.ca/api/book \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Test Customer (DELETE ME)",
    "email": "smoketest+oneoff@luckyshamrockbincleaning.com",
    "street": "200 Test St",
    "city": "Fort Saskatchewan",
    "postal_code": "T8L 2B3",
    "pickup_day": "monday",
    "bin_count": 2,
    "plan": "oneoff",
    "oneoff_date": "2026-07-15"
  }'
```
Expected: `{"status":"ok",...}`.

- [ ] **Step 5: Confirm an out-of-area booking is rejected**

```bash
curl -s -i -X POST https://www.luckyshamrock.ca/api/book \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Edmonton Test",
    "email": "smoketest+edm@luckyshamrockbincleaning.com",
    "street": "1 Edmonton Way",
    "city": "Edmonton",
    "postal_code": "T5J 1A1",
    "pickup_day": "wednesday",
    "bin_count": 1,
    "plan": "monthly"
  }'
```
Expected: HTTP 422 and `{"status":"out_of_area","message":"..."}`.

- [ ] **Step 6: Confirm duplicate-active rejection**

Re-run Step 3 with the same email. Expected: HTTP 409 and `{"status":"already_subscribed","message":"..."}`.

- [ ] **Step 7: Verify rows in Neon**

In Neon SQL Editor:
```sql
SELECT email, name, pickup_day, created_at FROM customer ORDER BY created_at DESC LIMIT 5;
SELECT * FROM subscription ORDER BY created_at DESC LIMIT 3;
SELECT scheduled_for, status FROM visit ORDER BY created_at DESC LIMIT 15;
SELECT email, postal_code FROM waitlist ORDER BY created_at DESC LIMIT 3;
```
Expected: see the smoketest rows, with the monthly customer having 12 visits.

- [ ] **Step 8: Walk the UI**

Open https://www.luckyshamrock.ca in a browser. Walk through the booking wizard end-to-end with the same out-of-area postal code (Edmonton's `T5J 1A1`) to confirm the WaitlistCapture component renders and the join button posts to `/api/waitlist`.

- [ ] **Step 9: Clean up the smoke-test rows**

In Neon SQL Editor:
```sql
DELETE FROM visit WHERE customer_id IN (
  SELECT id FROM customer WHERE email LIKE 'smoketest+%@luckyshamrockbincleaning.com'
);
DELETE FROM subscription WHERE customer_id IN (
  SELECT id FROM customer WHERE email LIKE 'smoketest+%@luckyshamrockbincleaning.com'
);
DELETE FROM customer WHERE email LIKE 'smoketest+%@luckyshamrockbincleaning.com';
DELETE FROM waitlist WHERE email LIKE 'smoketest+%@luckyshamrockbincleaning.com';
```

No commit (Neon admin).

---

## Task 14: Update CLAUDE.md with Phase 1 conventions

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append a new section after "API response convention"**

Find the "## API response convention" section. AFTER it, insert this new section:

```markdown
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

The stubbed `lib/email.ts` will be replaced in Phase 2 with a real Gmail send. The `sendEmail()` signature and `SendEmailResult` shape are stable — don't change them when wiring the real impl.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Phase 1 conventions in repo CLAUDE.md

Codifies the booking endpoint response codes (200/400/409/422/500),
the integration vs unit test layout, app-side UUID rule, and the
email-stub stability promise so future sessions don't re-derive them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Update Obsidian session log + project note

This task has no code. It records the phase outcome in durable project memory.

- [ ] **Step 1: Update the project note**

Open `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md` and:

1. Change the `**Status:**` line to:
   ```
   **Status:** 🚧 Phase 1 (Booking POST) shipped <ABSOLUTE-DATE-OF-COMPLETION> — real bookings landing in Neon, recurring + one-off + waitlist all live. Phase 2 (email + magic-link auth) next.
   ```
2. Append to `## Session Log`:
   ```markdown
   ### <ABSOLUTE-DATE-OF-COMPLETION> — Phase 1 (Booking POST) shipped

   - Added 6 tables to `db/schema.ts` (customer, subscription, visit, magic_link_token, notification_log, waitlist) via drizzle. UUIDs generated app-side via `crypto.randomUUID()`.
   - Pure utility modules: `lib/postal.ts` (T8L service-area check with env override), `lib/schedule.ts` (cadence math in weeks), `lib/validation.ts` (zod schemas), `lib/email.ts` (stubbed sender — Phase 2 swaps body for real Gmail).
   - Two new endpoints: `POST /api/book` (recurring + one-off, with idempotency + service-area gate + 400/409/422/500 paths) and `POST /api/waitlist` (out-of-area lead capture).
   - Replaced the fake wizard success animation in `components-booking.jsx` with a real fetch and a branched UI (idle/sending/success/out_of_area/already_subscribed/invalid/error). `WaitlistCapture` sub-component handles the out-of-area follow-up.
   - Extracted shared `mockReq`/`mockRes` to `api/_tests/_helpers.ts`. Added `truncateAllForTests()` for integration test cleanup.
   - Smoke tested in production: monthly subscription creates 12 visits, one-off creates 1, out-of-area returns 422, duplicate-active returns 409. UI walks end-to-end and renders waitlist component for non-T8L postal codes.
   - **Next:** Phase 2 — wire real Gmail send (Workspace service account), magic-link issue + verify, /manage page for customer self-service (skip / cancel / change plan). Note: `SITE_URL`, `GMAIL_SERVICE_ACCOUNT_JSON`, `GMAIL_SEND_AS`, `SESSION_SECRET` env vars must be added to Vercel before Phase 2 endpoints will work.
   ```

Replace `<ABSOLUTE-DATE-OF-COMPLETION>` with the actual date (YYYY-MM-DD format) the implementer is running this on.

2. Update the `## Open follow-ups` section by removing items now covered (`Replace fake booking wizard...`) and leaving the rest.

- [ ] **Step 2: Update `_Index.md`**

In `~/Documents/My Brain/Projects/_Index.md`, change the Lucky Shamrock row's Status column to:

```
🚧 Phase 1 (Booking POST) shipped <ABSOLUTE-DATE-OF-COMPLETION>. Real bookings landing in Neon — recurring + one-off + waitlist all live. Phase 2 (email + magic-link) next.
```

- [ ] **Step 3: No commit**

Obsidian vault is separate from the repo.

---

## Self-Review (for the executor)

After all 15 tasks, run these checks before declaring Phase 1 done:

- [ ] `npm test` reports ~49 tests passing (4 health + 5 postal + 11 schedule + 4 email + 14 validation + 3 book happy + 4 book failure + 4 waitlist)
- [ ] `npm run typecheck` exits 0
- [ ] `npm run db:generate` reports no schema drift
- [ ] Production curl smoke tests from Task 13 all pass
- [ ] Neon has the six new tables plus a drizzle migration row
- [ ] Booking UI walks end-to-end in a real browser without console errors
- [ ] `git log --oneline` since Phase 0 close shows ~13 commits (one per code task plus a few from manual cleanup)

If any check fails, do not declare Phase 1 complete.

---

## What this plan deliberately does NOT do

These belong to later phases:

- **Real Gmail sending** (Phase 2) — `lib/email.ts` is intentionally stubbed
- **Magic-link tokens** (Phase 2) — the booking response includes a placeholder magic_link email but no real token is issued
- **`/manage` customer page** (Phase 3)
- **`/ops` operator page** (Phase 4)
- **Daily-pickup-day reminders** (Phase 5)
- **Photo uploads** (deferred indefinitely)
- **Payment collection** (deferred indefinitely)

If a task above appears to require any of these, you've drifted — re-read the task description.

---

## Phase 2 prep notes

Pulling these forward so Phase 2's plan can hit the ground running:

- **Vercel env vars to add before Phase 2 starts:**
  - `SITE_URL=https://www.luckyshamrock.ca`
  - `SESSION_SECRET=<32+ random bytes>`
  - `GMAIL_SERVICE_ACCOUNT_JSON=<JSON key file contents>`
  - `GMAIL_SEND_AS=hello@luckyshamrock.ca` (or whichever Workspace alias AB picks)
- **Workspace setup:**
  - Enable domain-wide delegation for a service account on `luckyshamrock.ca` Workspace
  - Grant the service account the `https://www.googleapis.com/auth/gmail.send` scope
  - Verify the chosen sender address (`hello@`) exists as a real or alias mailbox
- **The placeholder magic-link email** in `api/book.ts:104-107` will be deleted and replaced with the real token-issuing flow. Don't manually clean it up before Phase 2 — let Phase 2 own the replacement.
