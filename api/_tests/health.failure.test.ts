import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the db client BEFORE importing the handler so the handler picks up the mock.
const mockSql = vi.fn();
vi.mock('../../db/client.js', () => ({
  getRawClient: () => mockSql,
}));

const { default: handler } = await import('../health.js');

type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (payload: unknown) => MockRes;
};

function mockReq(method = 'GET') {
  return { method } as unknown as Parameters<typeof handler>[0];
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

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
    mockSql.mockResolvedValueOnce([{ ok: 0 }]); // not 1, so dbOk === false
    const req = mockReq('GET');
    const res = mockRes();
    await handler(req, res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(503);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
    expect(body.error).toBe(null);
  });

  it('returns 503 with db=false and an error message when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const req = mockReq('GET');
    const res = mockRes();
    await handler(req, res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(503);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe(false);
    expect(body.error).toBe('connection refused');
  });
});
