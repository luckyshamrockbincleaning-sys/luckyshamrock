import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleSettle, handleAct } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit, payment } from '../../db/schema.js';
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
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  return res;
}

async function req(id: string | undefined, body: Record<string, unknown>, authed = true): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method: 'POST', headers, query: id !== undefined ? { id } : {}, body };
}

/** A walk-up cleaned but never settled — exactly Chris Wims's situation. */
async function seedUnpaidDone(opts: { binCount?: number; paymentStatus?: string } = {}): Promise<string> {
  const db = getDb();
  const customerId = crypto.randomUUID();
  await db.insert(customer).values({
    id: customerId,
    email: `walkup+${customerId.slice(0, 8)}@luckyshamrock.ca`,
    name: 'Chris Walkup',
    street: '191 Radcliffe Wynd',
    city: 'Fort Saskatchewan',
    pickupDay: 'wednesday',
  });
  const visitId = crypto.randomUUID();
  await db.insert(visit).values({
    id: visitId,
    customerId,
    subscriptionId: null,
    binCount: opts.binCount ?? 2,
    scheduledFor: new Date('2026-08-18'),
    status: 'done',
    doneAt: new Date(),
    paymentStatus: (opts.paymentStatus ?? 'unpaid') as any,
  });
  return visitId;
}

describe('POST /api/operator/act {op:settle} — record money for an already-done visit', () => {
  it('requires operator auth', async () => {
    const res = mockRes();
    await handleSettle(await req('x', { method: 'cash' }, false), res);
    expect(res.statusCode).toBe(401);
  });

  it('records an e-transfer against a done-but-unpaid visit', async () => {
    // The case that sent AB to the database by hand: a walk-up cleaned with
    // the payment method left on the default, so nothing was recorded.
    const visitId = await seedUnpaidDone();
    const res = mockRes();
    await handleSettle(await req(visitId, { method: 'etransfer' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.amount_cents).toBe(5700); // 2-bin one-off: $45 + $12

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('paid_etransfer');
    const rows = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe('etransfer');
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[0]!.amountCents).toBe(5700);
  });

  it('records cash and terminal too', async () => {
    for (const method of ['cash', 'terminal'] as const) {
      await truncateAllForTests();
      const visitId = await seedUnpaidDone({ binCount: 1 });
      const res = mockRes();
      await handleSettle(await req(visitId, { method }), res);
      expect(res.statusCode).toBe(200);
      const [v] = await getDb().select().from(visit).where(eq(visit.id, visitId));
      expect(v!.paymentStatus).toBe(method === 'cash' ? 'paid_cash' : 'paid_terminal');
    }
  });

  it('honours an amount override for a doorstep deal', async () => {
    const visitId = await seedUnpaidDone();
    const res = mockRes();
    await handleSettle(await req(visitId, { method: 'cash', amount_cents: 4000 }), res);
    expect(res.statusCode).toBe(200);
    const rows = await getDb().select().from(payment).where(eq(payment.visitId, visitId));
    expect(rows[0]!.amountCents).toBe(4000);
  });

  it('refuses to settle a visit that is already paid — no double-recording', async () => {
    const visitId = await seedUnpaidDone({ paymentStatus: 'paid_cash' });
    const res = mockRes();
    await handleSettle(await req(visitId, { method: 'etransfer' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('already_settled');
    expect(await getDb().select().from(payment).where(eq(payment.visitId, visitId))).toHaveLength(0);
  });

  it('is safe to double-tap — the second call is refused, not duplicated', async () => {
    const visitId = await seedUnpaidDone();
    const first = mockRes();
    await handleSettle(await req(visitId, { method: 'cash' }), first);
    const second = mockRes();
    await handleSettle(await req(visitId, { method: 'cash' }), second);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(await getDb().select().from(payment).where(eq(payment.visitId, visitId))).toHaveLength(1);
  });

  it('refuses a visit that is not done yet — settle records money already taken', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId, email: 'notdone@e.com', name: 'Nope', street: '1 Rd',
      city: 'Fort Saskatchewan', pickupDay: 'wednesday',
    });
    const visitId = crypto.randomUUID();
    await db.insert(visit).values({
      id: visitId, customerId, subscriptionId: null, binCount: 1,
      scheduledFor: new Date('2026-08-18'), status: 'scheduled',
    });
    const res = mockRes();
    await handleSettle(await req(visitId, { method: 'cash' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('not_done');
  });

  it('404s for an unknown visit', async () => {
    const res = mockRes();
    await handleSettle(await req(crypto.randomUUID(), { method: 'cash' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a method that settles nothing at the door', async () => {
    // card_on_file and qr are live payment flows, not "money already taken".
    const visitId = await seedUnpaidDone();
    for (const method of ['card_on_file', 'qr', 'bitcoin']) {
      const res = mockRes();
      await handleSettle(await req(visitId, { method }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(await getDb().select().from(payment).where(eq(payment.visitId, visitId))).toHaveLength(0);
  });

  it('settles a failed card charge as cash without leaving the failed row as the truth', async () => {
    const db = getDb();
    const visitId = await seedUnpaidDone({ paymentStatus: 'failed' });
    const [v0] = await db.select().from(visit).where(eq(visit.id, visitId));
    await db.insert(payment).values({
      id: crypto.randomUUID(), customerId: v0!.customerId, visitId,
      amountCents: 5700, discountCents: 0, status: 'failed',
      failureReason: 'Your card was declined.',
    });

    const res = mockRes();
    await handleSettle(await req(visitId, { method: 'cash' }), res);
    expect(res.statusCode).toBe(200);

    const [v] = await db.select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('paid_cash');
    // The failed attempt stays as history; the new succeeded row is the truth.
    const rows = await db.select().from(payment).where(eq(payment.visitId, visitId));
    expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(1);
  });

  it('routes through the act dispatcher', async () => {
    const visitId = await seedUnpaidDone({ binCount: 1 });
    const res = mockRes();
    await handleAct(await req(visitId, { id: visitId, op: 'settle', method: 'cash' }), res);
    expect(res.statusCode).toBe(200);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, visitId));
    expect(v!.paymentStatus).toBe('paid_cash');
  });
});
