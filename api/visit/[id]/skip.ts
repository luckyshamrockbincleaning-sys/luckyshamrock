import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { addWeeks } from 'date-fns';
import { getDb } from '../../../db/client.js';
import { visit, subscription, customer } from '../../../db/schema.js';
import { getSessionCustomerId } from '../../../lib/session.js';
import { generateSeasonalDates, type Cadence } from '../../../lib/schedule.js';

const CADENCE_WEEKS: Record<Exclude<Cadence, 'seasonal'>, number> = {
  monthly: 4,
  bimonthly: 8,
  quarterly: 13,
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const customerId = await getSessionCustomerId(req);
  if (!customerId) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  const visitId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!visitId) {
    res.status(400).json({ status: 'invalid', message: 'missing visit id' });
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
    if (v.status !== 'scheduled') {
      res.status(409).json({ status: 'not_scheduled', message: `visit is ${v.status}, cannot skip` });
      return;
    }

    // A one-off visit has no recurring schedule to roll forward, so "skip" means
    // cancel it outright — there's no replacement.
    if (!v.subscriptionId) {
      await db.update(visit).set({ status: 'cancelled' }).where(eq(visit.id, visitId));
      res.status(200).json({ status: 'ok', cancelled: true });
      return;
    }

    const [sub] = await db.select().from(subscription).where(eq(subscription.id, v.subscriptionId));
    if (!sub) {
      // subscription_id set but sub vanished — shouldn't happen given onDelete restrict.
      res.status(500).json({ status: 'error', message: 'visit references missing subscription' });
      return;
    }

    // Replacement = one cadence interval later. Seasonal plans skip to the next
    // Apr/Jul/Sep window rather than a fixed number of weeks.
    let replacementDate: Date;
    if (sub.cadence === 'seasonal') {
      const [c] = await db.select().from(customer).where(eq(customer.id, customerId));
      if (!c) {
        res.status(500).json({ status: 'error', message: 'customer row vanished' });
        return;
      }
      replacementDate = generateSeasonalDates({ startDate: v.scheduledFor, pickupDay: c.pickupDay, count: 1 })[0]!;
    } else {
      replacementDate = addWeeks(v.scheduledFor, CADENCE_WEEKS[sub.cadence]);
    }

    await db.transaction(async (tx) => {
      await tx.update(visit).set({ status: 'skipped' }).where(eq(visit.id, visitId));
      await tx.insert(visit).values({
        id: crypto.randomUUID(),
        customerId,
        subscriptionId: v.subscriptionId,
        scheduledFor: replacementDate,
      });
    });

    res.status(200).json({ status: 'ok', replacement_date: replacementDate.toISOString().slice(0, 10) });
  } catch (err) {
    console.error('[visit/skip] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
