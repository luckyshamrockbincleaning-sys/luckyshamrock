import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../rate.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, notificationLog } from '../../db/schema.js';
import { signRatingToken } from '../../lib/rating-token.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SESSION_SECRET = 's'.repeat(48);
  process.env.REVIEW_URL = 'https://g.example/review';
});

beforeEach(async () => {
  await truncateAllForTests();
  delete process.env.OPERATOR_NOTIFY_EMAIL;
});

function mockRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    headers,
    body: undefined,
    ended: false,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string) { headers[name] = value; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

async function seedDoneVisit(): Promise<{ customerId: string; visitId: string }> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `rate-${customerId.slice(0, 8)}@e.com`,
    name: 'Rae Tings',
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
    scheduledFor: new Date('2026-07-09T12:00:00Z'),
    status: 'done',
  });
  return { customerId, visitId };
}

describe('GET /api/rate (tap-a-star)', () => {
  it('records a 5-star rating and redirects to the Google review page', async () => {
    const { visitId } = await seedDoneVisit();
    const res = mockRes();
    await handler({ method: 'GET', query: { v: visitId, t: signRatingToken(visitId), stars: '5' } } as any, res);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('https://g.example/review');
    const [v] = await getDb().select().from(visit).where(eq(visit.id, visitId));
    expect(v!.rating).toBe(5);
    expect(v!.ratedAt).not.toBeNull();
  });

  it('records a low rating and redirects to the private feedback form instead', async () => {
    const { visitId } = await seedDoneVisit();
    const res = mockRes();
    await handler({ method: 'GET', query: { v: visitId, t: signRatingToken(visitId), stars: '2' } } as any, res);
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain('/feedback.html?');
    expect(res.headers.Location).toContain(visitId);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, visitId));
    expect(v!.rating).toBe(2);
  });

  it('rejects a forged token without touching the visit', async () => {
    const { visitId } = await seedDoneVisit();
    const res = mockRes();
    await handler({ method: 'GET', query: { v: visitId, t: 'forged-token-aaaaaaaaaaaa', stars: '5' } } as any, res);
    expect(res.statusCode).toBe(400);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, visitId));
    expect(v!.rating).toBeNull();
  });

  it('rejects out-of-range stars', async () => {
    const { visitId } = await seedDoneVisit();
    const res = mockRes();
    await handler({ method: 'GET', query: { v: visitId, t: signRatingToken(visitId), stars: '9' } } as any, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/rate (private feedback)', () => {
  it('saves the comment and emails the operator once, even on resubmit', async () => {
    process.env.OPERATOR_NOTIFY_EMAIL = 'ops@example.com';
    const { customerId, visitId } = await seedDoneVisit();
    const body = { v: visitId, t: signRatingToken(visitId), comment: 'Bin still smells a bit.' };

    let res = mockRes();
    await handler({ method: 'POST', query: {}, body } as any, res);
    expect(res.statusCode).toBe(200);

    res = mockRes();
    await handler({ method: 'POST', query: {}, body: { ...body, comment: 'Update: still smells.' } } as any, res);
    expect(res.statusCode).toBe(200);

    const [v] = await getDb().select().from(visit).where(eq(visit.id, visitId));
    expect(v!.ratingComment).toBe('Update: still smells.');
    const logs = await getDb().select().from(notificationLog).where(eq(notificationLog.customerId, customerId));
    expect(logs.filter((l) => l.kind === 'operator_feedback')).toHaveLength(1);
  });

  it('rejects a forged token', async () => {
    const { visitId } = await seedDoneVisit();
    const res = mockRes();
    await handler({ method: 'POST', query: {}, body: { v: visitId, t: 'nope-nope-nope', comment: 'x' } } as any, res);
    expect(res.statusCode).toBe(400);
  });
});
