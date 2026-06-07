import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleToday as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';

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

async function req(authed: boolean, query: Record<string, string> = {}, method = 'GET'): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, query };
}

async function seedVisit(opts: {
  date: string;
  status?: string;
  withSub?: boolean;
  binCount?: number;
  visitBinCount?: number;
  name?: string;
}): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `c-${customerId.slice(0, 8)}@e.com`,
    name: opts.name ?? 'Stop',
    street: '1 Rd',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  let subId: string | null = null;
  if (opts.withSub) {
    subId = crypto.randomUUID();
    await db.insert(subscription).values({
      id: subId,
      customerId,
      cadence: 'monthly',
      binCount: opts.binCount ?? 2,
      startedOn: new Date('2026-06-01'),
    });
  }
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: subId,
    binCount: opts.visitBinCount ?? null,
    scheduledFor: new Date(`${opts.date}T12:00:00Z`),
    status: (opts.status as any) ?? 'scheduled',
  });
  return visitId;
}

describe('GET /api/operator/today', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req(false, { date: '2026-06-10' }), res);
    expect(res.statusCode).toBe(401);
  });

  it("lists the day's actionable visits joined to customer + subscription bin_count", async () => {
    await seedVisit({ date: '2026-06-10', withSub: true, binCount: 3, name: 'Alice' });
    // One-off with its bin count stored on the visit row (no subscription).
    await seedVisit({ date: '2026-06-10', withSub: false, visitBinCount: 1, name: 'Bob' });
    await seedVisit({ date: '2026-06-10', status: 'heading_there', name: 'Bea' });
    await seedVisit({ date: '2026-06-10', status: 'skipped', name: 'Skip' });
    await seedVisit({ date: '2026-06-10', status: 'done', name: 'Done' });
    await seedVisit({ date: '2026-06-10', status: 'cancelled', name: 'Cara' });
    await seedVisit({ date: '2026-06-11', name: 'Dave' }); // other day

    const res = mockRes();
    await handler(await req(true, { date: '2026-06-10' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.date).toBe('2026-06-10');
    expect(res.body.visits).toHaveLength(3);

    const byName: Record<string, any> = Object.fromEntries(
      res.body.visits.map((v: any) => [v.customer_name, v]),
    );
    // Recurring stop derives bin_count from the subscription...
    expect(byName.Alice.bin_count).toBe(3);
    expect(byName.Alice.scheduled_for).toBe('2026-06-10');
    // ...one-off stop reads it off the visit (COALESCE picks visit.bin_count).
    expect(byName.Bob.bin_count).toBe(1);
    expect(byName.Bea.status).toBe('heading_there');
    expect(byName.Skip).toBeUndefined();
    expect(byName.Done).toBeUndefined();
    expect(byName.Cara).toBeUndefined();
    expect(byName.Dave).toBeUndefined();
  });

  it('honors the ?date override', async () => {
    await seedVisit({ date: '2026-07-01', name: 'July' });
    const res = mockRes();
    await handler(await req(true, { date: '2026-07-01' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.visits).toHaveLength(1);
    expect(res.body.visits[0].customer_name).toBe('July');
  });
});
