import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import handler from '../magic-link/verify.js';
import { mockReq } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, magicLinkToken } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashToken } from '../../lib/tokens.js';
import * as cookies from '../../lib/cookies.js';
import { verifySessionCookie, SESSION_COOKIE_NAME } from '../../lib/cookies.js';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SITE_URL = 'https://www.luckyshamrock.ca';
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

beforeEach(async () => {
  await truncateAllForTests();
});

async function makeCustomerAndToken(email: string, tokenPlain: string, opts: { expiresMinutesFromNow?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb();
  await db.insert(customer).values({
    id,
    email,
    name: 'Test',
    street: 'X',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  await db.insert(magicLinkToken).values({
    token: hashToken(tokenPlain),
    customerId: id,
    expiresAt: new Date(Date.now() + (opts.expiresMinutesFromNow ?? 15) * 60_000),
  });
  return id;
}

// mockReq from _helpers uses { method, body, query, headers }. We extend response with setHeader + redirect.
function mockResWithHeaders() {
  const headers: Record<string, string | string[]> = {};
  const res: any = {
    statusCode: 200,
    headers,
    body: undefined,
    redirected: null as string | null,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string | string[]) { headers[name] = value; return this; },
    redirect(code: number | string, url?: string) {
      // Vercel supports both res.redirect(url) and res.redirect(status, url)
      if (typeof code === 'string') { this.statusCode = 302; this.redirected = code; }
      else { this.statusCode = code; this.redirected = url ?? null; }
      return this;
    },
  };
  return res;
}

describe('GET /api/magic-link/verify', () => {
  it('redirects to /manage and sets a session cookie for a valid token', async () => {
    const customerId = await makeCustomerAndToken('sam@example.com', 'plain-token-abc');

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'plain-token-abc' } });
    const res = mockResWithHeaders();
    await handler(req, res);

    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.redirected).toBe('/manage');

    const cookieHeader = res.headers['Set-Cookie'];
    expect(cookieHeader).toBeDefined();
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0]! : cookieHeader as string;
    expect(cookieStr).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('Secure');

    const jwt = cookieStr.split(';')[0]!.split('=')[1]!;
    const payload = await verifySessionCookie(jwt);
    expect(payload?.customerId).toBe(customerId);

    const db = getDb();
    const [t] = await db.select().from(magicLinkToken);
    expect(t!.consumedAt).not.toBeNull();
  });

  it('returns 400 when token is missing', async () => {
    const req = mockReq<typeof handler>({ method: 'GET', query: {} });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when token does not exist', async () => {
    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'nonexistent' } });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when token is already consumed', async () => {
    await makeCustomerAndToken('sam@example.com', 'used-token');
    const db = getDb();
    await db.update(magicLinkToken).set({ consumedAt: new Date() }).where(eq(magicLinkToken.token, hashToken('used-token')));

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'used-token' } });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when token has expired', async () => {
    await makeCustomerAndToken('sam@example.com', 'expired-token', { expiresMinutesFromNow: -1 });

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'expired-token' } });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('leaves consumed_at null when cookie signing fails', async () => {
    await makeCustomerAndToken('sam@example.com', 'unlucky-token');
    const spy = vi.spyOn(cookies, 'signSessionCookie').mockRejectedValueOnce(new Error('boom'));

    const req = mockReq<typeof handler>({ method: 'GET', query: { token: 'unlucky-token' } });
    const res = mockResWithHeaders();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const db = getDb();
    const [t] = await db.select().from(magicLinkToken);
    expect(t!.consumedAt).toBeNull();
    spy.mockRestore();
  });

  it('returns 405 for non-GET', async () => {
    const req = mockReq<typeof handler>({ method: 'POST' });
    const res = mockResWithHeaders();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
