import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE_NAME = 'ls_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface SessionPayload {
  customerId: string;
}

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) {
    throw new Error('SESSION_SECRET is not set');
  }
  return new TextEncoder().encode(raw);
}

export async function signSessionCookie(customerId: string): Promise<string> {
  const secret = getSecret();
  return await new SignJWT({ customerId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifySessionCookie(token: string): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload.customerId !== 'string') return null;
    return { customerId: payload.customerId };
  } catch {
    return null;
  }
}

/**
 * Format the cookie for a Set-Cookie header. HTTP-only, Secure, SameSite=Lax.
 */
export function formatSessionCookieHeader(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=/`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

/**
 * Cookie header value that immediately expires the session cookie. For logout.
 */
export function formatClearSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}
