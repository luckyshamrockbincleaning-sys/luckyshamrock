import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

process.env.OPERATOR_SECRET = 'o'.repeat(48);
process.env.OPERATOR_PASSWORD = 'lucky-route-2026';

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async () => ({ url: 'https://x/y.jpg' })),
  del: vi.fn(),
  list: vi.fn(async () => ({ blobs: [] })),
}));

const { handleDone } = await import('../../lib/operator-handlers.js');
const { truncateAllForTests } = await import('./_db_cleanup.js');
const { getDb } = await import('../../db/client.js');
const { customer, visit } = await import('../../db/schema.js');
const { signOperatorCookie, OPERATOR_COOKIE_NAME } = await import('../../lib/operator.js');
const receipts = await import('../../lib/receipt-pdf.js');

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});
beforeEach(async () => { await truncateAllForTests(); });
afterEach(() => { vi.useRealTimers(); });

function mockRes(): any {
  return {
    statusCode: 0, body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    setHeader() { return this; },
  };
}

async function seed(): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `r-${customerId.slice(0, 8)}@e.com`,
    name: 'Gordon',
    street: '31-15 Woodsmere Close',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'monday',
  });
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId, customerId, subscriptionId: null,
    scheduledFor: new Date('2026-09-07T12:00:00Z'), status: 'scheduled',
  });
  return visitId;
}

describe('receipt "Paid" date', () => {
  it('uses the local day for an evening job, not the UTC day', async () => {
    // 19:52 Monday in Fort Saskatchewan is already Tuesday in UTC. The receipt
    // must say the day the customer actually paid.
    // Fake ONLY Date — faking timers as well stalls the database driver.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-08T01:52:00Z'));

    const spy = vi.spyOn(receipts, 'generateReceiptPdf');
    const visitId = await seed();
    const res = mockRes();
    await handleDone({
      method: 'POST',
      headers: { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` },
      query: { id: visitId },
      body: { payment_method: 'cash' },
    } as any, res);

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0].paidDate).toBe('Mon, Sep 7, 2026');
    spy.mockRestore();
  });
});
