import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { and, eq, gte } from 'drizzle-orm';
import { addWeeks } from 'date-fns';
import { getDb } from '../../../db/client.js';
import { customer, subscription, visit } from '../../../db/schema.js';
import { getSessionCustomerId } from '../../../lib/session.js';
import { generateVisitDates, generateSeasonalDates, type Cadence } from '../../../lib/schedule.js';
import { effectiveStartDate } from '../../../lib/launch.js';

const updateSchema = z
  .object({
    // Only SOLD plans are switchable-into (mirrors lib/validation.ts planField).
    // bimonthly/quarterly stay in the DB enum for legacy subs, but those bill at
    // legacy prices the storefront never shows — a customer must not be able to
    // switch into one from /manage.
    cadence: z.enum(['monthly', 'seasonal']).optional(),
    bin_count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .refine((d) => d.cadence !== undefined || d.bin_count !== undefined, {
    message: 'one of cadence or bin_count must be present',
  });

const FUTURE_VISIT_TARGET: Record<Cadence, number> = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  seasonal: 3,
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

  const subId = typeof req.query.id === 'string' ? req.query.id : null;
  if (!subId) {
    res.status(400).json({ status: 'invalid', message: 'missing subscription id' });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const db = getDb();

    const [sub] = await db.select().from(subscription).where(eq(subscription.id, subId));
    if (!sub) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (sub.customerId !== customerId) {
      res.status(422).json({ status: 'not_yours', message: 'subscription does not belong to the signed-in customer' });
      return;
    }
    if (sub.status !== 'active') {
      res.status(409).json({ status: 'not_active', message: `subscription is ${sub.status}` });
      return;
    }

    const today = effectiveStartDate(); // floored pre-launch; no-op after 2026-07-23
    today.setUTCHours(0, 0, 0, 0);

    const cadenceChanged = parsed.data.cadence !== undefined && parsed.data.cadence !== sub.cadence;
    const newCadence = (parsed.data.cadence ?? sub.cadence) as Cadence;
    const newBinCount = parsed.data.bin_count ?? sub.binCount;

    await db.transaction(async (tx) => {
      await tx
        .update(subscription)
        .set({ cadence: newCadence, binCount: newBinCount })
        .where(eq(subscription.id, subId));

      if (cadenceChanged) {
        // Cancel all future-scheduled visits, then regenerate from today using the new cadence.
        await tx
          .update(visit)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(visit.subscriptionId, subId),
              eq(visit.status, 'scheduled'),
              gte(visit.scheduledFor, today),
            ),
          );

        const [c] = await tx.select().from(customer).where(eq(customer.id, customerId));
        if (!c) throw new Error('customer row vanished mid-update');

        const dates =
          newCadence === 'seasonal'
            ? generateSeasonalDates({ startDate: today, pickupDay: c.pickupDay, count: FUTURE_VISIT_TARGET.seasonal })
            : generateVisitDates({
                startDate: today,
                pickupDay: c.pickupDay,
                cadence: newCadence,
                count: FUTURE_VISIT_TARGET[newCadence],
              });
        await tx.insert(visit).values(
          dates.map((scheduledFor) => ({
            id: crypto.randomUUID(),
            customerId,
            subscriptionId: subId,
            scheduledFor,
          })),
        );
      }
    });

    res.status(200).json({ status: 'ok', cadence: newCadence, bin_count: newBinCount });
  } catch (err) {
    console.error('[subscription/update] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
