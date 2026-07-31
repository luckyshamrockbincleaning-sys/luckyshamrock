import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../book.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { REFERRAL_CODE_LENGTH } from '../../lib/referral.js';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});

beforeEach(async () => {
  await truncateAllForTests();
});

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  return res;
}

const validBooking = {
  name: 'Ref Tester',
  email: 'ref-tester@example.com',
  street: '1 Rd',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 0A1',
  pickup_day: 'wednesday',
  bin_count: 1,
  plan: 'monthly',
};

describe('booking issues a referral code', () => {
  it('gives a new customer a unique code and a zero balance', async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: validBooking } as any, res);
    expect(res.statusCode).toBe(200);

    const [c] = await getDb().select().from(customer).where(eq(customer.email, 'ref-tester@example.com'));
    expect(c!.referralCode).toBeTruthy();
    expect(c!.referralCode).toHaveLength(REFERRAL_CODE_LENGTH);
    expect(c!.referralCode).not.toMatch(/[01OIL]/);
    expect(c!.creditCents).toBe(0);
    expect(c!.referredBy).toBeNull();
  });
});

async function seedReferrer(email = 'richelle@example.com'): Promise<{ code: string; id: string }> {
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, query: {},
    body: { ...validBooking, name: 'Richelle Regehr', email } } as any, res);
  const [c] = await getDb().select().from(customer).where(eq(customer.email, email));
  return { code: c!.referralCode!, id: c!.id };
}

describe('POST /api/book {intent:check_referral}', () => {
  it('accepts a real code and returns the referrer FIRST NAME only', async () => {
    const { code } = await seedReferrer();
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: { intent: 'check_referral', code } } as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.referrer_first_name).toBe('Richelle');
    // Never leak the surname or the email to someone holding only a code.
    expect(JSON.stringify(res.body)).not.toContain('Regehr');
    expect(JSON.stringify(res.body)).not.toContain('richelle@example.com');
  });

  it('is case- and punctuation-insensitive', async () => {
    const { code } = await seedReferrer();
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {},
      body: { intent: 'check_referral', code: ` ${code.toLowerCase()} ` } } as any, res);
    expect(res.body.valid).toBe(true);
  });

  it('returns 200 valid:false for an unknown code — never 404 (enumeration oracle)', async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {}, body: { intent: 'check_referral', code: 'ZZZZZZ' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.referrer_first_name).toBeUndefined();
  });

  it('returns 200 valid:false for a missing or malformed code', async () => {
    for (const code of ['', '!!', 'TOOLONGCODE']) {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, query: {}, body: { intent: 'check_referral', code } } as any, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.valid).toBe(false);
    }
  });
});
