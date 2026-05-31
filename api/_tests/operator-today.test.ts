import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../operator/today.js';
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

  it("lists the day's visits joined to customer + subscription bin_count, excluding cancelled", async () => {
    await seedVisit({ date: '2026-06-10', withSub: true, binCount: 3, name: 'Alice' });
    await seedVisit({ date: '2026-06-10', withSub: false, name: 'Bob' }); // one-off → bin_count null
    await seedVisit({ date: '2026-06-10', status: 'cancelled', name: 'Cara' });
    await seedVisit({ date: '2026-06-11', name: 'Dave' }); // other day

    const res = mockRes();
    await handler(await req(true, { date: '2026-06-10' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.date).toBe('2026-06-10');
    expect(res.body.visits).toHaveLength(2);

    const byName: Record<string, any> = Object.fromEntries(
      res.body.visits.map((v: any) => [v.customer_name, v]),
    );
    expect(byName.Alice.bin_count).toBe(3);
    expect(byName.Alice.scheduled_for).toBe('2026-06-10');
    expect(byName.Bob.bin_count).toBeNull();
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
