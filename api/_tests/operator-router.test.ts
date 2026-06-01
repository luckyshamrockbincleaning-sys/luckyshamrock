import { describe, it, expect, beforeAll } from 'vitest';
import handler from '../operator/[action].js';

// The single-segment operator router. These assert ROUTING only — each route is
// proven by a status code only the correct handler produces, without DB rows.
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

// query.action form (test-friendly fallback path in resolveAction).
function qReq(action: string, method: string, extra: Record<string, unknown> = {}): any {
  return { method, headers: {}, query: { action }, ...extra };
}

// req.url form — how Vercel actually invokes the function (query.action empty).
function urlReq(url: string, method: string, extra: Record<string, unknown> = {}): any {
  return { method, headers: {}, query: {}, url, ...extra };
}

describe('operator single-segment router', () => {
  it('routes /login (400 on missing password)', async () => {
    const res = mockRes();
    await handler(qReq('login', 'POST', { body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('routes /today (401 without operator cookie)', async () => {
    const res = mockRes();
    await handler(qReq('today', 'GET'), res);
    expect(res.statusCode).toBe(401);
  });

  it('routes /upcoming (401 without operator cookie)', async () => {
    const res = mockRes();
    await handler(qReq('upcoming', 'GET'), res);
    expect(res.statusCode).toBe(401);
  });

  it('routes /act (401 without operator cookie, before body validation)', async () => {
    const res = mockRes();
    await handler(qReq('act', 'POST', { body: { id: 'x', op: 'notify' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('404s an unknown action', async () => {
    const res = mockRes();
    await handler(qReq('bogus', 'GET'), res);
    expect(res.statusCode).toBe(404);
  });

  it('404s when no action can be resolved', async () => {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: {} } as any, res);
    expect(res.statusCode).toBe(404);
  });

  // The prod path: resolve the action from req.url with query.action absent.
  it('routes by req.url for /today (→ 401)', async () => {
    const res = mockRes();
    await handler(urlReq('/api/operator/today', 'GET'), res);
    expect(res.statusCode).toBe(401);
  });

  it('routes by req.url for /act with a query string (→ 401 no cookie)', async () => {
    const res = mockRes();
    await handler(urlReq('/api/operator/act?foo=bar', 'POST', { body: { id: 'x', op: 'done' } }), res);
    expect(res.statusCode).toBe(401);
  });
});
