import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the deliverability check rather than DNS itself: this file is about the
// HTTP wiring (does an undeliverable address 422 before we take a card?), and
// the verdict logic has its own tests in lib/_tests/email-domain.test.ts.
const mockCheck = vi.fn();
vi.mock('../../lib/email-domain.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/email-domain.js')>(
    '../../lib/email-domain.js',
  );
  return { ...actual, checkEmailDomain: mockCheck };
});

vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => [] }) }),
  }),
}));

vi.mock('../../lib/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, gmailMessageId: 'stub' }),
}));

const { default: handler } = await import('../book.js');
const { mockReq, mockRes } = await import('./_helpers.js');

const validBody = {
  name: 'Sam Customer',
  email: 'sam@example.com',
  street: '123 Main St',
  city: 'Fort Saskatchewan',
  postal_code: 'T8L 1A1',
  pickup_day: 'wednesday' as const,
  bin_count: 2,
  plan: 'monthly' as const,
};

describe('POST /api/book — undeliverable email addresses', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockCheck.mockReset();
  });

  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('refuses to start card setup for a domain with no mail server', async () => {
    mockCheck.mockResolvedValue('undeliverable');
    const res = mockRes();
    await handler(
      mockReq({
        method: 'POST',
        body: {
          intent: 'payment_setup',
          name: 'Corinne',
          email: 'corikara@hotmail.co',
          postal_code: 'T8L 1A1',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(res.body.status).toBe('email_undeliverable');
    // The message has to be actionable, not just a rejection.
    expect(res.body.message).toContain('corikara@hotmail.com');
  });

  it('refuses to confirm a booking for a domain with no mail server', async () => {
    mockCheck.mockResolvedValue('undeliverable');
    const res = mockRes();
    await handler(
      mockReq({ method: 'POST', body: { ...validBody, email: 'corikara@hotmail.co' } }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(res.body.status).toBe('email_undeliverable');
  });

  it('lets the booking through when DNS is unreachable — never lose a sale to flaky DNS', async () => {
    mockCheck.mockResolvedValue('unknown');
    const res = mockRes();
    await handler(
      mockReq({
        method: 'POST',
        body: {
          intent: 'payment_setup',
          name: 'Sam',
          email: 'sam@example.com',
          postal_code: 'T8L 1A1',
        },
      }),
      res,
    );
    expect(res.statusCode).not.toBe(422);
  });

  it('checks the address BEFORE creating a Stripe customer', async () => {
    // Ordering matters: a rejected booking must not leave an orphan Stripe
    // customer behind for an address we know bounces.
    mockCheck.mockResolvedValue('undeliverable');
    const billing = await import('../../lib/billing.js');
    const spy = vi.spyOn(billing, 'createBookingSetupIntent');
    const res = mockRes();
    await handler(
      mockReq({
        method: 'POST',
        body: {
          intent: 'payment_setup',
          name: 'Corinne',
          email: 'corikara@hotmail.co',
          postal_code: 'T8L 1A1',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not check out-of-area addresses at all — no point spending a DNS lookup', async () => {
    mockCheck.mockResolvedValue('undeliverable');
    const res = mockRes();
    await handler(
      mockReq({
        method: 'POST',
        body: {
          intent: 'payment_setup',
          name: 'Far Away',
          email: 'far@hotmail.co',
          postal_code: 'M5V 3A8',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(res.body.status).toBe('out_of_area');
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
