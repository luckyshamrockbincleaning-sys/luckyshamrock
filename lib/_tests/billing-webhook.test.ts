import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applyStripeEvent } from '../billing-webhook.js';
import { truncateAllForTests } from '../../api/_tests/_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit, payment, notificationLog } from '../../db/schema.js';
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

  it('charge.refunded marks the payment + visit as refunded', async () => {
    const cid = await makeCustomer('cus_refund');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_refunded');
    // Start from a settled charge, then refund it from the dashboard.
    const db = getDb();
    await db.update(payment).set({ status: 'succeeded' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'charged' }).where(eq(visit.id, visitId));

    const tag = await applyStripeEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_refunded', refunded: true, amount_refunded: 3500 } },
    });
    expect(tag).toBe('charge.refunded:applied');
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(p!.status).toBe('refunded');
    expect(v!.paymentStatus).toBe('refunded');
  });

  it('charge.refunded sends the customer ONE refund email, even when redelivered', async () => {
    const cid = await makeCustomer('cus_refund2');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_refunded2');
    const db = getDb();
    await db.update(payment).set({ status: 'succeeded' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'charged' }).where(eq(visit.id, visitId));

    const event = {
      type: 'charge.refunded',
      data: { object: { id: 'ch_2', payment_intent: 'pi_refunded2', refunded: true, amount_refunded: 3500 } },
    };
    await applyStripeEvent(event);
    // Stripe retries webhooks — a redelivered event must not double-email.
    await applyStripeEvent(event);

    const logs = await db.select().from(notificationLog).where(eq(notificationLog.customerId, cid));
    const refunds = logs.filter((l) => l.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.visitId).toBe(visitId);
  });

  it('charge.refunded for an unknown intent sends no email', async () => {
    await applyStripeEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_y', payment_intent: 'pi_ghost', refunded: true, amount_refunded: 100 } },
    });
    const logs = await getDb().select().from(notificationLog);
    expect(logs).toHaveLength(0);
  });

  it('charge.refunded for an unknown intent is a safe no-op', async () => {
    const tag = await applyStripeEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_x', payment_intent: 'pi_nonexistent', refunded: true } },
    });
    expect(tag).toBe('charge.refunded:no_row');
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

  it('checkout.session.completed marks the QR payment and visit charged', async () => {
    const cid = await makeCustomer('cus_qr');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_qr_1');
    const db = getDb();
    await db.update(payment).set({ status: 'pending', method: 'qr' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));

    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_status: 'paid', metadata: { visit_id: visitId }, payment_intent: 'pi_qr_1' } },
    });

    expect(tag).toBe('checkout.session.completed:applied');
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(p!.status).toBe('succeeded');
    expect(v!.paymentStatus).toBe('charged');
  });

  it('checkout.session.completed sends exactly ONE receipt email, even when redelivered', async () => {
    // B6: paid.html promises "your receipt is on its way by email" — this is
    // that email. The done email sent at Done time already consumed the
    // (visit_id, 'done') notification_log slot (QR renders no payment
    // sentence there), so this uses a distinct 'receipt' kind.
    const cid = await makeCustomer('cus_qr_receipt');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_qr_receipt');
    const db = getDb();
    await db.update(payment).set({ status: 'pending', method: 'qr' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));

    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_receipt', payment_status: 'paid', metadata: { visit_id: visitId }, payment_intent: 'pi_qr_receipt' } },
    };
    const firstTag = await applyStripeEvent(event);
    expect(firstTag).toBe('checkout.session.completed:applied');

    // Stripe retries webhooks — a redelivered event must not double-email.
    const secondTag = await applyStripeEvent(event);
    expect(secondTag).toBe('checkout.session.completed:no_row');

    const logs = await db.select().from(notificationLog).where(eq(notificationLog.customerId, cid));
    const receipts = logs.filter((l) => l.kind === 'receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.visitId).toBe(visitId);
    // The done email's idempotency slot is untouched by this — proves the two
    // sends use different notification_kind values, not the same one twice.
    const doneLogs = logs.filter((l) => l.kind === 'done');
    expect(doneLogs).toHaveLength(0);
  });

  it('checkout.session.completed settles a walk-up QR payment but sends no receipt to the placeholder email', async () => {
    // N3: the canonical doorstep flow — a stranger flags the truck down,
    // declines to give an email, pays by QR. handleNewJob mints them a
    // walkup+<8hex>@luckyshamrock.ca placeholder so the NOT NULL/UNIQUE
    // constraints hold; mail to it bounces against our own domain. The ledger
    // must still update — only the email send is skipped.
    const cid = crypto.randomUUID();
    const placeholderEmail = `walkup+${cid.slice(0, 8)}@luckyshamrock.ca`;
    await getDb().insert(customer).values({
      id: cid,
      email: placeholderEmail,
      name: 'Walk-up customer',
      street: 'Curb',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L1A1',
      pickupDay: 'wednesday',
    });
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_qr_walkup');
    const db = getDb();
    await db.update(payment).set({ status: 'pending', method: 'qr' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));

    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_walkup', payment_status: 'paid', metadata: { visit_id: visitId }, payment_intent: 'pi_qr_walkup' } },
    });

    // Ledger updates regardless — the guard is on the email send only.
    expect(tag).toBe('checkout.session.completed:applied');
    const [p] = await db.select().from(payment).where(eq(payment.id, paymentId));
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(p!.status).toBe('succeeded');
    expect(v!.paymentStatus).toBe('charged');

    const logs = await db.select().from(notificationLog).where(eq(notificationLog.customerId, cid));
    expect(logs.filter((l) => l.kind === 'receipt')).toHaveLength(0);
  });

  it('checkout.session.completed for an unknown visit is a safe no-op', async () => {
    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', payment_status: 'paid', metadata: { visit_id: crypto.randomUUID() } } },
    });
    expect(tag).toBe('checkout.session.completed:no_row');
  });

  it('ignores an unpaid checkout session', async () => {
    const cid = await makeCustomer('cus_qr2');
    const { visitId } = await makeVisitWithPayment(cid, 'pi_qr_2');
    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', payment_status: 'unpaid', metadata: { visit_id: visitId } } },
    });
    expect(tag).toBe('checkout.session.completed:ignored_unpaid');
  });

  it('checkout.session.completed is safe when redelivered by Stripe (idempotent)', async () => {
    const cid = await makeCustomer('cus_qr3');
    const { visitId, paymentId } = await makeVisitWithPayment(cid, 'pi_qr_3');
    const db = getDb();
    await db.update(payment).set({ status: 'pending', method: 'qr' }).where(eq(payment.id, paymentId));
    await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));

    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_3', payment_status: 'paid', metadata: { visit_id: visitId }, payment_intent: 'pi_qr_3' } },
    };

    const firstTag = await applyStripeEvent(event);
    expect(firstTag).toBe('checkout.session.completed:applied');

    // Stripe redelivers the same event — this must not throw (e.g. from a
    // duplicate stripePaymentIntentId write) and must not corrupt state.
    const secondTag = await applyStripeEvent(event);
    // The row is no longer 'pending' after the first delivery, so the scoped
    // WHERE finds nothing on redelivery — a safe no-op since state is already
    // final.
    expect(secondTag).toBe('checkout.session.completed:no_row');

    const rows = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('succeeded');
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('charged');
  });

  it('checkout.session.completed only settles the pending QR row, leaving an unrelated failed card payment untouched', async () => {
    const cid = await makeCustomer('cus_qr4');
    const { visitId, paymentId: cardPaymentId } = await makeVisitWithPayment(cid, 'pi_card_failed');
    const db = getDb();
    // An unrelated failed card-method payment row on the same visit (e.g. a
    // previous in-person attempt that got declined).
    await db
      .update(payment)
      .set({ status: 'failed', method: 'card', failureReason: 'Your card was declined.' })
      .where(eq(payment.id, cardPaymentId));

    // The pending QR row this event should actually settle.
    const qrPaymentId = crypto.randomUUID();
    await db.insert(payment).values({
      id: qrPaymentId,
      customerId: cid,
      visitId,
      stripePaymentIntentId: null,
      amountCents: 3500,
      status: 'pending',
      method: 'qr',
    });
    await db.update(visit).set({ paymentStatus: 'awaiting_payment' }).where(eq(visit.id, visitId));

    const tag = await applyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_4', payment_status: 'paid', metadata: { visit_id: visitId }, payment_intent: 'pi_qr_4' } },
    });
    expect(tag).toBe('checkout.session.completed:applied');

    const [cardRow] = await db.select().from(payment).where(eq(payment.id, cardPaymentId));
    const [qrRow] = await db.select().from(payment).where(eq(payment.id, qrPaymentId));
    expect(cardRow!.status).toBe('failed');
    expect(qrRow!.status).toBe('succeeded');
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('charged');
  });
});
