import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../visit/[id]/skip.js';
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

async function setup(opts: { withSubscription?: boolean } = {}): Promise<{ customerId: string; visitId: string; subId: string | null }> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `c-${customerId.slice(0,8)}@e.com`,
    name: 'C',
    street: 'X',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  let subId: string | null = null;
  if (opts.withSubscription !== false) {
    subId = crypto.randomUUID();
    await db.insert(subscription).values({
      id: subId,
      customerId,
      cadence: 'monthly',
      binCount: 1,
      startedOn: new Date('2026-06-01'),
    });
  }
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: subId,
    scheduledFor: new Date('2026-06-04'),
  });
  return { customerId, visitId, subId };
}

describe('POST /api/visit/:id/skip', () => {
  it('appends the replacement after the LAST scheduled visit — never a duplicate date', async () => {
    // Regression: with a fully generated schedule, "skipped date + one interval"
    // is exactly the next visit's date. Found live 2026-06-10: skipping Jul 16
    // created a second Aug 13 visit (two cleans, two charges, same day).
    const { customerId, visitId, subId } = await setup();
    const db = getDb();
    // Extend the schedule: Jun 4 (from setup) + Jul 2 + Jul 30.
    for (const d of ['2026-07-02', '2026-07-30']) {
      await db.insert(visit).values({
        id: crypto.randomUUID(),
        customerId,
        subscriptionId: subId,
        scheduledFor: new Date(d),
      });
    }

    const res = mockRes();
    await handler(await req(customerId, visitId), res); // skip Jun 4
    expect(res.statusCode).toBe(200);
    expect(res.body.replacement_date).toBe('2026-08-27'); // last (Jul 30) + 28d, NOT Jul 2

    const scheduled = await db
      .select()
      .from(visit)
      .where(and(eq(visit.customerId, customerId), eq(visit.status, 'scheduled')));
    const dates = scheduled.map((v) => v.scheduledFor.toISOString().slice(0, 10)).sort();
    expect(dates).toEqual(['2026-07-02', '2026-07-30', '2026-08-27']);
    expect(new Set(dates).size).toBe(dates.length); // no duplicates
  });

  it('marks the visit skipped and inserts a replacement 4 weeks later for a monthly sub', async () => {
    const { customerId, visitId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, visitId), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.replacement_date).toBe('2026-07-02'); // +28 days

    const db = getDb();
    const all = await db.select().from(visit).where(eq(visit.customerId, customerId));
    expect(all).toHaveLength(2);
    const skipped = all.find((v) => v.id === visitId);
    const replacement = all.find((v) => v.id !== visitId);
    expect(skipped!.status).toBe('skipped');
    expect(replacement!.status).toBe('scheduled');
  });

  it('returns 401 when no session', async () => {
    const { visitId } = await setup();
    const res = mockRes();
    await handler(await req(null, visitId), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the visit does not exist', async () => {
    const { customerId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, crypto.randomUUID()), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the visit belongs to another customer', async () => {
    const { visitId } = await setup();
    // Different customer's session
    const otherId = crypto.randomUUID();
    const db = getDb();
    await db.insert(customer).values({
      id: otherId,
      email: `o-${otherId.slice(0,8)}@e.com`,
      name: 'O',
      street: 'X', city: 'Fort Saskatchewan', postalCode: 'T8L1A1', pickupDay: 'wednesday',
    });
    const res = mockRes();
    await handler(await req(otherId, visitId), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.status).toBe('not_yours');
  });

  it('returns 409 when the visit is already done', async () => {
    const { customerId, visitId } = await setup();
    const db = getDb();
    await db.update(visit).set({ status: 'done', doneAt: new Date() }).where(eq(visit.id, visitId));
    const res = mockRes();
    await handler(await req(customerId, visitId), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('not_scheduled');
  });

  it('cancels a one-off visit (no replacement) instead of skipping', async () => {
    const { customerId, visitId } = await setup({ withSubscription: false });
    const res = mockRes();
    await handler(await req(customerId, visitId), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.cancelled).toBe(true);

    const db = getDb();
    const all = await db.select().from(visit).where(eq(visit.customerId, customerId));
    expect(all).toHaveLength(1); // no replacement inserted
    expect(all[0]!.status).toBe('cancelled');
  });

  it('returns 405 for non-POST', async () => {
    const { customerId, visitId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, visitId, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });
});
