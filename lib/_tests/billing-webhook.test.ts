import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applyStripeEvent } from '../billing-webhook.js';
import { truncateAllForTests } from '../../api/_tests/_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit, payment } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});

beforeEach(async () => {
  await truncateAllForTests();
});

async function makeCustomer(stripeCustomerId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(customer).values({
    id,
    email: `c-${id.slice(0, 8)}@e.com`,
    name: 'C',
    street: 'X',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
    stripeCustomerId,
  });
  return id;
}

async function makeVisitWithPayment(customerId: string, piId: string): Promise<{ visitId: string; paymentId: string }> {
  const db = getDb();
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: null,
    scheduledFor: new Date('2026-07-02'),
    status: 'done',
    paymentStatus: 'unpaid',
  });
  const paymentId = crypto.randomUUID();
  await db.insert(payment).values({
    id: paymentId,
    customerId,
    visitId,
    stripePaymentIntentId: piId,
    amountCents: 3500,
    status: 'pending',
  });
  return { visitId, paymentId };
}

describe('applyStripeEvent', () => {
  it('setup_intent.succeeded stores the default payment method on the customer', async () => {
    const id = await makeCustomer('cus_abc');
    const tag = await applyStripeEvent({
      type: 'setup_intent.succeeded',
      data: { object: { customer: 'cus_abc', payment_method: 'pm_xyz' } },
    });
    expect(tag).toBe('setup_intent.succeeded:applied');
    const [c] = await getDb().select().from(customer).where(eq(customer.id, id));
    expect(c!.defaultPaymentMethodId).toBe('pm_xyz');
  });

  it('payment_intent.succeeded marks the payment + visit as charged', async () => {
    const cid = await makeCustomer('cus_1');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_success');
    const tag = await applyStripeEvent({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_success' } },
    });
    expect(tag).toBe('payment_intent.succeeded:applied');
    const db = getDb();
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(p!.status).toBe('succeeded');
    expect(v!.paymentStatus).toBe('charged');
  });

  it('payment_intent.payment_failed flags the payment + visit as failed', async () => {
    const cid = await makeCustomer('cus_2');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_fail');
    const tag = await applyStripeEvent({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail', last_payment_error: { message: 'Your card was declined.' } } },
    });
    expect(tag).toBe('payment_intent.payment_failed:applied');
    const db = getDb();
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(p!.status).toBe('failed');
    expect(p!.failureReason).toMatch(/declined/i);
    expect(v!.paymentStatus).toBe('failed');
  });

  it('ignores unknown event types', async () => {
    const tag = await applyStripeEvent({ type: 'invoice.created', data: { object: {} } });
    expect(tag).toBe('ignored');
  });

  it('payment_intent.succeeded for an unknown intent is a safe no-op', async () => {
    const tag = await applyStripeEvent({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_nonexistent' } },
    });
    expect(tag).toBe('payment_intent.succeeded:no_row');
  });
});
