import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleSeasonStart as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit, notificationLog } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';
import { eq } from 'drizzle-orm';

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
async function req(authed: boolean): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method: 'POST', headers, query: {}, body: {} };
}

async function seedSubscriber(email: string, status = 'active'): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.insert(customer).values({
    id, email, name: 'Season Tester', street: '1 Rd', city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1', pickupDay: 'wednesday',
  });
  await db.insert(subscription).values({
    id: crypto.randomUUID(), customerId: id, cadence: 'monthly', binCount: 1,
    startedOn: new Date('2026-06-01T12:00:00Z'), status: status as any,
  });
  return id;
}

describe('POST /api/operator/season — open the new season', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req(false), res);
    expect(res.statusCode).toBe(401);
  });

  it('books in-season visits for an active subscriber who has none', async () => {
    const id = await seedSubscriber('opens@example.com');
    const res = mockRes();
    await handler(await req(true), res);

    expect(res.statusCode).toBe(200);
    const vs = await getDb().select().from(visit).where(eq(visit.customerId, id));
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      const m = v.scheduledFor.getUTCMonth() + 1;
      expect(m).toBeGreaterThanOrEqual(5);
      expect(m).toBeLessThanOrEqual(10);
    }
  });

  it('emails the customer that the season has reopened', async () => {
    const id = await seedSubscriber('notified@example.com');
    const res = mockRes();
    await handler(await req(true), res);

    const logs = await getDb().select().from(notificationLog).where(eq(notificationLog.customerId, id));
    expect(logs.filter((l) => l.kind === 'season_start')).toHaveLength(1);
  });

  it('is safe to run twice — no duplicate visits, no second email', async () => {
    const id = await seedSubscriber('twice@example.com');
    await handler(await req(true), mockRes());
    const afterFirst = await getDb().select().from(visit).where(eq(visit.customerId, id));

    await handler(await req(true), mockRes());
    const afterSecond = await getDb().select().from(visit).where(eq(visit.customerId, id));

    expect(afterSecond.length).toBe(afterFirst.length);
    const logs = await getDb().select().from(notificationLog).where(eq(notificationLog.customerId, id));
    expect(logs.filter((l) => l.kind === 'season_start')).toHaveLength(1);
  });

  it('ignores cancelled subscriptions', async () => {
    const id = await seedSubscriber('cancelled@example.com', 'cancelled');
    const res = mockRes();
    await handler(await req(true), res);

    expect(await getDb().select().from(visit).where(eq(visit.customerId, id))).toHaveLength(0);
    const logs = await getDb().select().from(notificationLog).where(eq(notificationLog.customerId, id));
    expect(logs).toHaveLength(0);
  });

  it('reports what it did', async () => {
    await seedSubscriber('a@example.com');
    await seedSubscriber('b@example.com');
    const res = mockRes();
    await handler(await req(true), res);

    expect(res.body.status).toBe('ok');
    expect(res.body.subscriptions_opened).toBe(2);
    expect(typeof res.body.visits_created).toBe('number');
  });
});
