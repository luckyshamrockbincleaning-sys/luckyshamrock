import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the db client BEFORE importing the handler.
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockWhere = vi.fn();
const mockValues = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    select: () => ({ from: mockFrom }),
    insert: () => ({ values: mockValues }),
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

describe('POST /api/book — failure modes', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockWhere.mockReset();
    mockValues.mockClear();
  });

  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns 400 with field errors when body is invalid', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, email: 'not-an-email', bin_count: 99 },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    const body = res.body as { status: string; errors: Record<string, string[]> };
    expect(body.status).toBe('invalid');
    expect(body.errors).toHaveProperty('email');
    expect(body.errors).toHaveProperty('bin_count');
  });

  it('returns 422 when postal code is outside service area', async () => {
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody, postal_code: 'K1A 0B1' }, // Ottawa
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(422);
    const body = res.body as { status: string; message: string };
    expect(body.status).toBe('out_of_area');
    expect(body.message).toMatch(/serve your area/i);
  });

  it('returns 409 when email already has an active subscription', async () => {
    // First lookup: existing customer
    mockWhere.mockResolvedValueOnce([
      { id: 'existing-cust-id', email: 'sam@example.com' },
    ]);
    // Second lookup: active sub
    mockWhere.mockResolvedValueOnce([{ id: 'sub-id', status: 'active' }]);

    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    const body = res.body as { status: string; message: string };
    expect(body.status).toBe('already_subscribed');
  });

  it('returns 500 when the DB throws unexpectedly', async () => {
    mockWhere.mockRejectedValueOnce(new Error('connection lost'));
    const req = mockReq<typeof handler>({
      method: 'POST',
      body: { ...validBody },
    });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const body = res.body as { status: string; message: string };
    expect(body.status).toBe('error');
    expect(body.message).toBe('connection lost');
  });
});
