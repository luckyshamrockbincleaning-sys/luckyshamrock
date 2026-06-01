import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, gte, asc, desc, inArray } from 'drizzle-orm';
import { addWeeks } from 'date-fns';
import { getDb } from '../db/client.js';
import { customer, subscription, visit } from '../db/schema.js';
import { getSessionCustomerId } from '../lib/session.js';
import type { Cadence } from '../lib/schedule.js';

const FUTURE_VISIT_TARGET: Record<Cadence, number> = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
};

const CADENCE_WEEKS: Record<Cadence, number> = {
  monthly: 4,
  bimonthly: 8,
  quarterly: 13,
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const customerId = await getSessionCustomerId(req);
  if (!customerId) {
    res.status(401).json({ status: 'unauthorized' });
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
        const anchorDate = anchor?.scheduledFor ?? today;
        const stepWeeks = CADENCE_WEEKS[sub.cadence];
        const newRows = Array.from({ length: deficit }, (_, i) => ({
          id: crypto.randomUUID(),
          customerId,
          subscriptionId: sub.id,
          scheduledFor: addWeeks(anchorDate, (i + 1) * stepWeeks),
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

    res.status(200).json({
      status: 'ok',
      customer: {
        id: me.id,
        email: me.email,
        name: me.name,
        phone: me.phone,
        street: me.street,
        city: me.city,
        postal_code: me.postalCode,
        pickup_day: me.pickupDay,
      },
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
    });
  } catch (err) {
    console.error('[me] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
