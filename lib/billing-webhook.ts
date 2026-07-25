import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customer, visit, payment } from '../db/schema.js';
import { sendAndLog } from './notifications.js';
import { refundTemplate } from './email/templates.js';

/**
 * Applies a verified Stripe event to our DB. Kept separate from the HTTP handler
 * so it can be unit-tested against the real (test) DB without signature/stream
 * plumbing. The webhook is the SOURCE OF TRUTH for payment state — the
 * off-session charge call records an optimistic row, but final status lands here.
 *
 * Returns a short tag describing what it did (for logging / test assertions).
 * Unknown event types are a no-op ('ignored').
 */
export async function applyStripeEvent(event: {
  type: string;
  data: { object: Record<string, any> };
}): Promise<string> {
  const db = getDb();
  const obj = event.data.object;

  switch (event.type) {
    // A card was saved (SetupIntent completed). Store it as the default card.
    case 'setup_intent.succeeded': {
      const stripeCustomerId = typeof obj.customer === 'string' ? obj.customer : null;
      const paymentMethodId = typeof obj.payment_method === 'string' ? obj.payment_method : null;
      if (!stripeCustomerId || !paymentMethodId) return 'setup_intent.succeeded:missing_fields';
      await db
        .update(customer)
        .set({ defaultPaymentMethodId: paymentMethodId })
        .where(eq(customer.stripeCustomerId, stripeCustomerId));
      return 'setup_intent.succeeded:applied';
    }

    // Belt-and-suspenders: a payment method attached directly to a customer.
    case 'payment_method.attached': {
      const stripeCustomerId = typeof obj.customer === 'string' ? obj.customer : null;
      const paymentMethodId = typeof obj.id === 'string' ? obj.id : null;
      if (!stripeCustomerId || !paymentMethodId) return 'payment_method.attached:missing_fields';
      // Only set a default if the customer doesn't already have one.
      const [c] = await db
        .select()
        .from(customer)
        .where(eq(customer.stripeCustomerId, stripeCustomerId));
      if (c && !c.defaultPaymentMethodId) {
        await db
          .update(customer)
          .set({ defaultPaymentMethodId: paymentMethodId })
          .where(eq(customer.id, c.id));
      }
      return 'payment_method.attached:applied';
    }

    // A charge settled. Mark the payment row + its visit as paid.
    case 'payment_intent.succeeded': {
      const piId = typeof obj.id === 'string' ? obj.id : null;
      if (!piId) return 'payment_intent.succeeded:missing_id';
      const [p] = await db
        .update(payment)
        .set({ status: 'succeeded', failureReason: null, updatedAt: new Date() })
        .where(eq(payment.stripePaymentIntentId, piId))
        .returning();
      if (p?.visitId) {
        await db.update(visit).set({ paymentStatus: 'charged' }).where(eq(visit.id, p.visitId));
      }
      return p ? 'payment_intent.succeeded:applied' : 'payment_intent.succeeded:no_row';
    }

    // A charge failed (async). Flag the payment row + visit for retry.
    case 'payment_intent.payment_failed': {
      const piId = typeof obj.id === 'string' ? obj.id : null;
      if (!piId) return 'payment_intent.payment_failed:missing_id';
      const reason =
        obj.last_payment_error?.message ?? 'payment_failed';
      const [p] = await db
        .update(payment)
        .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
        .where(eq(payment.stripePaymentIntentId, piId))
        .returning();
      if (p?.visitId) {
        await db.update(visit).set({ paymentStatus: 'failed' }).where(eq(visit.id, p.visitId));
      }
      return p ? 'payment_intent.payment_failed:applied' : 'payment_intent.payment_failed:no_row';
    }

    // A charge was refunded (e.g. from the Stripe dashboard). Flag the payment
    // row + its visit as refunded so the ledger and reconciliation stay correct.
    case 'charge.refunded': {
      const piId = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      if (!piId) return 'charge.refunded:missing_id';
      const [p] = await db
        .update(payment)
        .set({ status: 'refunded', updatedAt: new Date() })
        .where(eq(payment.stripePaymentIntentId, piId))
        .returning();
      if (p?.visitId) {
        await db.update(visit).set({ paymentStatus: 'refunded' }).where(eq(visit.id, p.visitId));
      }
      if (p) {
        // Tell the customer — a refund with no email means they only find out
        // from their bank statement. Best-effort: an email failure must not
        // make the webhook 500 (Stripe would retry the whole event).
        // sendAndLog's (visit_id, kind) idempotency absorbs Stripe redeliveries.
        try {
          const [c] = await db.select().from(customer).where(eq(customer.id, p.customerId));
          if (c) {
            const amountCents =
              typeof obj.amount_refunded === 'number' && obj.amount_refunded > 0
                ? obj.amount_refunded
                : p.amountCents;
            const tpl = refundTemplate({ name: c.name, amountCents });
            await sendAndLog({
              kind: 'refund',
              to: c.email,
              subject: tpl.subject,
              body: tpl.text,
              html: tpl.html,
              customerId: c.id,
              visitId: p.visitId,
            });
          }
        } catch (err) {
          console.error('[billing-webhook] refund email failed (ledger already updated)', err);
        }
      }
      return p ? 'charge.refunded:applied' : 'charge.refunded:no_row';
    }

    // A doorstep QR payment completed on Stripe's hosted page. The session
    // carries our visit id in metadata (set in createDoorstepCheckoutSession).
    case 'checkout.session.completed': {
      const visitId = typeof obj.metadata?.visit_id === 'string' ? obj.metadata.visit_id : null;
      if (!visitId) return 'checkout.session.completed:missing_id';
      if (obj.payment_status !== 'paid') return 'checkout.session.completed:ignored_unpaid';

      const piId = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
      const [p] = await db
        .update(payment)
        .set({
          status: 'succeeded',
          ...(piId ? { stripePaymentIntentId: piId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(payment.visitId, visitId))
        .returning();
      if (!p) return 'checkout.session.completed:no_row';

      await db.update(visit).set({ paymentStatus: 'charged' }).where(eq(visit.id, visitId));
      return 'checkout.session.completed:applied';
    }

    default:
      return 'ignored';
  }
}
