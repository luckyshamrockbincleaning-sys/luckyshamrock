import { describe, it, expect, beforeAll } from 'vitest';

// Import the handler (does not exist yet — test should FAIL with module not found).
import handler from '../health.js';

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

describe('GET /api/health', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set (run `vercel env pull .env.local`)');
    }
  });

  it('returns 200 with status=ok and db=true when DB is reachable', async () => {
    const req = mockReq('GET');
    const res = mockRes();
    await handler(req, res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('ok');
    expect(body.db).toBe(true);
    expect(typeof body.time).toBe('string');
    expect(body.error).toBe(null);
  });

  it('returns 405 for non-GET methods', async () => {
    const req = mockReq('POST');
    const res = mockRes();
    await handler(req, res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(405);
  });
});
