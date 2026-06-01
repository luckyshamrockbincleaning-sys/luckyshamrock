import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleAct as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, notificationLog } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';
import { and, eq } from 'drizzle-orm';

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

async function req(authed: boolean, body: unknown, method = 'POST'): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, query: {}, body };
}

async function seedVisit(status = 'scheduled'): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `act-${customerId.slice(0, 8)}@e.com`,
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
    binCount: 1,
    scheduledFor: new Date('2026-06-10T12:00:00Z'),
    status: status as any,
  });
  return visitId;
}

describe('POST /api/operator/act (body-routed visit actions)', () => {
  it('401 without an operator cookie (before body validation)', async () => {
    const res = mockRes();
    await handler(await req(false, { id: crypto.randomUUID(), op: 'notify' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('400 on a bad body (missing op)', async () => {
    const res = mockRes();
    await handler(await req(true, { id: crypto.randomUUID() }), res);
    expect(res.statusCode).toBe(400);
  });

  it('400 on an invalid op', async () => {
    const res = mockRes();
    await handler(await req(true, { id: crypto.randomUUID(), op: 'teleport' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('routes op=notify → sets heading_there + logs an on_our_way send', async () => {
    const visitId = await seedVisit();
    const res = mockRes();
    await handler(await req(true, { id: visitId, op: 'notify' }), res);
    expect(res.statusCode).toBe(200);

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('heading_there');
    const logs = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.visitId, visitId), eq(notificationLog.kind, 'on_our_way')));
    expect(logs).toHaveLength(1);
  });

  it('routes op=done → marks done', async () => {
    const visitId = await seedVisit();
    const res = mockRes();
    await handler(await req(true, { id: visitId, op: 'done' }), res);
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('done');
  });

  it('routes op=skip → marks skipped', async () => {
    const visitId = await seedVisit();
    const res = mockRes();
    await handler(await req(true, { id: visitId, op: 'skip' }), res);
    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.status).toBe('skipped');
  });

  it('routes op=note → appends the note text from the body', async () => {
    const visitId = await seedVisit();
    const res = mockRes();
    await handler(await req(true, { id: visitId, op: 'note', text: 'bin blocked' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.notes).toBe('bin blocked');
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.notes).toBe('bin blocked');
  });
});
