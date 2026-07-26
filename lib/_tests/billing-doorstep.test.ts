import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createSession = vi.fn();
vi.mock('../stripe.js', () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({ checkout: { sessions: { create: createSession } } }),
}));

import { createDoorstepCheckoutSession } from '../billing.js';

beforeEach(() => {
  createSession.mockReset();
  process.env.SITE_URL = 'https://www.luckyshamrock.ca';
});
afterEach(() => {
  delete process.env.SITE_URL;
});

describe('createDoorstepCheckoutSession', () => {
  it('creates a CAD session for the exact amount and tags the visit', async () => {
    createSession.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const result = await createDoorstepCheckoutSession({
      visitId: 'visit-123',
      amountCents: 5700,
      description: 'Garbage bin cleaning — 2 bins',
    });

    expect(result).toEqual({ sessionId: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const arg = createSession.mock.calls[0]![0];
    expect(arg.mode).toBe('payment');
    expect(arg.metadata.visit_id).toBe('visit-123');
    expect(arg.line_items[0].price_data.currency).toBe('cad');
    expect(arg.line_items[0].price_data.unit_amount).toBe(5700);
  });

  it('returns null when Stripe throws instead of propagating', async () => {
    createSession.mockRejectedValue(new Error('stripe down'));
    const result = await createDoorstepCheckoutSession({
      visitId: 'visit-123',
      amountCents: 4500,
      description: 'Garbage bin cleaning',
    });
    expect(result).toBeNull();
  });
});
