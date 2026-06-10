import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// The webhook handler is the security boundary for the money path: it must
// reject forged requests (bad/absent signature) WITHOUT touching the DB, and
// only apply events whose signature verifies. We mock the Stripe SDK + the apply
// layer so we can exercise every branch (no network, no DB).
const h = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  apply: vi.fn(),
  configured: { value: true },
}));

vi.mock('../../lib/stripe.js', () => ({
  isStripeConfigured: () => h.configured.value,
  getStripe: () => ({ webhooks: { constructEventAsync: h.constructEvent } }),
}));
vi.mock('../../lib/billing-webhook.js', () => ({
  applyStripeEvent: h.apply,
}));

const { default: handler } = await import('../stripe/webhook.js');

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

function makeReq({ method = 'POST', headers = {}, body = '{}' }: { method?: string; headers?: Record<string, unknown>; body?: string } = {}): any {
  const r: any = Readable.from([Buffer.from(body)]);
  r.method = method;
  r.headers = headers;
  return r;
}

beforeEach(() => {
  h.constructEvent.mockReset();
  h.apply.mockReset();
  h.configured.value = true;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('POST /api/stripe/webhook', () => {
  it('405s a non-POST', async () => {
    const res = mockRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('accepts-and-ignores when Stripe is not configured', async () => {
    h.configured.value = false;
    const res = mockRes();
    await handler(makeReq({ headers: { 'stripe-signature': 'sig' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('accepts-and-ignores when the webhook secret is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = mockRes();
    await handler(makeReq({ headers: { 'stripe-signature': 'sig' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ignored');
  });

  it('400s when the stripe-signature header is missing', async () => {
    const res = mockRes();
    await handler(makeReq({ headers: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('400s and does NOT apply when the signature fails verification', async () => {
    h.constructEvent.mockRejectedValueOnce(new Error('No signatures found matching the expected signature'));
    const res = mockRes();
    await handler(makeReq({ headers: { 'stripe-signature': 'forged' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe('invalid');
    expect(h.apply).not.toHaveBeenCalled(); // forged event must never mutate state
  });

  it('applies the event and returns 200 when the signature verifies', async () => {
    h.constructEvent.mockResolvedValueOnce({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });
    h.apply.mockResolvedValueOnce('payment_intent.succeeded:applied');
    const res = mockRes();
    await handler(makeReq({ headers: { 'stripe-signature': 'good' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', handled: 'payment_intent.succeeded:applied' });
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('500s (so Stripe retries) when a verified event fails to apply', async () => {
    h.constructEvent.mockResolvedValueOnce({ type: 'payment_intent.succeeded', data: { object: {} } });
    h.apply.mockRejectedValueOnce(new Error('db down'));
    const res = mockRes();
    await handler(makeReq({ headers: { 'stripe-signature': 'good' } }), res);
    expect(res.statusCode).toBe(500);
  });
});
