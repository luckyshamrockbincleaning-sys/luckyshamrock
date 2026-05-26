import { describe, it, expect, beforeAll } from 'vitest';
import handler from '../health.js';
import { mockReq, mockRes } from './_helpers.js';

describe('GET /api/health', () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set (run `vercel env pull .env.local`)');
    }
  });

  it('returns 200 with status=ok and db=true when DB is reachable', async () => {
    const req = mockReq<typeof handler>({ method: 'GET' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; db: boolean; time: string; error: string | null };
    expect(body.status).toBe('ok');
    expect(body.db).toBe(true);
    expect(typeof body.time).toBe('string');
    expect(body.error).toBe(null);
  });

  it('returns 405 for non-GET methods', async () => {
    const req = mockReq<typeof handler>({ method: 'POST' });
    const res = mockRes<typeof handler>();
    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });
});
