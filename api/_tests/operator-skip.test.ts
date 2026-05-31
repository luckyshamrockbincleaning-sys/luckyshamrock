import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../operator/visit/[id]/skip.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';
import { eq } from 'drizzle-orm';

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
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

async function req(authed: boolean, id: string | undefined, method = 'POST'): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, query: id !== undefined ? { id } : {} };
}

async function seed(status = 'scheduled'): Promise<{ customerId: string; visitId: string }> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `op-${customerId.slice(0, 8)}@e.com`,
    name: 'Pat',
    street: '1 Rd',
    city: 'Fort Saskatchewan',
    postalCode: 'T8L1A1',
    pickupDay: 'wednesday',
  });
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: null,
    scheduledFor: new Date('2026-06-10T12:00:00Z'),
    status: status as any,
  });
  return { customerId, visitId };
}

describe('POST /api/operator/visit/:id/skip', () => {
  it('returns 401 without an operator cookie', async () => {
    const { visitId } = await seed();
    const res = mockRes();
    await handler(await req(false, visitId), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the visit does not exist', async () => {
    const res = mockRes();
    await handler(await req(true, crypto.randomUUID()), res);
    expect(res.statusCode).toBe(404);
  });

  it('marks the visit skipped and does NOT insert a replacement (unlike customer skip)', async () => {
    const { customerId, visitId } = await seed();
    const res = mockRes();
    await handler(await req(true, visitId), res);
    expect(res.statusCode).toBe(200);

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('skipped');

    const all = await db.select().from(visit).where(eq(visit.customerId, customerId));
    expect(all).toHaveLength(1); // no replacement inserted
  });

  it('returns 409 when the visit is already done', async () => {
    const { visitId } = await seed('done');
    const res = mockRes();
    await handler(await req(true, visitId), res);
    expect(res.statusCode).toBe(409);
  });
});
