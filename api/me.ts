import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, gte, asc, desc, inArray, sql } from 'drizzle-orm';
import { addWeeks } from 'date-fns';
import { getDb } from '../db/client.js';
import { customer, subscription, visit, payment } from '../db/schema.js';
import { getSessionCustomerId } from '../lib/session.js';
import { formatClearSessionCookieHeader } from '../lib/cookies.js';
import { generateSeasonalDates, type Cadence } from '../lib/schedule.js';
import { effectiveStartDate } from '../lib/launch.js';
import { createStripeCustomer, createSetupIntent } from '../lib/billing.js';
import { isStripeConfigured } from '../lib/stripe.js';

// How many past cleans /manage shows. This list only grows, and nobody scrolls
// past a dozen — the done emails remain the full archive.
const PAST_VISIT_LIMIT = 12;

const FUTURE_VISIT_TARGET: Record<Cadence, number> = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  seasonal: 3,
};

const CADENCE_WEEKS: Record<Exclude<Cadence, 'seasonal'>, number> = {
  monthly: 4,
  bimonthly: 8,
  quarterly: 13,
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // POST /api/me {op:'logout'} clears the session cookie. Folded in here
  // (replacing the old /api/logout function) to free a slot under Vercel
  // Hobby's 12-function cap. Deliberately requires no valid session — logging
  // out with a dead cookie should still succeed.
  if (req.method === 'POST' && req.body?.op === 'logout') {
    res.setHeader('Set-Cookie', formatClearSessionCookieHeader());
    res.status(200).json({ status: 'ok' });
    return;
  }

  const customerId = await getSessionCustomerId(req);
  if (!customerId) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  // POST /api/me → create a SetupIntent so the customer can save a card on file.
  // Folded into this route (rather than a new function) to stay under Vercel
  // Hobby's 12-function cap. Provisions a Stripe Customer on the fly if needed.
  if (req.method === 'POST') {
    try {
      const db = getDb();
      const [me] = await db.select().from(customer).where(eq(customer.id, customerId));
      if (!me) {
        res.status(401).json({ status: 'unauthorized' });
        return;
      }
      let stripeCustomerId = me.stripeCustomerId;
      if (!stripeCustomerId) {
        stripeCustomerId = await createStripeCustomer({ email: me.email, name: me.name, phone: me.phone });
        if (stripeCustomerId) {
          await db.update(customer).set({ stripeCustomerId }).where(eq(customer.id, customerId));
        }
      }
      if (!stripeCustomerId) {
        res.status(503).json({ status: 'billing_unavailable', message: 'Card payments are not set up yet.' });
        return;
      }
      const setup = await createSetupIntent(stripeCustomerId);
      if (!setup) {
        res.status(503).json({ status: 'billing_unavailable', message: 'Card payments are not set up yet.' });
        return;
      }
      res.status(200).json({ status: 'ok', client_secret: setup.clientSecret, publishable_key: setup.publishableKey });
    } catch (err) {
      console.error('[me:setup] failed', err);
      res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
    }
    return;
  }

  try {
    const db = getDb();

    const [me] = await db.select().from(customer).where(eq(customer.id, customerId));
    if (!me) {
      // Session is valid JWT but the customer was deleted — treat as 401.
      res.status(401).json({ status: 'unauthorized' });
      return;
    }

    const [sub] = await db
      .select()
      .from(subscription)
      .where(eq(subscription.customerId, customerId))
      .orderBy(desc(subscription.createdAt))
      .limit(1);

    // Top up the schedule if needed (only for active recurring subs).
    if (sub && sub.status === 'active') {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const futureVisits = await db
        .select()
        .from(visit)
        .where(
          and(
            eq(visit.subscriptionId, sub.id),
            gte(visit.scheduledFor, today),
            eq(visit.status, 'scheduled'),
          ),
        )
        .orderBy(asc(visit.scheduledFor));

      const target = FUTURE_VISIT_TARGET[sub.cadence];
      const deficit = target - futureVisits.length;
      if (deficit > 0) {
        // Anchor to the latest scheduled visit (future or past), else today.
        const [anchor] = await db
          .select()
          .from(visit)
          .where(eq(visit.subscriptionId, sub.id))
          .orderBy(desc(visit.scheduledFor))
          .limit(1);
        const anchorDate = effectiveStartDate(anchor?.scheduledFor ?? today);
        let newDates: Date[];
        if (sub.cadence === 'seasonal') {
          // Seasonal: extend with the next `deficit` Apr/Jul/Sep washes after the anchor.
          newDates = generateSeasonalDates({ startDate: anchorDate, pickupDay: me.pickupDay, count: deficit });
        } else {
          const stepWeeks = CADENCE_WEEKS[sub.cadence];
          newDates = Array.from({ length: deficit }, (_, i) => addWeeks(anchorDate, (i + 1) * stepWeeks));
        }
        const newRows = newDates.map((scheduledFor) => ({
          id: crypto.randomUUID(),
          customerId,
          subscriptionId: sub.id,
          scheduledFor,
        }));
        await db.insert(visit).values(newRows);
      }
    }

    const today2 = new Date();
    today2.setUTCHours(0, 0, 0, 0);
    // Only surface actionable visits. Cancelled/skipped/done visits are clutter
    // on the manage page — after a cadence change the old future visits get
    // cancelled, and showing them made the schedule look unchanged.
    const upcoming = await db
      .select()
      .from(visit)
      .where(
        and(
          eq(visit.customerId, customerId),
          gte(visit.scheduledFor, today2),
          inArray(visit.status, ['scheduled', 'heading_there']),
        ),
      )
      .orderBy(asc(visit.scheduledFor));

    // Surface any clean whose card charge failed so /manage can prompt the
    // customer to update their card (a declined charge never blocks the clean,
    // so this is the only place they'd find out).
    const failedVisits = await db
      .select({ id: visit.id })
      .from(visit)
      .where(and(eq(visit.customerId, customerId), eq(visit.paymentStatus, 'failed')));

    // Past cleans — the customer's own service record. Until now a visit
    // vanished from /manage the moment it was done, so somebody charged $57 had
    // nothing to look back at: the done email was the only receipt they ever
    // got, and if it was lost there was no other trace. Newest first, capped —
    // this list only grows.
    //
    // `done` only: a cancelled or skipped visit is a plan change, not a clean
    // they received. (Cancelling a subscription also sweeps a dozen FUTURE
    // visits to `cancelled`, which would flood this list — the same trap the
    // operator history hit against real data.)
    const pastVisits = await db
      .select({
        id: visit.id,
        scheduledFor: visit.scheduledFor,
        doneAt: visit.doneAt,
        paymentStatus: visit.paymentStatus,
        amountCents: payment.amountCents,
        creditCents: payment.creditCents,
        method: payment.method,
      })
      .from(visit)
      // A visit can hold several payment rows (a decline then a retry); the
      // settled one is what the customer actually paid.
      .leftJoin(payment, and(eq(payment.visitId, visit.id), eq(payment.status, 'succeeded')))
      .where(and(eq(visit.customerId, customerId), eq(visit.status, 'done')))
      .orderBy(desc(visit.scheduledFor))
      .limit(PAST_VISIT_LIMIT);

    // How many people this customer has sent our way. Counts everyone who
    // booked with their code, whether or not the reward has been earned yet —
    // "3 neighbours referred" is the motivating number, not "3 paid out".
    const [referredCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customer)
      .where(eq(customer.referredBy, customerId));

    res.status(200).json({
      status: 'ok',
      referral: {
        code: me.referralCode,
        credit_cents: me.creditCents,
        referred_count: referredCount?.n ?? 0,
      },
      customer: {
        id: me.id,
        email: me.email,
        name: me.name,
        phone: me.phone,
        street: me.street,
        city: me.city,
        postal_code: me.postalCode,
        pickup_day: me.pickupDay,
        has_card: Boolean(me.defaultPaymentMethodId),
      },
      billing_enabled: isStripeConfigured(),
      subscription: sub
        ? {
            id: sub.id,
            cadence: sub.cadence,
            bin_count: sub.binCount,
            status: sub.status,
            started_on: sub.startedOn,
          }
        : null,
      upcoming_visits: upcoming.map((v) => ({
        id: v.id,
        scheduled_for: v.scheduledFor,
        status: v.status,
        subscription_id: v.subscriptionId,
        notes: v.notes,
      })),
      past_visits: pastVisits.map((v) => ({
        id: v.id,
        scheduled_for: v.scheduledFor.toISOString().slice(0, 10),
        done_at: v.doneAt,
        payment_status: v.paymentStatus,
        amount_cents: v.amountCents ?? null,
        credit_cents: v.creditCents ?? 0,
        payment_method: v.method ?? null,
      })),
      payment_alert: failedVisits.length > 0 ? { failed_count: failedVisits.length } : null,
    });
  } catch (err) {
    console.error('[me] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
