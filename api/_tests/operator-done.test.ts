import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { handleDone as handler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, notificationLog, payment } from '../../db/schema.js';
import { signOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';
import { and, eq } from 'drizzle-orm';
import * as templates from '../../lib/email/templates.js';
import * as billing from '../../lib/billing.js';

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

async function req(authed: boolean, id: string | undefined, method = 'POST', body: Record<string, unknown> = {}): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method, headers, query: id !== undefined ? { id } : {}, body };
}

async function seedCustomer(): Promise<string> {
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
  return customerId;
}

async function addVisit(customerId: string, date: string, status = 'scheduled'): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.insert(visit).values({
    id,
    customerId,
    subscriptionId: null,
    scheduledFor: new Date(`${date}T12:00:00Z`),
    status: status as any,
  });
  return id;
}

describe('POST /api/operator/visit/:id/done', () => {
  it('returns 401 without an operator cookie', async () => {
    const c = await seedCustomer();
    const v = await addVisit(c, '2026-06-10');
    const res = mockRes();
    await handler(await req(false, v), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the visit does not exist', async () => {
    const res = mockRes();
    await handler(await req(true, crypto.randomUUID()), res);
    expect(res.statusCode).toBe(404);
  });

  it('marks done, stamps done_at, returns the next visit date, and logs a done send', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');
    await addVisit(c, '2026-07-08'); // next scheduled clean

    const res = mockRes();
    await handler(await req(true, v1), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.next_visit_date).toBe('2026-07-08');

    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
    expect(v!.doneAt).not.toBeNull();

    const logs = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.visitId, v1), eq(notificationLog.kind, 'done')));
    expect(logs).toHaveLength(1);
  });

  it('accepts a clean-bin photo when marking done', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', {
      clean_photo: {
        filename: 'clean-bin.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('fake-image').toString('base64'),
      },
    }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
  });

  it('returns 400 for an unsupported clean photo mime type before marking done', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', {
      clean_photo: {
        filename: 'clean-bin.gif',
        mime_type: 'image/gif',
        content_base64: Buffer.from('fake-image').toString('base64'),
      },
    }), res);

    expect(res.statusCode).toBe(400);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('scheduled');
  });

  it('returns 400 for an oversized clean photo before marking done', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', {
      clean_photo: {
        filename: 'clean-bin.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      },
    }), res);

    expect(res.statusCode).toBe(400);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('scheduled');
  });

  it('accepts an optional before photo alongside the clean photo', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', {
      clean_photo: {
        filename: 'clean-bin.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('after-image').toString('base64'),
      },
      before_photo: {
        filename: 'before-bin.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('before-image').toString('base64'),
      },
    }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
  });

  it('returns 400 for an invalid before photo before marking done', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', {
      clean_photo: {
        filename: 'clean-bin.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('after-image').toString('base64'),
      },
      before_photo: {
        filename: 'before-bin.gif',
        mime_type: 'image/gif',
        content_base64: Buffer.from('before-image').toString('base64'),
      },
    }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).message).toContain('before_photo');
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('scheduled');
  });

  it('still completes when a before photo arrives without a clean photo', async () => {
    // API compatibility: clean_photo is optional at the API layer (the /ops UI
    // enforces it), so a stray before_photo alone must not break Done.
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', {
      before_photo: {
        filename: 'before-bin.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('before-image').toString('base64'),
      },
    }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
  });

  it('returns next_visit_date null when there is no later scheduled visit', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10');
    const res = mockRes();
    await handler(await req(true, v1), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.next_visit_date).toBeNull();
  });

  it('returns 409 when the visit is cancelled', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10', 'cancelled');
    const res = mockRes();
    await handler(await req(true, v1), res);
    expect(res.statusCode).toBe(409);
  });

  it('returns 409 when the visit is skipped', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-06-10', 'skipped');
    const res = mockRes();
    await handler(await req(true, v1), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('not_actionable');
  });

  it('records a cash payment without calling Stripe', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash' }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('paid_cash');
    const rows = await db.select().from(payment).where(eq(payment.visitId, v1));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe('cash');
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[0]!.amountCents).toBe(4500); // one-off, 1 bin
  });

  it('honours an operator amount override on cash', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash', amount_cents: 4000 }), res);

    expect(res.statusCode).toBe(200);
    const rows = await getDb().select().from(payment).where(eq(payment.visitId, v1));
    expect(rows[0]!.amountCents).toBe(4000);
  });

  it('records a terminal (tap in Stripe app) payment', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'terminal' }), res);

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, v1));
    expect(v!.paymentStatus).toBe('paid_terminal');
    const rows = await db.select().from(payment).where(eq(payment.visitId, v1));
    expect(rows[0]!.method).toBe('terminal');
  });

  it('rejects a negative amount override', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'cash', amount_cents: -100 }), res);

    expect(res.statusCode).toBe(400);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('scheduled');
  });

  it('marks a QR payment awaiting_payment and returns no url when Stripe is unconfigured', async () => {
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const spy = vi.spyOn(templates, 'doneTemplate');
    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'qr' }), res);

    expect(res.statusCode).toBe(200);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
    // Stripe is unconfigured in tests: the clean still completes, no session
    // is created (charge.attempted stays false), so the email correctly gets
    // no payment sentence at all.
    expect(v!.paymentStatus).toBe('unpaid');
    expect(spy.mock.calls[0]![0].charge).toEqual({ kind: 'none' });
    spy.mockRestore();
  });

  it('does not tell the customer they were charged when a QR checkout session is created but not yet paid', async () => {
    // Regression test: a Stripe Checkout Session being *created* is not the
    // same as the customer having *paid* — confirmation only arrives later via
    // the checkout.session.completed webhook (Task 5). The done email must
    // never say "Your card on file was charged" for QR at Done time, even
    // when the session-create call succeeds. Simulate that success path by
    // mocking createDoorstepCheckoutSession directly (Stripe itself stays
    // unconfigured/untouched).
    const c = await seedCustomer();
    const v1 = await addVisit(c, '2026-07-24');

    const templateSpy = vi.spyOn(templates, 'doneTemplate');
    const sessionSpy = vi.spyOn(billing, 'createDoorstepCheckoutSession').mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/c/pay/cs_test_qr',
      sessionId: 'cs_test_qr',
    });

    const res = mockRes();
    await handler(await req(true, v1, 'POST', { payment_method: 'qr' }), res);

    expect(res.statusCode).toBe(200);
    const [v] = await getDb().select().from(visit).where(eq(visit.id, v1));
    expect(v!.status).toBe('done');
    expect(v!.paymentStatus).toBe('awaiting_payment');
    // The HTTP `charge` object is untouched by this fix — /ops still needs to
    // know a session was created (it renders the QR / payment link there).
    expect(res.body.charge).toMatchObject({ attempted: true, ok: true, amount_cents: 4500 });
    // But the customer-facing email must NOT claim a charge happened.
    expect(templateSpy).toHaveBeenCalledTimes(1);
    expect(templateSpy.mock.calls[0]![0].charge).toEqual({ kind: 'none' });

    templateSpy.mockRestore();
    sessionSpy.mockRestore();
  });
});
