import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../book.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});
beforeEach(async () => {
  await truncateAllForTests();
});

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return res;
}

const base = {
  name: 'Bin Picker',
  email: 'bins@example.com',
  street: '5 Clover Lane',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 1A1',
  pickup_day: 'wednesday' as const,
};

const req = (body: Record<string, unknown>) => ({ method: 'POST', headers: {}, query: {}, body }) as any;

describe('POST /api/book — which bins', () => {
  it('stores the chosen bins on a monthly subscription', async () => {
    const res = mockRes();
    await handler(req({ ...base, plan: 'monthly', bin_count: 2, bin_types: ['garbage', 'organics'] }), res);

    expect(res.statusCode).toBe(200);
    const [c] = await getDb().select().from(customer).where(eq(customer.email, base.email));
    const [sub] = await getDb().select().from(subscription).where(eq(subscription.customerId, c!.id));
    expect(sub!.binCount).toBe(2);
    expect(sub!.binTypes).toEqual(['garbage', 'organics']);
  });

  it('stores them on the visit for a one-off, which has no subscription', async () => {
    const res = mockRes();
    await handler(
      req({ ...base, plan: 'oneoff', oneoff_date: '2026-09-16', bin_count: 1, bin_types: ['organics'] }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const [v] = await getDb().select().from(visit);
    expect(v!.binCount).toBe(1);
    expect(v!.binTypes).toEqual(['organics']);
  });

  it('answers the question that started this: one bin, and we know which', async () => {
    const res = mockRes();
    await handler(req({ ...base, plan: 'monthly', bin_count: 1, bin_types: ['organics'] }), res);
    expect(res.statusCode).toBe(200);
    const [sub] = await getDb().select().from(subscription);
    expect(sub!.binTypes).toEqual(['organics']);
  });

  it('canonicalises the order so bin 1 is always the same bin', async () => {
    // Photos and the per-bin email sections are keyed by position.
    const res = mockRes();
    await handler(
      req({ ...base, plan: 'monthly', bin_count: 2, bin_types: ['organics', 'garbage'] }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const [sub] = await getDb().select().from(subscription);
    expect(sub!.binTypes).toEqual(['garbage', 'organics']);
  });

  it('still accepts a booking with no bin_types at all (older clients)', async () => {
    const res = mockRes();
    await handler(req({ ...base, plan: 'monthly', bin_count: 2 }), res);
    expect(res.statusCode).toBe(200);
    const [sub] = await getDb().select().from(subscription);
    expect(sub!.binCount).toBe(2);
    expect(sub!.binTypes).toBeNull();
  });

  it('refuses two bins priced as one', async () => {
    // bin_count is what gets charged, so a mismatch is a way to get a bin
    // cleaned for free. Reject rather than silently trusting either number.
    const res = mockRes();
    await handler(
      req({ ...base, plan: 'monthly', bin_count: 1, bin_types: ['garbage', 'organics'] }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe('invalid');
    expect(res.body.errors.bin_types?.[0]).toMatch(/exactly bin_count/i);
    expect(await getDb().select().from(subscription)).toHaveLength(0);
  });

  it('refuses the same bin listed twice to inflate the count', async () => {
    const res = mockRes();
    await handler(
      req({ ...base, plan: 'monthly', bin_count: 2, bin_types: ['garbage', 'garbage'] }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(await getDb().select().from(subscription)).toHaveLength(0);
  });

  it('refuses a bin type we do not service', async () => {
    const res = mockRes();
    await handler(
      req({ ...base, plan: 'monthly', bin_count: 1, bin_types: ['recycling'] }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(await getDb().select().from(subscription)).toHaveLength(0);
  });
});
