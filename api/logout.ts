import type { VercelRequest, VercelResponse } from '@vercel/node';
import { formatClearSessionCookieHeader } from '../lib/cookies.js';

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  res.setHeader('Set-Cookie', formatClearSessionCookieHeader());
  res.status(200).json({ status: 'ok' });
}
