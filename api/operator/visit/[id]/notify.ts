import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db/client.js';
import { customer, visit } from '../../../../db/schema.js';
import { getOperatorSession } from '../../../../lib/operator.js';
import { sendAndLog } from '../../../../lib/notifications.js';
import { onOurWayTemplate } from '../../../../lib/email/templates.js';

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
        headingThereAt: visit.headingThereAt,
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
    if (row.status === 'done' || row.status === 'cancelled') {
      res.status(409).json({ status: 'not_actionable', message: `visit is ${row.status}` });
      return;
    }

    // The operator IS heading there regardless of whether the email sends, so
    // mark it first. Keep the original heading_there_at on a re-tap.
    await db
      .update(visit)
      .set({ status: 'heading_there', headingThereAt: row.headingThereAt ?? new Date() })
      .where(eq(visit.id, visitId));

    // Idempotent on (visitId, 'on_our_way') — a double-tap sends no second email.
    const tpl = onOurWayTemplate({ name: row.name });
    const result = await sendAndLog({
      kind: 'on_our_way',
      to: row.email,
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
      customerId: row.customerId,
      visitId,
    });

    res.status(200).json({ status: 'ok', skipped: result.skipped ?? false });
  } catch (err) {
    console.error('[operator/visit/notify] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
