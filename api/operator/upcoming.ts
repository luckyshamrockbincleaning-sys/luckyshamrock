import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, gte, lte, ne, asc } from 'drizzle-orm';
import { addDays } from 'date-fns';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { getOperatorSession, operatorTodayISO, toOperatorVisit } from '../../lib/operator.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  try {
    const q = req.query.date;
    const anchorISO = typeof q === 'string' && DATE_RE.test(q) ? q : operatorTodayISO();
    const anchor = new Date(`${anchorISO}T00:00:00Z`);

    let days = parseInt(String(req.query.days ?? ''), 10);
    if (!Number.isFinite(days)) days = 7;
    days = Math.max(1, Math.min(60, days));

    // Tomorrow through anchor+days, inclusive. Today is covered by /today.
    const start = addDays(anchor, 1);
    const end = addDays(anchor, days);

    const db = getDb();
    const rows = await db
      .select({
        id: visit.id,
        scheduledFor: visit.scheduledFor,
        status: visit.status,
        notes: visit.notes,
        headingThereAt: visit.headingThereAt,
        doneAt: visit.doneAt,
        name: customer.name,
        phone: customer.phone,
        street: customer.street,
        city: customer.city,
        postalCode: customer.postalCode,
        binCount: subscription.binCount,
      })
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .leftJoin(subscription, eq(visit.subscriptionId, subscription.id))
      .where(
        and(
          gte(visit.scheduledFor, start),
          lte(visit.scheduledFor, end),
          ne(visit.status, 'cancelled'),
        ),
      )
      .orderBy(asc(visit.scheduledFor), asc(customer.name));

    res.status(200).json({ status: 'ok', days, visits: rows.map(toOperatorVisit) });
  } catch (err) {
    console.error('[operator/upcoming] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
