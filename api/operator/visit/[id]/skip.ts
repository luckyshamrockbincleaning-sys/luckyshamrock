import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db/client.js';
import { visit } from '../../../../db/schema.js';
import { getOperatorSession } from '../../../../lib/operator.js';

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
    const [row] = await db.select({ status: visit.status }).from(visit).where(eq(visit.id, visitId));
    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }
    if (row.status === 'done' || row.status === 'cancelled') {
      res.status(409).json({ status: 'not_actionable', message: `visit is ${row.status}` });
      return;
    }

    // Operator skip ("bin wasn't out") just marks the visit skipped. Unlike a
    // customer skip, it does NOT insert a replacement — the recurring schedule
    // continues with the next already-scheduled visit.
    await db.update(visit).set({ status: 'skipped' }).where(eq(visit.id, visitId));

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[operator/visit/skip] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
