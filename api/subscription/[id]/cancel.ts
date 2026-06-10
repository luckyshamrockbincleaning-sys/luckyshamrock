import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { subscription, visit } from '../../../db/schema.js';
import { getSessionCustomerId } from '../../../lib/session.js';

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
    if (sub.status === 'cancelled') {
      res.status(409).json({ status: 'already_cancelled', message: 'subscription is already cancelled' });
      return;
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    await db.transaction(async (tx) => {
      await tx
        .update(subscription)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(subscription.id, subId));
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
    });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[subscription/cancel] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
