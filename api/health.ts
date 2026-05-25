import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRawClient } from '../db/client.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const time = new Date().toISOString();

  try {
    const sql = getRawClient();
    const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
    const dbOk = rows[0]?.ok === 1;

    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk,
      time,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(503).json({
      status: 'degraded',
      db: false,
      error: message,
      time,
    });
  }
}
