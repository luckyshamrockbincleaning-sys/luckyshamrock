import type { VercelRequest } from '@vercel/node';
import { SESSION_COOKIE_NAME, verifySessionCookie } from './cookies.js';

/**
 * Reads the ls_session cookie off a Vercel request and verifies it.
 * Returns the customerId or null if no/invalid cookie.
 *
 * Session-gated endpoints should call this first and respond with
 * 401 {status:'unauthorized'} on null.
 */
export async function getSessionCustomerId(req: VercelRequest): Promise<string | null> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  // Manual parse to avoid pulling in a cookie lib for one job.
  // Format: "name=value; name2=value2"
  const match = cookieHeader
    .split(/;\s*/)
    .map((p) => p.split('='))
    .find(([k]) => k === SESSION_COOKIE_NAME);
  if (!match) return null;
  const token = match[1];
  if (!token) return null;

  const payload = await verifySessionCookie(token);
  return payload?.customerId ?? null;
}
