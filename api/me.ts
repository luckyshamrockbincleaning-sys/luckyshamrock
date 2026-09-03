import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, gte, asc, desc, inArray, sql } from 'drizzle-orm';
import { addWeeks } from 'date-fns';
import { getDb } from '../db/client.js';
import { customer, subscription, visit, payment } from '../db/schema.js';
import { getSessionCustomerId } from '../lib/session.js';
import { formatClearSessionCookieHeader } from '../lib/cookies.js';
import { generateSeasonalDates, type Cadence } from '../lib/schedule.js';
import { effectiveStartDate } from '../lib/launch.js';
import { isInSeason, seasonEnd, nextSeasonStart, SEASON_LABEL } from '../lib/season.js';
import { createStripeCustomer, createSetupIntent } from '../lib/billing.js';
import { isStripeConfigured } from '../lib/stripe.js';

// How many past cleans /manage shows. This list only grows, and nobody scrolls
// past a dozen — the done emails remain the full archive.
const PAST_VISIT_LIMIT = 12;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD at UTC noon, rejecting non-dates that match the regex. */
function parseDateOnlyUtcNoon(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function todayUtcNoon(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 12, 0, 0));
}

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

  // POST /api/me {op:'reschedule'} → move one clean to a different day.
  //
  // Folded into this route rather than a new file: the project is at 12/12
  // Vercel Hobby functions, and api/visit/[id]/skip.ts cannot host it because
  // its path segment is literally "skip". Same reason logout and card setup
  // live here.
  //
  // Deliberately moves ONLY the named visit. A recurring customer changing one
  // awkward date does not want their whole year shifted; the rest of the
  // schedule keeps its rhythm.
  if (req.method === 'POST' && req.body?.op === 'reschedule') {
    const visitId = typeof req.body?.visit_id === 'string' ? req.body.visit_id : '';
    const date = typeof req.body?.date === 'string' ? req.body.date : '';
    if (!visitId || !DATE_ONLY_RE.test(date)) {
      res.status(400).json({ status: 'invalid', message: 'visit_id and date (YYYY-MM-DD) are required.' });
      return;
    }
    const target = parseDateOnlyUtcNoon(date);
    if (!target) {
      res.status(400).json({ status: 'invalid', message: 'That is not a real date.' });
      return;
    }
    if (target < todayUtcNoon()) {
      res.status(400).json({ status: 'invalid', message: 'Pick a date in the future.' });
      return;
    }
    if (target.getUTCDay() === 0) {
      res.status(400).json({ status: 'invalid', message: "We don't clean on Sundays — pick another day." });
      return;
    }
    if (!isInSeason(target)) {
      res.status(422).json({
        status: 'out_of_season',
        message: 'Our cleaning season runs May 1 to October 31. Please pick a date in that window.',
      });
      return;
    }
    try {
      const db = getDb();
      const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
      if (!v) {
        res.status(404).json({ status: 'not_found' });
        return;
      }
      if (v.customerId !== customerId) {
        res.status(422).json({ status: 'not_yours', message: 'visit does not belong to the signed-in customer' });
        return;
      }
      if (v.status !== 'scheduled' && v.status !== 'heading_there') {
        res.status(409).json({ status: 'not_reschedulable', message: `This clean is ${v.status}.` });
        return;
      }
      await db.update(visit).set({ scheduledFor: target }).where(eq(visit.id, visitId));
      res.status(200).json({ status: 'ok', scheduled_for: date });
    } catch (err) {
      console.error('[me:reschedule] failed', err);
      res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
    }
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
        // Two limits, both load-bearing.
        //
        // 1. In-season only: without this the top-up cheerfully books cleans
        //    through an Alberta winter, and it would silently UNDO any manual
        //    cleanup the next time the customer opened this page.
        // 2. Current season only: a customer mid-season must not see next
        //    year's dates appear months early. Their winter view says "paused
        //    until May"; next season is generated when it opens.
        const cutoff = seasonEnd(today);
        newDates = newDates.filter((d) => {
          if (!isInSeason(d)) return false;
          // The Three Wash Season is an annual product (May/Jul/Sep); its
          // washes legitimately cross into next year. Only the rolling
          // cadences are held to the current season.
          if (sub.cadence === 'seasonal') return true;
          return d <= cutoff;
        });

        if (newDates.length > 0) {
          const newRows = newDates.map((scheduledFor) => ({
            id: crypto.randomUUID(),
            customerId,
            subscriptionId: sub.id,
            scheduledFor,
          }));
          await db.insert(visit).values(newRows);
        }
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
            // Needed by /manage's bin steppers. Without it the page would seed
            // from the count alone and a save would overwrite the customer's
            // real bins with a list they never chose.
            bin_types: sub.binTypes ?? null,
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
      // Season state, so /manage can explain a winter with no visits rather
      // than showing a bare "Nothing scheduled." to an active subscriber.
      season: {
        in_season: isInSeason(new Date()),
        label: SEASON_LABEL,
        next_start: nextSeasonStart(new Date()).toISOString().slice(0, 10),
      },
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
