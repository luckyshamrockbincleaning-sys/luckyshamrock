import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/client.js';
import { waitlist } from '../db/schema.js';
import { waitlistRequestSchema } from '../lib/validation.js';
import { normalizePostalCode } from '../lib/postal.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = waitlistRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: 'invalid',
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  const data = parsed.data;

  try {
    const db = getDb();
    await db.insert(waitlist).values({
      id: crypto.randomUUID(),
      email: data.email,
      postalCode: normalizePostalCode(data.postal_code),
    });
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[waitlist] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
