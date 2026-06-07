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

  it('returns all future actionable visits, excluding today and non-actionable statuses', async () => {
    await seedVisit('2026-06-10', 'scheduled', 'Anchor'); // anchor day — excluded
    await seedVisit('2026-06-11', 'scheduled', 'Tomorrow'); // included
    await seedVisit('2026-06-12', 'heading_there', 'Heading'); // included
    await seedVisit('2026-06-15', 'scheduled', 'MidWeek'); // included
    await seedVisit('2026-06-18', 'scheduled', 'FartherOut'); // included now
    await seedVisit('2027-06-18', 'scheduled', 'NextYear'); // included now
    await seedVisit('2026-06-13', 'skipped', 'Skipped'); // excluded
    await seedVisit('2026-06-14', 'done', 'Done'); // excluded
    await seedVisit('2026-06-12', 'cancelled', 'Cancelled'); // excluded

    const res = mockRes();
    await handler(await req(true, { date: '2026-06-10', days: '7' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    const names = res.body.visits.map((v: any) => v.customer_name);
    expect(names).toEqual(['Tomorrow', 'Heading', 'MidWeek', 'FartherOut', 'NextYear']); // ordered by date asc
  });

  it('ignores legacy days limits and still returns all future actionable visits', async () => {
    await seedVisit('2026-06-11', 'scheduled', 'Tomorrow');
    await seedVisit('2026-06-12', 'scheduled', 'DayAfter');
    await seedVisit('2026-09-01', 'scheduled', 'Later');

    const resDefault = mockRes();
    await handler(await req(true, { date: '2026-06-10' }), resDefault);
    expect(resDefault.body.visits.map((v: any) => v.customer_name)).toEqual(['Tomorrow', 'DayAfter', 'Later']);

    const resLegacyDays = mockRes();
    await handler(await req(true, { date: '2026-06-10', days: '1' }), resLegacyDays);
    expect(resLegacyDays.body.visits.map((v: any) => v.customer_name)).toEqual(['Tomorrow', 'DayAfter', 'Later']);
  });
});
