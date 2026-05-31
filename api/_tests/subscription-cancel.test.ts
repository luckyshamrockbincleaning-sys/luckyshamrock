import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../subscription/[id]/cancel.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { signSessionCookie, SESSION_COOKIE_NAME } from '../../lib/cookies.js';
import { and, eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SESSION_SECRET = 'a'.repeat(64);
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

async function req(customerId: string | null, id: string | undefined, method: string = 'POST'): Promise<any> {
  const headers: Record<string, string> = {};
  if (customerId) {
    const token = await signSessionCookie(customerId);
    headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return { method, headers, query: id !== undefined ? { id } : {} };
}

async function setup(): Promise<{ customerId: string; subId: string; pastVisitId: string; futureVisitId: string }> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `c-${customerId.slice(0,8)}@e.com`,
    name: 'C',
    street: 'X', city: 'Fort Saskatchewan', postalCode: 'T8L1A1', pickupDay: 'wednesday',
  });
  const subId = crypto.randomUUID();
  await db.insert(subscription).values({
    id: subId,
    customerId,
    cadence: 'monthly',
    binCount: 1,
    startedOn: new Date('2026-01-01'),
  });
  const pastVisitId = crypto.randomUUID();
  const futureVisitId = crypto.randomUUID();
  await db.insert(visit).values([
    { id: pastVisitId, customerId, subscriptionId: subId, scheduledFor: new Date('2026-01-08'), status: 'done', doneAt: new Date('2026-01-08') },
    { id: futureVisitId, customerId, subscriptionId: subId, scheduledFor: new Date('2099-12-31') },
  ]);
  return { customerId, subId, pastVisitId, futureVisitId };
}

describe('POST /api/subscription/:id/cancel', () => {
  it('marks the subscription cancelled and cancels future scheduled visits', async () => {
    const { customerId, subId, pastVisitId, futureVisitId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, subId), res);
    expect(res.statusCode).toBe(200);

    const db = getDb();
    const [sub] = await db.select().from(subscription).where(eq(subscription.id, subId));
    expect(sub!.status).toBe('cancelled');
    expect(sub!.cancelledAt).not.toBeNull();

    const [past] = await db.select().from(visit).where(eq(visit.id, pastVisitId));
    expect(past!.status).toBe('done'); // untouched

    const [future] = await db.select().from(visit).where(eq(visit.id, futureVisitId));
    expect(future!.status).toBe('cancelled');
  });

  it('returns 401 without a session', async () => {
    const { subId } = await setup();
    const res = mockRes();
    await handler(await req(null, subId), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the subscription does not exist', async () => {
    const { customerId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, crypto.randomUUID()), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the sub belongs to another customer', async () => {
    const { subId } = await setup();
    const otherId = crypto.randomUUID();
    const db = getDb();
    await db.insert(customer).values({
      id: otherId,
      email: `o-${otherId.slice(0,8)}@e.com`,
      name: 'O',
      street: 'X', city: 'Fort Saskatchewan', postalCode: 'T8L1A1', pickupDay: 'wednesday',
    });
    const res = mockRes();
    await handler(await req(otherId, subId), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.status).toBe('not_yours');
  });

  it('returns 409 when already cancelled', async () => {
    const { customerId, subId } = await setup();
    const db = getDb();
    await db.update(subscription).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(subscription.id, subId));
    const res = mockRes();
    await handler(await req(customerId, subId), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('already_cancelled');
  });

  it('returns 405 for non-POST', async () => {
    const { customerId, subId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, subId, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });
});
