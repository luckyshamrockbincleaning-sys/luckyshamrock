import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../subscription/[id]/update.js';
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

async function req(customerId: string | null, id: string | undefined, body?: unknown, method: string = 'POST'): Promise<any> {
  const headers: Record<string, string> = {};
  if (customerId) {
    const token = await signSessionCookie(customerId);
    headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return { method, headers, query: id !== undefined ? { id } : {}, body };
}

async function setup(
  opts: { binCount?: number; binTypes?: string[] | null } = {},
): Promise<{ customerId: string; subId: string; oldFutureVisitId: string }> {
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
    binCount: opts.binCount ?? 1,
    binTypes: opts.binTypes ?? null,
    startedOn: new Date('2026-01-01'),
  });
  const oldFutureVisitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: oldFutureVisitId,
    customerId,
    subscriptionId: subId,
    scheduledFor: new Date('2099-12-31'),
  });
  return { customerId, subId, oldFutureVisitId };
}

describe('POST /api/subscription/:id/update', () => {
  it('updates bin_count without touching the schedule', async () => {
    const { customerId, subId, oldFutureVisitId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 3 }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.bin_count).toBe(3);

    const db = getDb();
    const [sub] = await db.select().from(subscription).where(eq(subscription.id, subId));
    expect(sub!.binCount).toBe(3);
    const [v] = await db.select().from(visit).where(eq(visit.id, oldFutureVisitId));
    expect(v!.status).toBe('scheduled'); // unchanged
  });

  it('cancels future visits and regenerates schedule on cadence change', async () => {
    const { customerId, subId, oldFutureVisitId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, subId, { cadence: 'seasonal' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.cadence).toBe('seasonal');

    const db = getDb();
    const [sub] = await db.select().from(subscription).where(eq(subscription.id, subId));
    expect(sub!.cadence).toBe('seasonal');

    const [oldV] = await db.select().from(visit).where(eq(visit.id, oldFutureVisitId));
    expect(oldV!.status).toBe('cancelled');

    const scheduled = await db
      .select()
      .from(visit)
      .where(and(eq(visit.subscriptionId, subId), eq(visit.status, 'scheduled')));
    expect(scheduled).toHaveLength(3); // seasonal target
  });

  it('rejects switching into an unsold legacy cadence (quarterly/bimonthly)', async () => {
    const { customerId, subId, oldFutureVisitId } = await setup();
    for (const cadence of ['quarterly', 'bimonthly']) {
      const res = mockRes();
      await handler(await req(customerId, subId, { cadence }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.status).toBe('invalid');
    }
    // Schedule untouched by the rejected requests.
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, oldFutureVisitId));
    expect(v!.status).toBe('scheduled');
  });

  it('returns 400 when body has neither cadence nor bin_count', async () => {
    const { customerId, subId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, subId, {}), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when bin_count is invalid', async () => {
    const { customerId, subId } = await setup();
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 99 }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session', async () => {
    const { subId } = await setup();
    const res = mockRes();
    await handler(await req(null, subId, { bin_count: 2 }), res);
    expect(res.statusCode).toBe(401);
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
    await handler(await req(otherId, subId, { bin_count: 2 }), res);
    expect(res.statusCode).toBe(422);
  });

  it('returns 409 when sub is cancelled', async () => {
    const { customerId, subId } = await setup();
    const db = getDb();
    await db.update(subscription).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(subscription.id, subId));
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 2 }), res);
    expect(res.statusCode).toBe(409);
  });
});

describe('bin_types must keep step with bin_count', () => {
  // Latent 500 found 2026-09-03: the route wrote bin_count and left bin_types
  // alone, violating subscription_bin_types_match_count. It had never fired
  // because every live subscription predates the bin picker and has no types.
  it('changing the count on a subscription WITH types does not 500', async () => {
    const { customerId, subId } = await setup({ binCount: 3, binTypes: ['garbage', 'garbage', 'organics'] });
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 2 }), res);
    expect(res.statusCode).toBe(200);

    const [sub] = await getDb().select().from(subscription).where(eq(subscription.id, subId));
    expect(sub!.binCount).toBe(2);
    expect(sub!.binTypes).toHaveLength(2);
  });

  it('honours an explicit list', async () => {
    const { customerId, subId } = await setup({ binCount: 1, binTypes: ['garbage'] });
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 2, bin_types: ['organics', 'garbage'] }), res);
    expect(res.statusCode).toBe(200);

    const [sub] = await getDb().select().from(subscription).where(eq(subscription.id, subId));
    expect(sub!.binTypes).toEqual(['garbage', 'organics']); // canonical order
  });

  it('refuses a list that disagrees with the count', async () => {
    const { customerId, subId } = await setup({ binCount: 1, binTypes: ['garbage'] });
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 3, bin_types: ['garbage', 'organics'] }), res);
    expect(res.statusCode).toBe(400);
  });

  it('leaves a legacy subscription with no types alone', async () => {
    const { customerId, subId } = await setup({ binCount: 2, binTypes: null });
    const res = mockRes();
    await handler(await req(customerId, subId, { bin_count: 3 }), res);
    expect(res.statusCode).toBe(200);

    const [sub] = await getDb().select().from(subscription).where(eq(subscription.id, subId));
    expect(sub!.binCount).toBe(3);
    expect(sub!.binTypes).toBeNull();
  });
});
