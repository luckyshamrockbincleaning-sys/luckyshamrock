import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Stripe client layer so these tests never touch the network.
const mockCustomersCreate = vi.fn();
const mockSetupIntentsCreate = vi.fn();
const mockSetupIntentsRetrieve = vi.fn();
const mockPaymentIntentsCreate = vi.fn();
let configured = true;

vi.mock('../stripe.js', () => ({
  isStripeConfigured: () => configured,
  getStripe: () => ({
    customers: { create: mockCustomersCreate },
    setupIntents: { create: mockSetupIntentsCreate, retrieve: mockSetupIntentsRetrieve },
    paymentIntents: { create: mockPaymentIntentsCreate },
  }),
}));

const {
  createStripeCustomer,
  createSetupIntent,
  createBookingSetupIntent,
  getSavedPaymentMethodFromSetupIntent,
  chargeOffSession,
} = await import('../billing.js');

beforeEach(() => {
  configured = true;
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_x';
  mockCustomersCreate.mockReset();
  mockSetupIntentsCreate.mockReset();
  mockSetupIntentsRetrieve.mockReset();
  mockPaymentIntentsCreate.mockReset();
});

describe('createStripeCustomer', () => {
  it('returns the new customer id when configured', async () => {
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_123' });
    const id = await createStripeCustomer({ email: 'a@b.com', name: 'A' });
    expect(id).toBe('cus_123');
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', name: 'A' }),
    );
  });

  it('returns null (no-op) when Stripe is not configured', async () => {
    configured = false;
    const id = await createStripeCustomer({ email: 'a@b.com', name: 'A' });
    expect(id).toBeNull();
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });
});

describe('createSetupIntent', () => {
  it('returns client secret + publishable key when configured', async () => {
    mockSetupIntentsCreate.mockResolvedValueOnce({ client_secret: 'seti_secret' });
    const r = await createSetupIntent('cus_123');
    expect(r).toEqual({ clientSecret: 'seti_secret', publishableKey: 'pk_test_x' });
    expect(mockSetupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_123', usage: 'off_session' }),
    );
  });

  it('returns null when not configured', async () => {
    configured = false;
    expect(await createSetupIntent('cus_123')).toBeNull();
  });

  it('returns null when publishable key is missing', async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    mockSetupIntentsCreate.mockResolvedValueOnce({ client_secret: 'seti_secret' });
    expect(await createSetupIntent('cus_123')).toBeNull();
  });
});

describe('booking setup intents', () => {
  it('creates a Stripe customer and setup intent for booking-time card save', async () => {
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_booking' });
    mockSetupIntentsCreate.mockResolvedValueOnce({ id: 'seti_booking', client_secret: 'seti_secret' });

    const r = await createBookingSetupIntent({
      email: 'sam@example.com',
      name: 'Sam Customer',
      phone: '780-555-0100',
    });

    expect(r).toEqual({
      stripeCustomerId: 'cus_booking',
      setupIntentId: 'seti_booking',
      clientSecret: 'seti_secret',
      publishableKey: 'pk_test_x',
    });
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'sam@example.com', name: 'Sam Customer', phone: '780-555-0100' }),
    );
    expect(mockSetupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_booking', usage: 'off_session' }),
    );
  });

  it('returns the saved payment method only for a succeeded setup intent matching the customer', async () => {
    mockSetupIntentsRetrieve.mockResolvedValueOnce({
      id: 'seti_booking',
      status: 'succeeded',
      customer: 'cus_booking',
      payment_method: 'pm_saved',
    });

    await expect(getSavedPaymentMethodFromSetupIntent('seti_booking', 'cus_booking')).resolves.toBe('pm_saved');

    mockSetupIntentsRetrieve.mockResolvedValueOnce({
      id: 'seti_other',
      status: 'succeeded',
      customer: 'cus_other',
      payment_method: 'pm_other',
    });

    await expect(getSavedPaymentMethodFromSetupIntent('seti_other', 'cus_booking')).resolves.toBeNull();
  });
});

describe('chargeOffSession', () => {
  it('returns ok=true with the payment intent id on success', async () => {
    mockPaymentIntentsCreate.mockResolvedValueOnce({ id: 'pi_1', status: 'succeeded' });
    const r = await chargeOffSession({ stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 3500 });
    expect(r.ok).toBe(true);
    expect(r.paymentIntentId).toBe('pi_1');
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3500, currency: 'cad', off_session: true, confirm: true }),
      undefined,
    );
  });

  it('passes an idempotency key through when provided', async () => {
    mockPaymentIntentsCreate.mockResolvedValueOnce({ id: 'pi_2', status: 'succeeded' });
    await chargeOffSession({ stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 100, idempotencyKey: 'visit-abc' });
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: 'visit-abc' });
  });

  it('returns ok=false with the decline message (no throw) on a card error', async () => {
    mockPaymentIntentsCreate.mockRejectedValueOnce(
      Object.assign(new Error('Your card was declined.'), { payment_intent: { id: 'pi_3', status: 'requires_payment_method' } }),
    );
    const r = await chargeOffSession({ stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 3500 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/declined/i);
    expect(r.paymentIntentId).toBe('pi_3');
  });

  it('returns ok=false when not configured (never throws)', async () => {
    configured = false;
    const r = await chargeOffSession({ stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 3500 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('stripe_not_configured');
  });
});
