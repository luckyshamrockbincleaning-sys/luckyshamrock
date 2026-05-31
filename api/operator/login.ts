import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import {
  signOperatorCookie,
  formatOperatorCookieHeader,
  verifyOperatorPassword,
} from '../../lib/operator.js';

const loginSchema = z.object({ password: z.string().min(1) });

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  if (!verifyOperatorPassword(parsed.data.password)) {
    res.status(401).json({ status: 'invalid_password', message: 'Incorrect password.' });
    return;
  }

  try {
    const token = await signOperatorCookie();
    res.setHeader('Set-Cookie', formatOperatorCookieHeader(token));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[operator/login] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
