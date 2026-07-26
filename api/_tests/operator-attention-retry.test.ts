import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Mock the Stripe layer so retry charges a fake card without the network.
const mockCharge = vi.fn();
vi.mock('../../lib/stripe.js', () => ({
  isStripeConfigured: () => true,
  getStripe: () => { throw new Error('should not be called in this test'); },
}));
vi.mock('../../lib/billing.js', () => ({
  chargeOffSession: (...args: any[]) => mockCharge(...args),
}));

const { handleAttention, handleRetry } = await import('../../lib/operator-handlers.js');
const { truncateAllForTests } = await import('./_db_cleanup.js');
const { getDb } = await import('../../db/client.js');
const { customer, subscription, visit, payment } = await import('../../db/schema.js');
const { signOperatorCookie, OPERATOR_COOKIE_NAME } = await import('../../lib/operator.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});

beforeEach(async () => {
  await truncateAllForTests();
  mockCharge.mockReset();
});

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  return res;
}

async function authedReq(query: Record<string, string> = {}, body: unknown = {}): Promise<any> {
  const headers: Record<string, string> = { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` };
  return { method: query.method ?? 'GET', headers, query, body };
}

/** Seed a visit with the given payment_status (+ a matching payment row for failed/charged). */
async function seedVisit(opts: {
  paymentStatus: 'failed' | 'charged' | 'unpaid' | 'awaiting_payment';
  withCard?: boolean;
  amountCents?: number;
  /** Defaults to 'done' — most attention scenarios are post-clean. */
  visitStatus?: 'done' | 'scheduled';
}): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `att-${customerId.slice(0, 8)}@e.com`,
    name: 'Pat',
    street: '1 Rd',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
    stripeCustomerId: opts.withCard ? 'cus_test' : null,
    defaultPaymentMethodId: opts.withCard ? 'pm_test' : null,
  });
  const subId = crypto.randomUUID();
  await db.insert(subscription).values({
    id: subId, customerId, cadence: 'monthly', binCount: 1, startedOn: new Date('2026-06-01'),
  });
  const visitId = crypto.randomUUID();
  const visitStatus = opts.visitStatus ?? 'done';
  await db.insert(visit).values({
    id: visitId, customerId, subscriptionId: subId, binCount: null,
    scheduledFor: new Date('2026-06-10'),
    status: visitStatus,
    doneAt: visitStatus === 'done' ? new Date() : null,
    paymentStatus: opts.paymentStatus,
  });
  if (opts.paymentStatus === 'failed' || opts.paymentStatus === 'charged') {
    await db.insert(payment).values({
      id: crypto.randomUUID(), customerId, visitId,
      amountCents: opts.amountCents ?? 3500, discountCents: 0,
      status: opts.paymentStatus === 'failed' ? 'failed' : 'succeeded',
      failureReason: opts.paymentStatus === 'failed' ? 'Your card was declined.' : null,
    });
  }
  return visitId;
}

describe('operator — needs-attention (payment still needs action)', () => {
  it('requires operator auth', async () => {
    const res = mockRes();
    await handleAttention({ method: 'GET', headers: {}, query: {} } as any, res);
    expect(res.statusCode).toBe(401);
  });

  it('lists done visits that are failed, awaiting_payment, or unpaid — but not settled ones or future work', async () => {
    // B5: a forgotten Cash tap (or an ignored QR, or a declined card) used to
    // vanish from every operator view the moment the visit left "Today" —
    // this is the one surface that must catch all three.
    const failedId = await seedVisit({ paymentStatus: 'failed', withCard: true });
    const awaitingId = await seedVisit({ paymentStatus: 'awaiting_payment', withCard: false });
    const unpaidId = await seedVisit({ paymentStatus: 'unpaid', withCard: false }); // nothing collected, done anyway
    await seedVisit({ paymentStatus: 'charged', withCard: true }); // settled — must not show
    // Not yet serviced — defaulting to 'unpaid' must not flood this list with
    // every not-yet-done visit on the route.
    await seedVisit({ paymentStatus: 'unpaid', withCard: true, visitStatus: 'scheduled' });

    const res = mockRes();
    await handleAttention(await authedReq(), res);

    expect(res.statusCode).toBe(200);
    const ids = res.body.visits.map((v: any) => v.id).sort();
    expect(ids).toEqual([awaitingId, failedId, unpaidId].sort());

    const failedEntry = res.body.visits.find((v: any) => v.id === failedId);
    expect(failedEntry).toMatchObject({ amount_cents: 3500, customer: expect.objectContaining({ name: 'Pat' }) });
    expect(failedEntry.failure_reason).toMatch(/declined/i);

    const unpaidEntry = res.body.visits.find((v: any) => v.id === unpaidId);
    expect(unpaidEntry.has_card).toBe(false);
  });
});

describe('operator — retry charge', () => {
  it('re-charges a failed visit and flips it to charged on success', async () => {
    mockCharge.mockResolvedValueOnce({ ok: true, paymentIntentId: 'pi_retry_ok', status: 'succeeded' });
    const visitId = await seedVisit({ paymentStatus: 'failed', withCard: true, amountCents: 3500 });

    const res = mockRes();
    await handleRetry(await authedReq({ id: visitId, method: 'POST' }, {}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.charge).toMatchObject({ ok: true, amount_cents: 3500 });
    expect(mockCharge).toHaveBeenCalledTimes(1);

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('charged');
    const pays = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(pays.some((p) => p.status === 'succeeded')).toBe(true);
  });

  it('keeps the visit failed when the retry also declines', async () => {
    mockCharge.mockResolvedValueOnce({ ok: false, paymentIntentId: 'pi_retry_dec', error: 'declined again' });
    const visitId = await seedVisit({ paymentStatus: 'failed', withCard: true });

    const res = mockRes();
    await handleRetry(await authedReq({ id: visitId, method: 'POST' }, {}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.charge.ok).toBe(false);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('failed');
  });

  it('refuses to retry a visit that is not in a failed state', async () => {
    const visitId = await seedVisit({ paymentStatus: 'charged', withCard: true });
    const res = mockRes();
    await handleRetry(await authedReq({ id: visitId, method: 'POST' }, {}), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('not_failed');
    expect(mockCharge).not.toHaveBeenCalled();
  });
});
