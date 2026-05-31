import { describe, it, expect, beforeAll } from 'vitest';
import handler from '../operator/login.js';
import { verifyOperatorCookie, OPERATOR_COOKIE_NAME } from '../../lib/operator.js';

beforeAll(() => {
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res;
}

function req(body: unknown, method = 'POST'): any {
  return { method, headers: {}, query: {}, body };
}

describe('POST /api/operator/login', () => {
  it('returns 405 for non-POST', async () => {
    const res = mockRes();
    await handler(req({}, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(req({}), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for a wrong password', async () => {
    const res = mockRes();
    await handler(req({ password: 'wrong-password' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.status).toBe('invalid_password');
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('returns 200 and sets a valid operator cookie for the correct password', async () => {
    const res = mockRes();
    await handler(req({ password: 'lucky-route-2026' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');

    const cookie = res.headers['Set-Cookie'] as string;
    expect(cookie).toContain(`${OPERATOR_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');

    const token = cookie.split(';')[0]!.split('=').slice(1).join('=');
    expect(await verifyOperatorCookie(token)).toBe(true);
  });
});
