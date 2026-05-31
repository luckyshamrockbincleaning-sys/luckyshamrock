import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleUpcoming as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit } from '../../db/schema.js';
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

async function seedVisit(date: string, status = 'scheduled', name = 'Stop'): Promise<void> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `c-${customerId.slice(0, 8)}@e.com`,
    name,
    street: '1 Rd',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  await db.insert(visit).values({
    id: crypto.randomUUID(),
    customerId,
    subscriptionId: null,
    scheduledFor: new Date(`${date}T12:00:00Z`),
    status: status as any,
  });
}

describe('GET /api/operator/upcoming', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req(false), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns visits in the next N days, excluding today and cancelled', async () => {
    await seedVisit('2026-06-10', 'scheduled', 'Anchor'); // anchor day — excluded
    await seedVisit('2026-06-11', 'scheduled', 'Tomorrow'); // included
    await seedVisit('2026-06-15', 'scheduled', 'MidWeek'); // included
    await seedVisit('2026-06-18', 'scheduled', 'TooFar'); // beyond +7 — excluded
    await seedVisit('2026-06-12', 'cancelled', 'Cancelled'); // excluded

    const res = mockRes();
    await handler(await req(true, { date: '2026-06-10', days: '7' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.days).toBe(7);
    const names = res.body.visits.map((v: any) => v.customer_name);
    expect(names).toEqual(['Tomorrow', 'MidWeek']); // ordered by date asc
  });

  it('defaults to 7 days when days is absent and clamps out-of-range values', async () => {
    await seedVisit('2026-06-11', 'scheduled', 'Tomorrow');
    await seedVisit('2026-06-40'.replace('40', '12'), 'scheduled', 'DayAfter');

    const resDefault = mockRes();
    await handler(await req(true, { date: '2026-06-10' }), resDefault);
    expect(resDefault.body.days).toBe(7);

    const resClampLow = mockRes();
    await handler(await req(true, { date: '2026-06-10', days: '0' }), resClampLow);
    expect(resClampLow.body.days).toBe(1); // clamped up to 1 → only 2026-06-11
    expect(resClampLow.body.visits.map((v: any) => v.customer_name)).toEqual(['Tomorrow']);

    const resClampHigh = mockRes();
    await handler(await req(true, { date: '2026-06-10', days: '9999' }), resClampHigh);
    expect(resClampHigh.body.days).toBe(60);
  });
});
