import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { magicLinkToken } from '../../db/schema.js';
import { hashToken } from '../../lib/tokens.js';
import { signSessionCookie, formatSessionCookieHeader } from '../../lib/cookies.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const tokenParam = typeof req.query.token === 'string' ? req.query.token : null;
  if (!tokenParam) {
    res.status(400).json({ status: 'invalid', message: 'missing token' });
    return;
  }

  try {
    const db = getDb();
    const tokenHash = hashToken(tokenParam);
    const [row] = await db.select().from(magicLinkToken).where(eq(magicLinkToken.token, tokenHash));

    if (!row) {
      res.status(400).json({ status: 'invalid', message: 'token not found' });
      return;
    }
    if (row.consumedAt !== null) {
      res.status(400).json({ status: 'invalid', message: 'token already used' });
      return;
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      res.status(400).json({ status: 'invalid', message: 'token expired' });
      return;
    }

    // Mark consumed
    await db.update(magicLinkToken).set({ consumedAt: new Date() }).where(eq(magicLinkToken.token, tokenHash));

    // Issue session cookie and redirect
    const sessionToken = await signSessionCookie(row.customerId);
    res.setHeader('Set-Cookie', formatSessionCookieHeader(sessionToken));
    res.redirect('/manage');
  } catch (err) {
    console.error('[magic-link/verify] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
