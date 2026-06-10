import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Mock the Stripe layer so "Done" charges a fake card without the network.
const mockCharge = vi.fn();
vi.mock('../../lib/stripe.js', () => ({
  isStripeConfigured: () => true,
  getStripe: () => { throw new Error('should not be called in this test'); },
}));
vi.mock('../../lib/billing.js', () => ({
  chargeOffSession: (...args: any[]) => mockCharge(...args),
}));

const { handleDone: handler } = await import('../../lib/operator-handlers.js');
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

async function req(body: unknown = {}): Promise<any> {
  const headers: Record<string, string> = { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` };
  return { method: 'POST', headers, query: { id: REQ_ID }, body };
}

let REQ_ID = '';

async function seed(opts: { withCard?: boolean; cadence?: string; binCount?: number; oneoff?: boolean } = {}): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `pay-${customerId.slice(0, 8)}@e.com`,
    name: 'Pat',
    street: '1 Rd',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
    stripeCustomerId: opts.withCard ? 'cus_test' : null,
    defaultPaymentMethodId: opts.withCard ? 'pm_test' : null,
  });
  let subId: string | null = null;
  if (!opts.oneoff) {
    subId = crypto.randomUUID();
    await db.insert(subscription).values({
      id: subId,
      customerId,
      cadence: (opts.cadence ?? 'monthly') as any,
      binCount: opts.binCount ?? 1,
      startedOn: new Date('2026-06-01'),
    });
  }
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: subId,
    binCount: opts.oneoff ? (opts.binCount ?? 1) : null,
    scheduledFor: new Date('2026-06-10'),
    status: 'scheduled',
  });
  REQ_ID = visitId;
  return visitId;
}

describe('operator Done — auto-charge', () => {
  it('charges the card on file for a monthly clean ($35) and records a succeeded payment', async () => {
    mockCharge.mockResolvedValueOnce({ ok: true, paymentIntentId: 'pi_ok', status: 'succeeded' });
    const visitId = await seed({ withCard: true, cadence: 'monthly', binCount: 1 });
    const res = mockRes();
    await handler(await req(), res);

    expect(res.statusCode).toBe(200);
    expect(mockCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3500, stripeCustomerId: 'cus_test', paymentMethodId: 'pm_test' }));
    expect(res.body.charge).toMatchObject({ attempted: true, ok: true, amount_cents: 3500 });

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('charged');
    const pays = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.status).toBe('succeeded');
    expect(pays[0]!.amountCents).toBe(3500);
  });

  it('charges extra bins at $12 each instead of full plan price', async () => {
    mockCharge.mockResolvedValueOnce({ ok: true, paymentIntentId: 'pi_extra', status: 'succeeded' });
    await seed({ withCard: true, cadence: 'monthly', binCount: 3 });
    const res = mockRes();
    await handler(await req(), res);

    expect(res.statusCode).toBe(200);
    expect(mockCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5900 }));
    expect(res.body.charge).toMatchObject({ attempted: true, ok: true, amount_cents: 5900 });
  });

  it('applies an on-the-spot discount before charging', async () => {
    mockCharge.mockResolvedValueOnce({ ok: true, paymentIntentId: 'pi_disc', status: 'succeeded' });
    await seed({ withCard: true, cadence: 'monthly', binCount: 1 });
    const res = mockRes();
    await handler(await req({ discount_cents: 1000 }), res);
    expect(mockCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2500 })); // 3500 - 1000
    expect(res.body.charge.amount_cents).toBe(2500);
  });

  it('comps the visit (no Stripe call) when discount covers the full amount', async () => {
    const visitId = await seed({ withCard: true, cadence: 'monthly', binCount: 1 });
    const res = mockRes();
    await handler(await req({ discount_cents: 99999 }), res);
    expect(mockCharge).not.toHaveBeenCalled();
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('comped');
  });

  it('marks done + flags failed (does NOT block) when the card is declined', async () => {
    mockCharge.mockResolvedValueOnce({ ok: false, paymentIntentId: 'pi_dec', error: 'Your card was declined.' });
    const visitId = await seed({ withCard: true });
    const res = mockRes();
    await handler(await req(), res);
    expect(res.statusCode).toBe(200); // clean still completes
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('failed');
    const pays = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(pays[0]!.status).toBe('failed');
  });

  it('does not charge when the customer has no card on file', async () => {
    const visitId = await seed({ withCard: false });
    const res = mockRes();
    await handler(await req(), res);
    expect(mockCharge).not.toHaveBeenCalled();
    expect(res.body.charge).toMatchObject({ attempted: false });
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('unpaid');
  });

  it('charges a one-off at the $45 rate', async () => {
    mockCharge.mockResolvedValueOnce({ ok: true, paymentIntentId: 'pi_one', status: 'succeeded' });
    await seed({ withCard: true, oneoff: true, binCount: 1 });
    const res = mockRes();
    await handler(await req(), res);
    expect(mockCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4500 }));
  });

  it('two concurrent Done taps charge once — the loser gets 409, not a 500', async () => {
    mockCharge.mockResolvedValue({ ok: true, paymentIntentId: 'pi_race', status: 'succeeded' });
    const visitId = await seed({ withCard: true, cadence: 'monthly', binCount: 1 });
    const res1 = mockRes();
    const res2 = mockRes();
    await Promise.all([handler(await req(), res1), handler(await req(), res2)]);

    const codes = [res1.statusCode, res2.statusCode].sort();
    expect(codes).toEqual([200, 409]); // one wins, one is not_actionable — never a 500
    expect(mockCharge).toHaveBeenCalledTimes(1);

    const db = getDb();
    const pays = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(pays).toHaveLength(1);
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('charged');
  });

  it('leaves a pending ledger row when the charge call throws mid-flight', async () => {
    // chargeOffSession normally never throws, but if the function dies between
    // the Stripe call and recording the result, a pending row must already exist
    // so the webhook can reconcile (no charge-without-ledger-row).
    mockCharge.mockRejectedValueOnce(new Error('network blip'));
    const visitId = await seed({ withCard: true, cadence: 'monthly', binCount: 1 });
    const res = mockRes();
    await handler(await req(), res);

    const db = getDb();
    const pays = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.status).toBe('pending');
  });
});
