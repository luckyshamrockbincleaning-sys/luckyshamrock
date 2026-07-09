/**
 * Visit-scoped rating tokens for the tap-a-star links in the done email.
 *
 * A rating link must work with zero login friction (one tap from the inbox),
 * but must not let anyone rate arbitrary visits. The token is an HMAC of the
 * visit id under SESSION_SECRET — unguessable without the secret, verifiable
 * without a DB lookup, and deliberately non-expiring (rating a clean two
 * weeks later is fine; the action is harmless and visit-scoped).
 */
import crypto from 'node:crypto';

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

export function signRatingToken(visitId: string): string {
  return crypto.createHmac('sha256', secret()).update(`rate:${visitId}`).digest('base64url');
}

export function verifyRatingToken(visitId: string, token: string): boolean {
  if (!visitId || !token) return false;
  const expected = signRatingToken(visitId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
