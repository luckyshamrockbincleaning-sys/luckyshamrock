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

    // A human clicking a dead email link should land on the manage sign-in
    // card with a friendly banner + the "email me a fresh link" form — not on
    // a raw JSON error. (?link=expired is read by /manage's LoginCard.)
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      res.redirect(307, '/manage?link=expired');
      return;
    }
    // NOTE: tokens are reusable within their TTL — we do NOT reject an already-
    // consumed token. Single-use links die when an inbox link-scanner prefetches
    // and consumes the URL before the customer clicks (a well-known magic-link
    // footgun), and they frustrate a customer who clicks twice. Security still
    // rests on the short expiry + the unguessable 32-byte token.

    // Sign the cookie BEFORE touching the token — if signing throws (missing
    // secret, jose hiccup) we don't want to record a consumption with no session.
    const sessionToken = await signSessionCookie(row.customerId);
    // Record first use only; preserve the original timestamp for audit.
    if (row.consumedAt === null) {
      await db.update(magicLinkToken).set({ consumedAt: new Date() }).where(eq(magicLinkToken.token, tokenHash));
    }
    res.setHeader('Set-Cookie', formatSessionCookieHeader(sessionToken));
    res.redirect('/manage');
  } catch (err) {
    console.error('[magic-link/verify] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
