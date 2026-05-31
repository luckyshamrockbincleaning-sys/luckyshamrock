import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, gt, asc } from 'drizzle-orm';
import { getDb } from '../../../../db/client.js';
import { customer, visit } from '../../../../db/schema.js';
import { getOperatorSession } from '../../../../lib/operator.js';
import { sendAndLog } from '../../../../lib/notifications.js';
import { doneTemplate } from '../../../../lib/email/templates.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
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
    const [row] = await db
      .select({
        status: visit.status,
        scheduledFor: visit.scheduledFor,
        customerId: visit.customerId,
        email: customer.email,
        name: customer.name,
      })
      .from(visit)
      .innerJoin(customer, eq(visit.customerId, customer.id))
      .where(eq(visit.id, visitId));

    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (row.status === 'cancelled') {
      res.status(409).json({ status: 'not_actionable', message: 'visit is cancelled' });
      return;
    }

    // Next clean = the customer's next still-scheduled visit after this date.
    const [next] = await db
      .select({ scheduledFor: visit.scheduledFor })
      .from(visit)
      .where(
        and(
          eq(visit.customerId, row.customerId),
          eq(visit.status, 'scheduled'),
          gt(visit.scheduledFor, row.scheduledFor),
        ),
      )
      .orderBy(asc(visit.scheduledFor))
      .limit(1);
    const nextVisitDate = next ? next.scheduledFor.toISOString().slice(0, 10) : null;

    await db.update(visit).set({ status: 'done', doneAt: new Date() }).where(eq(visit.id, visitId));

    // Idempotent on (visitId, 'done').
    const tpl = doneTemplate({ name: row.name, nextVisitDate });
    const result = await sendAndLog({
      kind: 'done',
      to: row.email,
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
      customerId: row.customerId,
      visitId,
    });

    res.status(200).json({ status: 'ok', next_visit_date: nextVisitDate, skipped: result.skipped ?? false });
  } catch (err) {
    console.error('[operator/visit/done] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
