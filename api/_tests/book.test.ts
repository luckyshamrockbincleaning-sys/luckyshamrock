import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../book.js';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { magicLinkToken, notificationLog } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set (run `vercel env pull .env.local`)');
  }
});

beforeEach(async () => {
  await truncateAllForTests();
});

const validBody = {
  name: 'Sam Customer',
  email: 'sam@example.com',
  phone: '780-555-0100',
  street: '123 Main St',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 1A1',
  pickup_day: 'wednesday',
  bin_count: 2,
};

describe('POST /api/book — happy path', () => {
  it('creates a recurring monthly subscription and 12 visits', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'monthly' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; customer_id: string; first_visit_date: string };
    expect(body.status).toBe('ok');
    expect(body.customer_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.first_visit_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam@example.com'));
    expect(c).toBeDefined();
    expect(c!.name).toBe('Sam Customer');
    expect(c!.postalCode).toBe('T8L1A1');

    const subs = await db.select().from(subscription).where(eq(subscription.customerId, c!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cadence).toBe('monthly');
    expect(subs[0]!.binCount).toBe(2);

    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(12);
  });

  it('creates a one-off visit with no subscription', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'oneoff', oneoff_date: '2026-07-15' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);

    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam@example.com'));
    expect(c).toBeDefined();

    const subs = await db.select().from(subscription).where(eq(subscription.customerId, c!.id));
    expect(subs).toHaveLength(0);

    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(1);
    expect(visits[0]!.subscriptionId).toBeNull();
    expect(visits[0]!.scheduledFor.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('returns 405 for non-POST', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('issues a magic_link_token and writes notification_log rows on success', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'monthly' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    const db = getDb();
    const tokens = await db.select().from(magicLinkToken);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).toBeNull();

    const logs = await db.select().from(notificationLog);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(logs.map((l) => l.kind));
    expect(kinds.has('booking_confirmed')).toBe(true);
    expect(kinds.has('magic_link')).toBe(true);
  });
});
