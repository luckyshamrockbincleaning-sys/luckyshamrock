import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.OPERATOR_SECRET = 'o'.repeat(48);
process.env.OPERATOR_PASSWORD = 'lucky-route-2026';

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async () => ({ url: 'https://x/y.jpg' })),
  del: vi.fn(),
  list: vi.fn(async () => ({ blobs: [] })),
}));

const { handleAct } = await import('../../lib/operator-handlers.js');
const { truncateAllForTests } = await import('./_db_cleanup.js');
const { getDb } = await import('../../db/client.js');
const { customer, visit, payment, notificationLog } = await import('../../db/schema.js');
const { signOperatorCookie, OPERATOR_COOKIE_NAME } = await import('../../lib/operator.js');
const { eq } = await import('drizzle-orm');

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
});
beforeEach(async () => { await truncateAllForTests(); });

function mockRes(): any {
  return {
    statusCode: 0, body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    setHeader() { return this; },
  };
}

async function act(id: string, op = 'resend_receipt'): Promise<any> {
  const res = mockRes();
  await handleAct({
    method: 'POST',
    headers: { cookie: `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}` },
    query: {},
    body: { id, op },
  } as any, res);
  return res;
}

interface SeedOpts { email?: string; status?: string; paid?: boolean }
async function seed(o: SeedOpts = {}): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: o.email ?? `g-${customerId.slice(0, 8)}@e.com`,
    name: 'Gordon',
    street: '31-15 Woodsmere Close',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'monday',
  });
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId, customerId, subscriptionId: null,
    scheduledFor: new Date('2026-09-07T12:00:00Z'),
    status: (o.status ?? 'done') as any,
    doneAt: new Date('2026-09-08T01:52:00Z'),
    binCount: 2,
    binTypes: ['garbage', 'organics'],
    paymentStatus: (o.paid === false ? 'unpaid' : 'paid_etransfer') as any,
  });
  if (o.paid !== false) {
    await db.insert(payment).values({
      id: crypto.randomUUID(), visitId, customerId,
      amountCents: 5700, method: 'etransfer' as any, status: 'succeeded' as any,
    });
  }
  return visitId;
}

describe('resending a receipt', () => {
  it('sends one and records it', async () => {
    const visitId = await seed();
    const res = await act(visitId);
    expect(res.statusCode).toBe(200);
    const logs = await getDb().select().from(notificationLog).where(eq(notificationLog.visitId, visitId));
    expect(logs.map((l) => l.kind)).toContain('receipt');
  });

  it('will not send twice', async () => {
    const visitId = await seed();
    expect((await act(visitId)).statusCode).toBe(200);
    const second = await act(visitId);
    expect(second.body.skipped).toBe(true);
  });

  it('refuses a job that was never paid — there is nothing to receipt', async () => {
    const visitId = await seed({ paid: false });
    const res = await act(visitId);
    expect(res.statusCode).toBe(409);
  });

  it('refuses a job that is not done', async () => {
    const visitId = await seed({ status: 'scheduled' });
    const res = await act(visitId);
    expect(res.statusCode).toBe(409);
  });

  it('refuses when there is no real email to send to', async () => {
    const visitId = await seed({ email: 'walkup+deadbeef@luckyshamrock.ca' });
    const res = await act(visitId);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('no_email');
  });

  it('404s an unknown visit', async () => {
    const res = await act(crypto.randomUUID());
    expect(res.statusCode).toBe(404);
  });
});
