import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../magic-link/send.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, magicLinkToken } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.SITE_URL = 'https://www.luckyshamrock.ca';
});

beforeEach(async () => {
  await truncateAllForTests();
});

async function makeCustomer(email: string): Promise<string> {
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
  return id;
}

describe('POST /api/magic-link/send', () => {
  it('issues a token row and returns 200 + ok shape for an existing customer', async () => {
    const customerId = await makeCustomer('sam@example.com');

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'sam@example.com' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).status).toBe('ok');

    const db = getDb();
    const tokens = await db.select().from(magicLinkToken).where(eq(magicLinkToken.customerId, customerId));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).toBeNull();
    expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('does NOT leak whether the email exists (always returns 200/ok)', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).status).toBe('ok');

    const db = getDb();
    const tokens = await db.select().from(magicLinkToken);
    expect(tokens).toHaveLength(0);
  });

  it('returns 400 for invalid body', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'not-an-email' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-POST', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
