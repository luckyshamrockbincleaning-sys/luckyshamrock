import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
    // NOT 12. Visit generation is capped to the May 1 - Oct 31 season, so a
    // monthly plan yields only the cleans that actually fit before the season
    // closes. Next season is generated when it opens.
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.length).toBeLessThanOrEqual(12);
    for (const v of visits) {
      const m = v.scheduledFor.getUTCMonth() + 1;
      expect(m).toBeGreaterThanOrEqual(5);
      expect(m).toBeLessThanOrEqual(10);
    }
    // Recurring visits derive bin_count from the subscription, so the per-visit
    // column stays null (single source of truth per visit type).
    expect(visits.every((v) => v.binCount === null)).toBe(true);
  });

  it('persists the bin location on the customer so the operator knows where to find the bin', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'monthly', bin_location: 'garage' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam@example.com'));
    expect(c!.binLocation).toBe('garage');
  });

  it('creates a seasonal (Three Wash Season) subscription with 3 visits in May/Jul/Sep', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'seasonal' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam@example.com'));
    const subs = await db.select().from(subscription).where(eq(subscription.customerId, c!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cadence).toBe('seasonal');

    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(3);
    // Each visit lands in a season window: May, July, or September.
    const months = visits.map((v) => v.scheduledFor.getUTCMonth() + 1).sort((a, b) => a - b);
    months.forEach((m) => expect([5, 7, 9]).toContain(m));
  });

  it('creates a one-off visit with no subscription', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'oneoff', oneoff_date: '2099-07-15' },
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
    expect(visits[0]!.scheduledFor.toISOString().slice(0, 10)).toBe('2099-07-15');
    // One-off visits have no subscription, so bin_count is stored on the visit.
    expect(visits[0]!.binCount).toBe(2);
  });

  it('returns 405 for non-POST', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('issues a magic_link_token and sends exactly one booking_confirmed email', async () => {
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

    // Exactly ONE email at booking: booking_confirmed (which carries the manage
    // link). We do NOT also send a magic_link email — that would duplicate the
    // same token and create unnecessary inbox noise.
    const logs = await db.select().from(notificationLog);
    const kinds = logs.map((l) => l.kind);
    expect(kinds).toContain('booking_confirmed');
    expect(kinds).not.toContain('magic_link');
    expect(kinds.filter((k) => k === 'booking_confirmed')).toHaveLength(1);
  });

  it('notifies the operator of the new booking when a notify address is set', async () => {
    process.env.OPERATOR_NOTIFY_EMAIL = 'ops@example.com';
    try {
      const req = mockReq<typeof handler>({
        method: 'POST',
        body: { ...validBody, plan: 'monthly' },
      });
      const res = mockRes<typeof handler>();
      await handler(req, res);
      expect(res.statusCode).toBe(200);

      const db = getDb();
      const logs = await db.select().from(notificationLog);
      const kinds = logs.map((l) => l.kind);
      expect(kinds).toContain('operator_new_booking');
      expect(kinds.filter((k) => k === 'operator_new_booking')).toHaveLength(1);
    } finally {
      delete process.env.OPERATOR_NOTIFY_EMAIL;
    }
  });

  it('sends no operator notification when no notify address is configured', async () => {
    delete process.env.OPERATOR_NOTIFY_EMAIL;
    delete process.env.GMAIL_SEND_AS;
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'oneoff', bin_count: 1, oneoff_date: '2099-07-15' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    const db = getDb();
    const logs = await db.select().from(notificationLog);
    expect(logs.map((l) => l.kind)).not.toContain('operator_new_booking');
  });
});

describe('POST /api/book — atomicity', () => {
  // This test deliberately drives the handler into its 500 path, which logs via
  // console.error. Suppress it so the expected error doesn't look like a failure.
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('rejects invalid one-off dates before writing any rows', async () => {
    const email = 'atomic-rollback@example.com';
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, email, plan: 'oneoff', oneoff_date: '2026-13-45' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      status: 'invalid',
      errors: expect.objectContaining({
        oneoff_date: expect.any(Array),
      }),
    });

    const db = getDb();
    const rows = await db.select().from(customer).where(eq(customer.email, email));
    expect(rows).toHaveLength(0);
  });
});
