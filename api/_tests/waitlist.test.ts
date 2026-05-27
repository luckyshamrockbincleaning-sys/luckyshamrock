import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../waitlist.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { waitlist } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
});

beforeEach(async () => {
  await truncateAllForTests();
});

describe('POST /api/waitlist', () => {
  it('creates a waitlist row for a valid email + postal code', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { email: 'sam@example.com', postal_code: 'T5J 1A1' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe('ok');

    const db = getDb();
    const rows = await db.select().from(waitlist).where(eq(waitlist.email, 'sam@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.postalCode).toBe('T5J1A1');
  });

  it('allows the same email to sign up multiple times without erroring', async () => {
    const body = { email: 'sam@example.com', postal_code: 'T5J 1A1' };
    const req1 = mockReq<typeof handler>({ method: 'POST', body });
    const res1 = mockRes<typeof handler>();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(200);

    const req2 = mockReq<typeof handler>({ method: 'POST', body });
    const res2 = mockRes<typeof handler>();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);

    const db = getDb();
    const rows = await db.select().from(waitlist).where(eq(waitlist.email, 'sam@example.com'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
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
