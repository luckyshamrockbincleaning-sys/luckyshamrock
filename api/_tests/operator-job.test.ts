import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { handleNewJob as handler, handleDone as doneHandler, handleNotify as notifyHandler } from '../../lib/operator-handlers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, visit, notificationLog, magicLinkToken } from '../../db/schema.js';
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

async function req(authed: boolean, body: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
  return { method: 'POST', headers, query: {}, body };
}

const validJob = { street: '9 Curb Lane', postal_code: 'T8L 0A1', bin_count: 1, email: 'walkup@example.com', name: 'Curb Neighbour' };

describe('POST /api/operator/job (walk-up)', () => {
  it('returns 401 without an operator cookie', async () => {
    const res = mockRes();
    await handler(await req(false, validJob), res);
    expect(res.statusCode).toBe(401);
  });

  it('creates a customer and a one-off visit scheduled today', async () => {
    const res = mockRes();
    await handler(await req(true, validJob), res);

    expect(res.statusCode).toBe(201);
    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'walkup@example.com'));
    expect(c).toBeDefined();
    expect(c!.street).toBe('9 Curb Lane');
    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(1);
    expect(visits[0]!.subscriptionId).toBeNull();
    expect(visits[0]!.binCount).toBe(1);
    expect(visits[0]!.status).toBe('scheduled');
  });

  it('accepts an out-of-area postal code (operator is standing there)', async () => {
    const res = mockRes();
    await handler(await req(true, { ...validJob, email: 'oot@example.com', postal_code: 'T5J 0N3' }), res);
    expect(res.statusCode).toBe(201);
  });

  it('generates a placeholder email when none is given', async () => {
    const res = mockRes();
    await handler(
      await req(true, { street: '11 Curb Lane', postal_code: 'T8L 0A1', bin_count: 2, phone: '780-555-0134' }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const rows = await getDb().select().from(customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toMatch(/^walkup\+[0-9a-f]{8}@luckyshamrock\.ca$/);
  });

  describe('which bins', () => {
    it('records the bins the operator ticked', async () => {
      const res = mockRes();
      await handler(
        await req(true, { street: '9 Curb Lane', phone: '780-555-0170', bin_count: 2, bin_types: ['organics', 'garbage'] }),
        res,
      );
      expect(res.statusCode).toBe(201);
      const [v] = await getDb().select().from(visit);
      expect(v!.binCount).toBe(2);
      // Canonical order, not the order they were tapped.
      expect(v!.binTypes).toEqual(['garbage', 'organics']);
    });

    it('still works without bin_types', async () => {
      const res = mockRes();
      await handler(await req(true, { street: '9 Curb Lane', phone: '780-555-0171', bin_count: 1 }), res);
      expect(res.statusCode).toBe(201);
      const [v] = await getDb().select().from(visit);
      expect(v!.binTypes).toBeNull();
    });

    it('rejects a count that disagrees with the bins listed', async () => {
      const res = mockRes();
      await handler(
        await req(true, { street: '9 Curb Lane', phone: '780-555-0172', bin_count: 1, bin_types: ['garbage', 'organics'] }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(await getDb().select().from(visit)).toHaveLength(0);
    });
  });

  describe('reachability', () => {
    // Written after 73 Woodbend Way: a $57 walk-up with no phone and no email,
    // done and never paid, with no way to follow up short of driving there.
    it('rejects a job with neither a phone number nor an email', async () => {
      const res = mockRes();
      await handler(await req(true, { street: '73 Woodbend Way', bin_count: 2 }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.status).toBe('invalid');
      expect(res.body.errors.phone?.[0]).toMatch(/phone number or an email/i);
      expect(await getDb().select().from(customer)).toHaveLength(0);
      expect(await getDb().select().from(visit)).toHaveLength(0);
    });

    it('accepts a phone alone', async () => {
      const res = mockRes();
      await handler(await req(true, { street: '73 Woodbend Way', phone: '780-667-9919' }), res);
      expect(res.statusCode).toBe(201);
      const [c] = await getDb().select().from(customer);
      expect(c!.phone).toBe('780-667-9919');
    });

    it('accepts an email alone', async () => {
      const res = mockRes();
      await handler(await req(true, { street: '73 Woodbend Way', email: 'dona@example.com' }), res);
      expect(res.statusCode).toBe(201);
    });

    it('rejects a blank phone string as no phone at all', async () => {
      const res = mockRes();
      await handler(await req(true, { street: '73 Woodbend Way', phone: '   ' }), res);
      expect(res.statusCode).toBe(400);
      expect(await getDb().select().from(visit)).toHaveLength(0);
    });
  });

  it('reuses an existing customer with the same email', async () => {
    const first = mockRes();
    await handler(await req(true, validJob), first);
    const second = mockRes();
    await handler(await req(true, { ...validJob, bin_count: 3 }), second);

    expect(second.statusCode).toBe(201);
    const customers = await getDb().select().from(customer).where(eq(customer.email, 'walkup@example.com'));
    expect(customers).toHaveLength(1);
    const visits = await getDb().select().from(visit).where(eq(visit.customerId, customers[0]!.id));
    expect(visits).toHaveLength(2);
  });

  it('rolls back the customer insert when the visit insert fails (atomicity)', async () => {
    const db = getDb();

    // Pre-seed a "victim" customer + visit so we can force a deterministic
    // DB-level failure on the *visit* insert without violating newJobSchema's
    // own validation (bin_count etc. all stay valid — only the visit's
    // primary-key uniqueness constraint trips).
    const victimCustomerId = crypto.randomUUID();
    const clashingVisitId = crypto.randomUUID();
    await db.insert(customer).values({
      id: victimCustomerId,
      email: 'victim@example.com',
      name: 'Victim',
      street: '1 Victim Ave',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L0A1',
      pickupDay: 'wednesday',
    });
    await db.insert(visit).values({
      id: clashingVisitId,
      customerId: victimCustomerId,
      subscriptionId: null,
      binCount: 1,
      scheduledFor: new Date(),
      status: 'scheduled',
    });

    // handleNewJob's first crypto.randomUUID() call mints the new visit's id.
    // Force just that call to collide with the pre-seeded visit's id so the
    // visit insert hits the primary-key unique constraint — a deterministic
    // failure that only trips AFTER the (new) customer insert has run inside
    // the same transaction.
    const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(clashingVisitId);

    try {
      const res = mockRes();
      await handler(await req(true, { ...validJob, email: 'atomic@example.com' }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        status: 'error',
        message: 'Something went wrong on our end. Please try again.',
      });

      // The customer insert must have rolled back along with the failed visit
      // insert — no orphan customer row with zero visits left behind.
      const newCustomers = await db.select().from(customer).where(eq(customer.email, 'atomic@example.com'));
      expect(newCustomers).toHaveLength(0);
    } finally {
      uuidSpy.mockRestore();
    }
  });

  it('rejects a missing street', async () => {
    const res = mockRes();
    await handler(await req(true, { postal_code: 'T8L 0A1', bin_count: 1 }), res);
    expect(res.statusCode).toBe(400);
  });

  it('sends no customer email to a placeholder walk-up address on Done', async () => {
    const res = mockRes();
    await handler(await req(true, { street: '12 Curb Lane', postal_code: 'T8L 0A1', bin_count: 1, phone: '780-555-0112' }), res);
    expect(res.statusCode).toBe(201);

    const { visit_id } = res.body as { visit_id: string };
    const doneRes = mockRes();
    const cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
    await doneHandler(
      { method: 'POST', headers: { cookie }, query: { id: visit_id }, body: { payment_method: 'cash' } } as any,
      doneRes,
    );
    expect(doneRes.statusCode).toBe(200);

    const logs = await getDb().select().from(notificationLog);
    expect(logs.filter((l) => l.kind === 'done')).toHaveLength(0);
  });

  it('sends no customer email to a placeholder walk-up address on Notify', async () => {
    const res = mockRes();
    await handler(await req(true, { street: '13 Curb Lane', postal_code: 'T8L 0A1', bin_count: 1, phone: '780-555-0113' }), res);
    expect(res.statusCode).toBe(201);

    const { visit_id } = res.body as { visit_id: string };
    const notifyRes = mockRes();
    const cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
    await notifyHandler(
      { method: 'POST', headers: { cookie }, query: { id: visit_id }, body: {} } as any,
      notifyRes,
    );
    expect(notifyRes.statusCode).toBe(200);
    expect(notifyRes.body.status).toBe('ok');

    // The visit should be marked heading_there despite no email being sent
    const db = getDb();
    const [v] = await db.select().from(visit).where(eq(visit.id, visit_id));
    expect(v!.status).toBe('heading_there');
    expect(v!.headingThereAt).not.toBeNull();

    // No on_our_way notification log entry for placeholder emails
    const logs = await db.select().from(notificationLog);
    expect(logs.filter((l) => l.kind === 'on_our_way')).toHaveLength(0);
  });

  describe('optional scheduled_for ("come back in two weeks")', () => {
    // Mirrors operatorTodayISO() — Edmonton-local, which is what the handler
    // defaults to and validates against.
    function edmontonTodayISO(): string {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Edmonton',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    }
    function isoPlusDays(iso: string, days: number): string {
      const d = new Date(`${iso}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    }

    it('defaults to today when scheduled_for is omitted', async () => {
      const res = mockRes();
      await handler(await req(true, validJob), res);

      expect(res.statusCode).toBe(201);
      expect(res.body.scheduled_for).toBe(edmontonTodayISO());
      const db = getDb();
      const [v] = await db.select().from(visit).where(eq(visit.id, res.body.visit_id));
      expect(v!.scheduledFor.toISOString().slice(0, 10)).toBe(edmontonTodayISO());
    });

    it('schedules the visit on an explicit future date', async () => {
      const target = isoPlusDays(edmontonTodayISO(), 14);
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: target }), res);

      expect(res.statusCode).toBe(201);
      expect(res.body.scheduled_for).toBe(target);
      const db = getDb();
      const [v] = await db.select().from(visit).where(eq(visit.id, res.body.visit_id));
      expect(v!.scheduledFor.toISOString().slice(0, 10)).toBe(target);
      expect(v!.status).toBe('scheduled');
    });

    it('accepts today explicitly', async () => {
      const today = edmontonTodayISO();
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: today }), res);
      expect(res.statusCode).toBe(201);
      expect(res.body.scheduled_for).toBe(today);
    });

    it('rejects a past date and creates nothing', async () => {
      const past = isoPlusDays(edmontonTodayISO(), -1);
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: past }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.errors.scheduled_for.join(' ')).toMatch(/past/);
      const db = getDb();
      expect(await db.select().from(visit)).toHaveLength(0);
      expect(await db.select().from(customer)).toHaveLength(0);
    });

    it('rejects a date more than a year out (guards a typo’d year)', async () => {
      const farOut = isoPlusDays(edmontonTodayISO(), 400);
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: farOut }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.errors.scheduled_for.join(' ')).toMatch(/year/);
      expect(await getDb().select().from(visit)).toHaveLength(0);
    });

    it('rejects a malformed date', async () => {
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: '14th of never' }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.errors.scheduled_for).toBeDefined();
    });

    it('rejects a regex-valid but non-existent calendar date', async () => {
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: '2026-02-31' }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.errors.scheduled_for.join(' ')).toMatch(/real calendar date/);
    });

    it('emails a booking confirmation for a future-dated job when a real email was given', async () => {
      const target = isoPlusDays(edmontonTodayISO(), 14);
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: target }), res);

      expect(res.statusCode).toBe(201);
      expect(res.body.confirmation_sent).toBe(true);
      const db = getDb();
      const logs = await db
        .select()
        .from(notificationLog)
        .where(eq(notificationLog.visitId, res.body.visit_id));
      const confirmations = logs.filter((l) => l.kind === 'booking_confirmed');
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]!.sentAt).not.toBeNull();
      expect(confirmations[0]!.failedAt).toBeNull();
      // The email carries a manage link, so a magic-link token must exist.
      const [c] = await db.select().from(customer).where(eq(customer.email, 'walkup@example.com'));
      expect(confirmations[0]!.customerId).toBe(c!.id);
      const tokens = await db.select().from(magicLinkToken).where(eq(magicLinkToken.customerId, c!.id));
      expect(tokens).toHaveLength(1);
    });

    it('sends NO confirmation for a same-day job (operator is standing right there)', async () => {
      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: edmontonTodayISO() }), res);

      expect(res.statusCode).toBe(201);
      expect(res.body.confirmation_sent).toBe(false);
      const logs = await getDb().select().from(notificationLog);
      expect(logs.filter((l) => l.kind === 'booking_confirmed')).toHaveLength(0);
      // No manage link is minted when nothing is emailed.
      expect(await getDb().select().from(magicLinkToken)).toHaveLength(0);
    });

    it('sends NO confirmation for a future job booked without an email (placeholder address)', async () => {
      const target = isoPlusDays(edmontonTodayISO(), 14);
      // Phone but no email: reachable, so the job is allowed, but there is no
      // address to send a written confirmation to.
      const { email: _drop, ...noEmail } = validJob;
      const res = mockRes();
      await handler(await req(true, { ...noEmail, phone: '780-555-0155', scheduled_for: target }), res);

      expect(res.statusCode).toBe(201);
      expect(res.body.confirmation_sent).toBe(false);
      const logs = await getDb().select().from(notificationLog);
      expect(logs.filter((l) => l.kind === 'booking_confirmed')).toHaveLength(0);
      expect(await getDb().select().from(magicLinkToken)).toHaveLength(0);
    });

    it('allows a Sunday, unlike the customer-facing booking form', async () => {
      // The operator is standing at the bin making the deal — this endpoint
      // already trusts them over the system (it skips the service-area gate).
      let candidate = isoPlusDays(edmontonTodayISO(), 1);
      for (let i = 0; i < 7 && new Date(`${candidate}T12:00:00Z`).getUTCDay() !== 0; i++) {
        candidate = isoPlusDays(candidate, 1);
      }
      expect(new Date(`${candidate}T12:00:00Z`).getUTCDay()).toBe(0);

      const res = mockRes();
      await handler(await req(true, { ...validJob, scheduled_for: candidate }), res);
      expect(res.statusCode).toBe(201);
      expect(res.body.scheduled_for).toBe(candidate);
    });
  });
});

describe('walk-up customers can refer too', () => {
  it('issues a referral code to a walk-up customer', async () => {
    const res = mockRes();
    await handler(await req(true, validJob), res);
    expect(res.statusCode).toBe(201);

    const [c] = await getDb().select().from(customer).where(eq(customer.email, 'walkup@example.com'));
    // Without a code this customer could never refer a neighbour, and the
    // backfill script only ever runs once at deploy.
    expect(c!.referralCode).toBeTruthy();
    expect(c!.referralCode).toHaveLength(6);
    expect(c!.referralCode).not.toMatch(/[01OIL]/);
  });
});

describe('walk-up form: phone instead of postal code, and editing', () => {
  it('creates a job with a phone and no postal code', async () => {
    const res = mockRes();
    await handler(await req(true, {
      name: 'Doorstep Dan', street: '9 Curb Lane', phone: '780-555-0142',
      bin_count: 2, email: 'dan@example.com',
    }), res);

    expect(res.statusCode).toBe(201);
    const [c] = await getDb().select().from(customer).where(eq(customer.email, 'dan@example.com'));
    expect(c!.phone).toBe('780-555-0142');
    expect(c!.postalCode).toBeNull();
    expect(c!.street).toBe('9 Curb Lane');
  });

  it('works with no phone as long as an email was given', async () => {
    // Phone is not individually mandatory — one of the two is.
    const res = mockRes();
    await handler(await req(true, { street: '11 Curb Lane', bin_count: 1, email: 'nophone@example.com' }), res);
    expect(res.statusCode).toBe(201);
  });

  it('still requires a street', async () => {
    const res = mockRes();
    await handler(await req(true, { phone: '780-555-0142', bin_count: 1 }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/operator/customer — fix a walk-up\'s details', () => {
  async function editReq(authed: boolean, body: Record<string, unknown>) {
    const headers: Record<string, string> = {};
    if (authed) headers.cookie = `${OPERATOR_COOKIE_NAME}=${await signOperatorCookie()}`;
    return { method: 'POST', headers, query: {}, body } as any;
  }

  it('returns 401 without an operator cookie', async () => {
    const { handleEditCustomer } = await import('../../lib/operator-handlers.js');
    const res = mockRes();
    await handleEditCustomer(await editReq(false, {}), res);
    expect(res.statusCode).toBe(401);
  });

  it('corrects a typo in the address and adds an email afterwards', async () => {
    const { handleEditCustomer } = await import('../../lib/operator-handlers.js');
    const created = mockRes();
    await handler(await req(true, { name: 'Typo Tim', street: '9 Crub Lane', phone: '780-555-0100', bin_count: 1 }), created);
    const cid = created.body.customer_id;

    const res = mockRes();
    await handleEditCustomer(await editReq(true, {
      customer_id: cid, street: '9 Curb Lane', email: 'tim@example.com', name: 'Tim Curb',
    }), res);

    expect(res.statusCode).toBe(200);
    const [c] = await getDb().select().from(customer).where(eq(customer.id, cid));
    expect(c!.street).toBe('9 Curb Lane');
    expect(c!.email).toBe('tim@example.com');
    expect(c!.name).toBe('Tim Curb');
    expect(c!.phone).toBe('780-555-0100'); // untouched
  });

  it('rejects an email already used by someone else', async () => {
    const { handleEditCustomer } = await import('../../lib/operator-handlers.js');
    const a = mockRes();
    await handler(await req(true, { street: '1 A St', email: 'taken@example.com', bin_count: 1 }), a);
    const b = mockRes();
    await handler(await req(true, { street: '2 B St', bin_count: 1, phone: '780-555-0102' }), b);

    const res = mockRes();
    await handleEditCustomer(await editReq(true, { customer_id: b.body.customer_id, email: 'taken@example.com' }), res);
    expect(res.statusCode).toBe(409);
  });

  it('404s for an unknown customer', async () => {
    const { handleEditCustomer } = await import('../../lib/operator-handlers.js');
    const res = mockRes();
    await handleEditCustomer(await editReq(true, { customer_id: crypto.randomUUID(), street: 'X' }), res);
    expect(res.statusCode).toBe(404);
  });
});
