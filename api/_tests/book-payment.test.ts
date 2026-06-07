import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mockReq, mockRes } from './_helpers.js';
import { truncateAllForTests } from './_db_cleanup.js';
import { getDb } from '../../db/client.js';
import { customer, subscription, visit } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const billingMocks = vi.hoisted(() => ({
  createBookingSetupIntent: vi.fn(),
  getSavedPaymentMethodFromSetupIntent: vi.fn(),
  createStripeCustomer: vi.fn(),
}));

const stripeMocks = vi.hoisted(() => ({
  configured: true,
}));

vi.mock('../../lib/billing.js', () => ({
  createBookingSetupIntent: billingMocks.createBookingSetupIntent,
  getSavedPaymentMethodFromSetupIntent: billingMocks.getSavedPaymentMethodFromSetupIntent,
  createStripeCustomer: billingMocks.createStripeCustomer,
}));

vi.mock('../../lib/stripe.js', () => ({
  isStripeConfigured: () => stripeMocks.configured,
}));

const { default: handler } = await import('../book.js');

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set (run `vercel env pull .env.local`)');
  }
});

beforeEach(async () => {
  await truncateAllForTests();
  stripeMocks.configured = true;
  billingMocks.createBookingSetupIntent.mockReset();
  billingMocks.getSavedPaymentMethodFromSetupIntent.mockReset();
  billingMocks.createStripeCustomer.mockReset();
});

const validBody = {
  name: 'Sam Customer',
  email: 'sam-pay@example.com',
  phone: '780-555-0100',
  street: '123 Main St',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 1A1',
  pickup_day: 'wednesday',
  bin_count: 2,
};

describe('POST /api/book payment setup', () => {
  it('creates a booking-time SetupIntent without writing customer rows', async () => {
    billingMocks.createBookingSetupIntent.mockResolvedValueOnce({
      status: 'ok',
      clientSecret: 'seti_secret',
      publishableKey: 'pk_test_x',
      stripeCustomerId: 'cus_booking',
      setupIntentId: 'seti_booking',
    });

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: {
        intent: 'payment_setup',
        name: 'Sam Customer',
        email: 'sam-pay@example.com',
        phone: '780-555-0100',
        postal_code: 'T8L 1A1',
      },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      client_secret: 'seti_secret',
      publishable_key: 'pk_test_x',
      stripe_customer_id: 'cus_booking',
      setup_intent_id: 'seti_booking',
    });
    expect(billingMocks.createBookingSetupIntent).toHaveBeenCalledWith({
      email: 'sam-pay@example.com',
      name: 'Sam Customer',
      phone: '780-555-0100',
    });

    const db = getDb();
    const rows = await db.select().from(customer).where(eq(customer.email, 'sam-pay@example.com'));
    expect(rows).toHaveLength(0);
  });

  it('rejects out-of-area payment setup before creating a SetupIntent', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: {
        intent: 'payment_setup',
        name: 'Sam Customer',
        email: 'sam-pay@example.com',
        phone: '780-555-0100',
        postal_code: 'T5J 1A1',
      },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ status: 'out_of_area' });
    expect(billingMocks.createBookingSetupIntent).not.toHaveBeenCalled();
  });

  it('rejects payment setup for an email with an active subscription before creating a SetupIntent', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId,
      email: 'sam-pay@example.com',
      name: 'Sam Customer',
      phone: '780-555-0100',
      street: '123 Main St',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L 1A1',
      pickupDay: 'wednesday',
    });
    await db.insert(subscription).values({
      id: crypto.randomUUID(),
      customerId,
      cadence: 'monthly',
      binCount: 1,
      startedOn: new Date('2026-06-01T12:00:00Z'),
    });

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: {
        intent: 'payment_setup',
        name: 'Sam Customer',
        email: 'sam-pay@example.com',
        phone: '780-555-0100',
        postal_code: 'T8L 1A1',
      },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ status: 'already_subscribed' });
    expect(billingMocks.createBookingSetupIntent).not.toHaveBeenCalled();
  });

  it('rejects payment setup when any subscription for the email is active', async () => {
    const db = getDb();
    const customerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: customerId,
      email: 'sam-pay@example.com',
      name: 'Sam Customer',
      phone: '780-555-0100',
      street: '123 Main St',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L 1A1',
      pickupDay: 'wednesday',
    });
    await db.insert(subscription).values([
      {
        id: crypto.randomUUID(),
        customerId,
        cadence: 'monthly',
        binCount: 1,
        status: 'cancelled',
        startedOn: new Date('2026-05-01T12:00:00Z'),
        cancelledAt: new Date('2026-05-10T12:00:00Z'),
      },
      {
        id: crypto.randomUUID(),
        customerId,
        cadence: 'seasonal',
        binCount: 2,
        status: 'active',
        startedOn: new Date('2026-06-01T12:00:00Z'),
      },
    ]);

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: {
        intent: 'payment_setup',
        name: 'Sam Customer',
        email: 'sam-pay@example.com',
        phone: '780-555-0100',
        postal_code: 'T8L 1A1',
      },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ status: 'already_subscribed' });
    expect(billingMocks.createBookingSetupIntent).not.toHaveBeenCalled();
  });

  it('requires payment setup before final booking when Stripe is configured', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, plan: 'monthly' },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      status: 'invalid',
      errors: expect.objectContaining({ payment_setup: expect.any(Array) }),
    });
  });

  it('stores the verified Stripe customer and payment method when final booking succeeds', async () => {
    billingMocks.getSavedPaymentMethodFromSetupIntent.mockResolvedValueOnce('pm_saved');

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: {
        ...validBody,
        plan: 'oneoff',
        oneoff_date: '2099-07-15',
        payment_setup: {
          stripe_customer_id: 'cus_booking',
          setup_intent_id: 'seti_booking',
        },
      },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(billingMocks.getSavedPaymentMethodFromSetupIntent).toHaveBeenCalledWith('seti_booking', 'cus_booking');

    const db = getDb();
    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam-pay@example.com'));
    expect(c!.stripeCustomerId).toBe('cus_booking');
    expect(c!.defaultPaymentMethodId).toBe('pm_saved');

    const visits = await db.select().from(visit).where(eq(visit.customerId, c!.id));
    expect(visits).toHaveLength(1);
  });

  it('refreshes stale existing customer details when booking a new plan', async () => {
    const db = getDb();
    const existingCustomerId = crypto.randomUUID();
    await db.insert(customer).values({
      id: existingCustomerId,
      email: 'sam-pay@example.com',
      name: 'Old Name',
      phone: '780-555-0000',
      street: '14 Clover Lane',
      city: 'Spruce Grove',
      postalCode: 'T8L0A1',
      pickupDay: 'monday',
      stripeCustomerId: 'cus_old',
      defaultPaymentMethodId: 'pm_old',
    });
    billingMocks.getSavedPaymentMethodFromSetupIntent.mockResolvedValueOnce('pm_new');

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: {
        ...validBody,
        name: 'New Booking Name',
        phone: '780-555-9999',
        street: '999 New Street',
        city: 'Fort Saskatchewan',
        postal_code: 'T8L 9Z9',
        pickup_day: 'wednesday',
        plan: 'monthly',
        payment_setup: {
          stripe_customer_id: 'cus_new',
          setup_intent_id: 'seti_new',
        },
      },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', customer_id: existingCustomerId });

    const [c] = await db.select().from(customer).where(eq(customer.email, 'sam-pay@example.com'));
    expect(c).toMatchObject({
      id: existingCustomerId,
      name: 'New Booking Name',
      phone: '780-555-9999',
      street: '999 New Street',
      city: 'Fort Saskatchewan',
      postalCode: 'T8L9Z9',
      pickupDay: 'wednesday',
      stripeCustomerId: 'cus_new',
      defaultPaymentMethodId: 'pm_new',
    });

    const subs = await db.select().from(subscription).where(eq(subscription.customerId, existingCustomerId));
    expect(subs).toHaveLength(1);
    expect(subs[0]!).toMatchObject({ cadence: 'monthly', binCount: 2, status: 'active' });

    const visits = await db.select().from(visit).where(eq(visit.customerId, existingCustomerId));
    expect(visits).toHaveLength(12);
  });
});
