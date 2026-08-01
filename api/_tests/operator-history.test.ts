import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleHistory as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, payment } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});
beforeEach(async () => { await truncateAllForTests(); });

function mockRes(): any {
  const r: any = { statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; }, setHeader() { return this; } };
  return r;
}
async function req(authed: boolean, query: Record<string, string> = {}): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method: 'GET', headers, query };
}

async function seedCustomer(name = 'Pat'): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(customer).values({
    id, email: `h-${id.slice(0, 8)}@e.com`, name, street: '1 Rd',
    city: 'Fort Saskatchewan', postalCode: 'T8L1A1', pickupDay: 'wednesday',
  });
  return id;
}
async function addVisit(customerId: string, date: string, status: string, paymentStatus?: string): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(visit).values({
    id, customerId, subscriptionId: null, binCount: 1,
    scheduledFor: new Date(`${date}T12:00:00Z`), status: status as any,
    ...(paymentStatus ? { paymentStatus: paymentStatus as any } : {}),
    ...(status === 'done' ? { doneAt: new Date(`${date}T18:00:00Z`) } : {}),
  });
  return id;
}

describe('GET /api/operator/history', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req(false), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns finished work — done, skipped and cancelled — newest first', async () => {
    const c = await seedCustomer('Alpha');
    await addVisit(c, '2026-07-01', 'done', 'charged');
    await addVisit(c, '2026-07-15', 'skipped');
    await addVisit(c, '2026-07-20', 'cancelled');

    const res = mockRes();
    await handler(await req(true), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.visits).toHaveLength(3);
    // Newest first — the operator cares about recent work.
    expect(res.body.visits.map((v: any) => v.scheduled_for))
      .toEqual(['2026-07-20', '2026-07-15', '2026-07-01']);
  });

  it('excludes future-dated cancellations — history means the past', async () => {
    // Cancelling a subscription sweeps a dozen future visits to `cancelled`.
    // Those never happened and never will; showing them buries the real work
    // under a wall of noise (exactly what production looked like on day one).
    const c = await seedCustomer();
    await addVisit(c, '2026-07-01', 'done', 'charged');
    await addVisit(c, '2027-06-10', 'cancelled');
    await addVisit(c, '2027-05-13', 'cancelled');

    const res = mockRes();
    await handler(await req(true), res);
    expect(res.body.visits).toHaveLength(1);
    expect(res.body.visits[0].scheduled_for).toBe('2026-07-01');
  });

  it('excludes work that has not happened yet', async () => {
    const c = await seedCustomer();
    await addVisit(c, '2026-07-01', 'done', 'charged');
    await addVisit(c, '2026-12-01', 'scheduled');       // future, still to do
    await addVisit(c, '2026-12-02', 'heading_there');   // in flight right now

    const res = mockRes();
    await handler(await req(true), res);
    expect(res.body.visits).toHaveLength(1);
    expect(res.body.visits[0].status).toBe('done');
  });

  it('reports what was actually collected for each stop', async () => {
    const c = await seedCustomer();
    const v = await addVisit(c, '2026-07-01', 'done', 'paid_cash');
    await getDb().insert(payment).values({
      id: crypto.randomUUID(), customerId: c, visitId: v,
      amountCents: 4000, discountCents: 0, creditCents: 500,
      status: 'succeeded', method: 'cash',
    });

    const res = mockRes();
    await handler(await req(true), res);
    const row = res.body.visits[0];
    expect(row.payment_status).toBe('paid_cash');
    expect(row.amount_cents).toBe(4000);
    expect(row.credit_cents).toBe(500);
  });

  it('pages so the list cannot grow unbounded', async () => {
    const c = await seedCustomer();
    for (let i = 1; i <= 5; i++) await addVisit(c, `2026-06-0${i}`, 'done', 'charged');

    const first = mockRes();
    await handler(await req(true, { limit: '2' }), first);
    expect(first.body.visits).toHaveLength(2);
    expect(first.body.has_more).toBe(true);

    const second = mockRes();
    await handler(await req(true, { limit: '2', offset: '4' }), second);
    expect(second.body.visits).toHaveLength(1);
    expect(second.body.has_more).toBe(false);
  });

  it('clamps an absurd limit instead of trusting it', async () => {
    const c = await seedCustomer();
    await addVisit(c, '2026-07-01', 'done', 'charged');
    const res = mockRes();
    await handler(await req(true, { limit: '100000' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBeLessThanOrEqual(100);
  });
});
