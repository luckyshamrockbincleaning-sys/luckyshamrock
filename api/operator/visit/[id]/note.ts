import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../../db/client.js';
import { visit } from '../../../../db/schema.js';
import { getOperatorSession } from '../../../../lib/operator.js';

const noteSchema = z.object({ text: z.string().trim().min(1).max(1000) });

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

  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const db = getDb();
    const [row] = await db.select({ notes: visit.notes }).from(visit).where(eq(visit.id, visitId));
    if (!row) {
      res.status(404).json({ status: 'not_found' });
      return;
    }

    // Append on a new line so the operator builds up a per-stop log.
    const newNotes = row.notes ? `${row.notes}\n${parsed.data.text}` : parsed.data.text;
    await db.update(visit).set({ notes: newNotes }).where(eq(visit.id, visitId));

    res.status(200).json({ status: 'ok', notes: newNotes });
  } catch (err) {
    console.error('[operator/visit/note] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
