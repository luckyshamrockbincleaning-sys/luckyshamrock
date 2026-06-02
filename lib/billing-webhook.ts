import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customer, visit, payment } from '../db/schema.js';

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

    default:
      return 'ignored';
  }
}
