import { describe, it, expect, beforeAll } from 'vitest';
import handler from '../operator/[...path].js';

// The catch-all dispatcher. These assert ROUTING only — each route is proven by
// a status code only the correct handler produces, without needing DB rows.
beforeAll(() => {
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return res;
}

function req(path: string[], method: string, extra: Record<string, unknown> = {}): any {
  return { method, headers: {}, query: { path }, ...extra };
}

describe('operator catch-all router', () => {
  it('routes /login to the login handler (400 on missing password)', async () => {
    const res = mockRes();
    await handler(req(['login'], 'POST', { body: {} }), res);
    expect(res.statusCode).toBe(400); // handleLogin validation, proves routing
  });

  it('routes /today to the today handler (401 without operator cookie)', async () => {
    const res = mockRes();
    await handler(req(['today'], 'GET'), res);
    expect(res.statusCode).toBe(401);
  });

  it('routes /upcoming to the upcoming handler (401 without operator cookie)', async () => {
    const res = mockRes();
    await handler(req(['upcoming'], 'GET'), res);
    expect(res.statusCode).toBe(401);
  });

  it('routes /visit/:id/notify to the notify handler (401 without operator cookie)', async () => {
    const res = mockRes();
    await handler(req(['visit', 'some-id', 'notify'], 'POST'), res);
    expect(res.statusCode).toBe(401);
  });

  it('404s an unknown single-segment path', async () => {
    const res = mockRes();
    await handler(req(['bogus'], 'GET'), res);
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown visit action', async () => {
    const res = mockRes();
    await handler(req(['visit', 'some-id', 'teleport'], 'POST'), res);
    expect(res.statusCode).toBe(404);
  });

  it('404s a malformed visit path (missing action)', async () => {
    const res = mockRes();
    await handler(req(['visit', 'some-id'], 'POST'), res);
    expect(res.statusCode).toBe(404);
  });
});
