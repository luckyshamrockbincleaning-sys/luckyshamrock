import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../me.js';
import { mockReq } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit, payment } from '../../db/schema.js';
import { signSessionCookie, SESSION_COOKIE_NAME } from '../../lib/cookies.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

beforeEach(async () => {
  await truncateAllForTests();
});

function mockResWithHeaders() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return res;
}

async function makeCustomer(): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(customer).values({
    id,
    email: `c-${id.slice(0, 8)}@example.com`,
    name: 'Test C',
    street: 'X',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  return id;
}

async function reqWithSession(customerId: string): Promise<any> {
  const token = await signSessionCookie(customerId);
  return {
    method: 'GET',
    query: {},
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  };
}

describe('GET /api/me', () => {
  it('returns 401 when no session cookie is sent', async () => {
    const res = mockResWithHeaders();
    await handler(mockReq<typeof handler>({ method: 'GET' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ status: 'unauthorized' });
  });

  it('returns 401 when the session JWT is malformed', async () => {
    const res = mockResWithHeaders();
    await handler({ method: 'GET', headers: { cookie: `${SESSION_COOKIE_NAME}=bogus` } } as any, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the JWT customer was deleted', async () => {
    const res = mockResWithHeaders();
    await handler(await reqWithSession(crypto.randomUUID()), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns customer + null subscription for a one-off customer', async () => {
    const customerId = await makeCustomer();
    const db = getDb();
    await db.insert(visit).values({
      id: crypto.randomUUID(),
      customerId,
      subscriptionId: null,
      scheduledFor: new Date('2026-12-01'),
    });
    const res = mockResWithHeaders();
    await handler(await reqWithSession(customerId), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.customer.id).toBe(customerId);
    expect(res.body.subscription).toBeNull();
    expect(res.body.upcoming_visits).toHaveLength(1);
  });

  it('excludes cancelled and skipped visits from upcoming_visits', async () => {
    const customerId = await makeCustomer();
    const db = getDb();
    // A cadence change cancels old future visits and inserts new scheduled ones.
    // /api/me must only surface actionable visits, not the cancelled clutter.
    await db.insert(visit).values([
      { id: crypto.randomUUID(), customerId, subscriptionId: null, scheduledFor: new Date('2026-12-01'), status: 'scheduled' },
      { id: crypto.randomUUID(), customerId, subscriptionId: null, scheduledFor: new Date('2026-12-08'), status: 'cancelled' },
      { id: crypto.randomUUID(), customerId, subscriptionId: null, scheduledFor: new Date('2026-12-15'), status: 'skipped' },
      { id: crypto.randomUUID(), customerId, subscriptionId: null, scheduledFor: new Date('2026-12-22'), status: 'heading_there' },
    ]);
    const res = mockResWithHeaders();
    await handler(await reqWithSession(customerId), res);
    expect(res.statusCode).toBe(200);
    const statuses = res.body.upcoming_visits.map((v: any) => v.status).sort();
    expect(statuses).toEqual(['heading_there', 'scheduled']);
  });

  it('returns the active subscription and upcoming visits for a recurring customer', async () => {
    const customerId = await makeCustomer();
    const db = getDb();
    const subId = crypto.randomUUID();
    await db.insert(subscription).values({
      id: subId,
      customerId,
      cadence: 'quarterly',
      binCount: 2,
      startedOn: new Date('2026-06-01'),
    });
    await db.insert(visit).values([
      { id: crypto.randomUUID(), customerId, subscriptionId: subId, scheduledFor: new Date('2026-06-05') },
      { id: crypto.randomUUID(), customerId, subscriptionId: subId, scheduledFor: new Date('2026-09-03') },
      { id: crypto.randomUUID(), customerId, subscriptionId: subId, scheduledFor: new Date('2026-12-03') },
      { id: crypto.randomUUID(), customerId, subscriptionId: subId, scheduledFor: new Date('2027-03-04') },
    ]);
    const res = mockResWithHeaders();
    await handler(await reqWithSession(customerId), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.subscription.cadence).toBe('quarterly');
    expect(res.body.subscription.bin_count).toBe(2);
    // 4 quarterly visits = target met, no top-up.
    expect(res.body.upcoming_visits).toHaveLength(4);
  });

  it('tops up the schedule when fewer than the target future visits exist', async () => {
    const customerId = await makeCustomer();
    const db = getDb();
    const subId = crypto.randomUUID();
    await db.insert(subscription).values({
      id: subId,
      customerId,
      cadence: 'quarterly',
      binCount: 1,
      startedOn: new Date('2026-06-01'),
    });
    // Only 2 future visits; quarterly target is 4 → expect top-up to 4.
    await db.insert(visit).values([
      { id: crypto.randomUUID(), customerId, subscriptionId: subId, scheduledFor: new Date('2026-06-05') },
      { id: crypto.randomUUID(), customerId, subscriptionId: subId, scheduledFor: new Date('2026-09-03') },
    ]);
    const res = mockResWithHeaders();
    await handler(await reqWithSession(customerId), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.upcoming_visits).toHaveLength(4);
    // The two NEW visits should each be 91 days (13 weeks) after the prior one,
    // anchored to the latest pre-existing visit (2026-09-03).
    const dates = res.body.upcoming_visits.map((v: any) => new Date(v.scheduled_for).getTime());
    const dayMs = 1000 * 60 * 60 * 24;
    expect((dates[2] - dates[1]) / dayMs).toBe(91);
    expect((dates[3] - dates[2]) / dayMs).toBe(91);
  });

  it('does NOT top up for cancelled subscriptions', async () => {
    const customerId = await makeCustomer();
    const db = getDb();
    const subId = crypto.randomUUID();
    await db.insert(subscription).values({
      id: subId,
      customerId,
      cadence: 'monthly',
      binCount: 1,
      status: 'cancelled',
      startedOn: new Date('2026-06-01'),
    });
    await db.insert(visit).values({
      id: crypto.randomUUID(),
      customerId,
      subscriptionId: subId,
      scheduledFor: new Date('2026-06-05'),
    });
    const res = mockResWithHeaders();
    await handler(await reqWithSession(customerId), res);
    expect(res.statusCode).toBe(200);
    const visitCount = await db.select().from(visit).where(eq(visit.subscriptionId, subId));
    expect(visitCount).toHaveLength(1); // unchanged
  });

  it('returns 405 for an unsupported method (PUT)', async () => {
    const res = mockResWithHeaders();
    await handler(mockReq<typeof handler>({ method: 'PUT' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('POST returns 401 without a session', async () => {
    const res = mockResWithHeaders();
    await handler(mockReq<typeof handler>({ method: 'POST' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('POST returns 503 billing_unavailable when Stripe is not configured', async () => {
    // No STRIPE_SECRET_KEY in the test env → createStripeCustomer returns null,
    // so the SetupIntent path degrades to 503 rather than throwing.
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const customerId = await makeCustomer();
      const req = await reqWithSession(customerId);
      req.method = 'POST';
      const res = mockResWithHeaders();
      await handler(req, res);
      expect(res.statusCode).toBe(503);
      expect(res.body.status).toBe('billing_unavailable');
    } finally {
      if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
    }
  });
});

describe('GET /api/me — referral', () => {
  it('returns the referral code, balance and referred count', async () => {
    const db = getDb();
    const referrerId = await makeCustomer();
    await db.update(customer)
      .set({ referralCode: 'K7M2QX', creditCents: 500 })
      .where(eq(customer.id, referrerId));

    // One friend they referred.
    const friendId = await makeCustomer();
    await db.update(customer).set({ referredBy: referrerId }).where(eq(customer.id, friendId));

    const res = mockResWithHeaders();
    await handler(await reqWithSession(referrerId), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.referral.code).toBe('K7M2QX');
    expect(res.body.referral.credit_cents).toBe(500);
    expect(res.body.referral.referred_count).toBe(1);
  });

  it('reports a zero balance and no referrals for a fresh customer', async () => {
    const id = await makeCustomer();
    const res = mockResWithHeaders();
    await handler(await reqWithSession(id), res);
    expect(res.body.referral.credit_cents).toBe(0);
    expect(res.body.referral.referred_count).toBe(0);
  });
});

describe('GET /api/me — past cleans', () => {
  async function addDoneVisit(customerId: string, date: string, amountCents: number | null, method?: string) {
    const db = getDb();
    const id = crypto.randomUUID();
    await db.insert(visit).values({
      id, customerId, subscriptionId: null, binCount: 1,
      scheduledFor: new Date(`${date}T12:00:00Z`),
      status: 'done', paymentStatus: 'charged', doneAt: new Date(`${date}T18:00:00Z`),
    });
    if (amountCents !== null) {
      await db.insert(payment).values({
        id: crypto.randomUUID(), customerId, visitId: id,
        amountCents, discountCents: 0, creditCents: 0,
        status: 'succeeded', method: (method ?? 'card') as any,
      });
    }
    return id;
  }

  it('returns past cleans newest first with what was charged', async () => {
    const id = await makeCustomer();
    await addDoneVisit(id, '2026-06-10', 3500);
    await addDoneVisit(id, '2026-07-08', 5700);

    const res = mockResWithHeaders();
    await handler(await reqWithSession(id), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.past_visits).toHaveLength(2);
    expect(res.body.past_visits[0].scheduled_for).toBe('2026-07-08');
    expect(res.body.past_visits[0].amount_cents).toBe(5700);
    expect(res.body.past_visits[1].amount_cents).toBe(3500);
  });

  it('does not leak another customer\'s cleans', async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();
    await addDoneVisit(mine, '2026-06-10', 3500);
    await addDoneVisit(theirs, '2026-06-11', 9900);

    const res = mockResWithHeaders();
    await handler(await reqWithSession(mine), res);
    expect(res.body.past_visits).toHaveLength(1);
    expect(res.body.past_visits[0].amount_cents).toBe(3500);
  });

  it('shows a clean with no payment row rather than hiding it', async () => {
    const id = await makeCustomer();
    await addDoneVisit(id, '2026-06-10', null);
    const res = mockResWithHeaders();
    await handler(await reqWithSession(id), res);
    expect(res.body.past_visits).toHaveLength(1);
    expect(res.body.past_visits[0].amount_cents).toBeNull();
  });

  it('is empty for a customer with no history', async () => {
    const id = await makeCustomer();
    const res = mockResWithHeaders();
    await handler(await reqWithSession(id), res);
    expect(res.body.past_visits).toEqual([]);
  });
});
