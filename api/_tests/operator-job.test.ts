import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { handleNewJob as handler, handleDone as doneHandler, handleNotify as notifyHandler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, notificationLog } from '../../db/schema.js';
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

  it('rolls back the customer insert when the visit insert fails (atomicity)', async () => {
    const db = getDb();

    // Pre-seed a "victim" customer + visit so we can force a deterministic
    // DB-level failure on the *visit* insert without violating newJobSchema's
    // own validation (bin_count etc. all stay valid — only the visit's
    // primary-key uniqueness constraint trips).
    const victimCustomerId = crypto.randomUUID();
    const clashingVisitId = crypto.randomUUID();
    await db.insert(customer).values({
      id: victimCustomerId,
      email: 'victim@example.com',
      name: 'Victim',
      street: '1 Victim Ave',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L0A1',
      pickupDay: 'wednesday',
    });
    await db.insert(visit).values({
      id: clashingVisitId,
      customerId: victimCustomerId,
      subscriptionId: null,
      binCount: 1,
      scheduledFor: new Date(),
      status: 'scheduled',
    });

    // handleNewJob's first crypto.randomUUID() call mints the new visit's id.
    // Force just that call to collide with the pre-seeded visit's id so the
    // visit insert hits the primary-key unique constraint — a deterministic
    // failure that only trips AFTER the (new) customer insert has run inside
    // the same transaction.
    const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(clashingVisitId);

    try {
      const res = mockRes();
      await handler(await req(true, { ...validJob, email: 'atomic@example.com' }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Something went wrong on our end. Please try again.',
      });

      // The customer insert must have rolled back along with the failed visit
      // insert — no orphan customer row with zero visits left behind.
      const newCustomers = await db.select().from(customer).where(eq(customer.email, 'atomic@example.com'));
      expect(newCustomers).toHaveLength(0);
    } finally {
      uuidSpy.mockRestore();
    }
  });

  it('rejects a missing street', async () => {
    const res = mockRes();
    await handler(await req(true, { postal_code: 'T8L 0A1', bin_count: 1 }), res);
    expect(res.statusCode).toBe(400);
  });

  it('sends no customer email to a placeholder walk-up address on Done', async () => {
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

  it('sends no customer email to a placeholder walk-up address on Notify', async () => {
    const res = mockRes();
    await handler(await req(true, { street: '13 Curb Lane', postal_code: 'T8L 0A1', bin_count: 1 }), res);
    expect(res.statusCode).toBe(201);

    const { visit_id } = res.body as { visit_id: string };
    const notifyRes = mockRes();
    const cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
    await notifyHandler(
      { method: 'POST', headers: { cookie }, query: { id: visit_id }, body: {} } as any,
      notifyRes,
    );
    expect(notifyRes.statusCode).toBe(200);
    expect(notifyRes.body.status).toBe('ok');

    // The visit should be marked heading_there despite no email being sent
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visit_id));
    expect(v!.status).toBe('heading_there');
    expect(v!.headingThereAt).not.toBeNull();

    // No on_our_way notification log entry for placeholder emails
    const logs = await db.select().from(notificationLog);
    expect(logs.filter((l) => l.kind === 'on_our_way')).toHaveLength(0);
  });
});
