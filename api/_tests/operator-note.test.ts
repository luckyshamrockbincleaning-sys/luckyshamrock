import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import handler from '../operator/visit/[id]/note.js';
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

async function req(authed: boolean, id: string | undefined, body?: unknown, method = 'POST'): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, query: id !== undefined ? { id } : {}, body };
}

async function seed(): Promise<string> {
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
    status: 'scheduled',
  });
  return visitId;
}

describe('POST /api/operator/visit/:id/note', () => {
  it('returns 401 without an operator cookie', async () => {
    const visitId = await seed();
    const res = mockRes();
    await handler(await req(false, visitId, { text: 'x' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the visit does not exist', async () => {
    const res = mockRes();
    await handler(await req(true, crypto.randomUUID(), { text: 'x' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for empty note text', async () => {
    const visitId = await seed();
    const res = mockRes();
    await handler(await req(true, visitId, { text: '' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('sets the note, then appends subsequent notes on new lines', async () => {
    const visitId = await seed();
    const res1 = mockRes();
    await handler(await req(true, visitId, { text: 'bin blocked by car' }), res1);
    expect(res1.statusCode).toBe(200);
    expect(res1.body.notes).toBe('bin blocked by car');

    const res2 = mockRes();
    await handler(await req(true, visitId, { text: 'left a flyer' }), res2);
    expect(res2.body.notes).toBe('bin blocked by car\nleft a flyer');

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.notes).toBe('bin blocked by car\nleft a flyer');
  });
});
