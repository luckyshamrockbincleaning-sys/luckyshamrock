import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../../db/client.js', () => ({
  getRawClient: () => mockSql,
}));

const { default: handler } = await import('../health.js');
const { mockReq, mockRes } = await import('./_helpers.js');

describe('GET /api/health — failure modes', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    mockSql.mockReset();
  });

  it('returns 503 with db=false and error=null when DB returns unexpected data', async () => {
    mockSql.mockResolvedValueOnce([{ ok: 0 }]);
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
    expect(body.error).toBe(null);
    expect(typeof body.time).toBe('string');
  });

  it('returns 503 with db=false and an error message when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
    expect(body.error).toBe('connection refused');
    expect(typeof body.time).toBe('string');
  });
});
