import { describe, it, expect } from 'vitest';
import handler from '../logout.js';
import { mockReq } from './_helpers.js';
import { SESSION_COOKIE_NAME } from '../../lib/cookies.js';

function mockResWithHeaders() {
  const headers: Record<string, string | string[]> = {};
  const res: any = {
    statusCode: 200,
    headers,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string | string[]) { headers[name] = value; return this; },
  };
  return res;
}

describe('POST /api/logout', () => {
  it('returns 200 ok and sets a Max-Age=0 cookie that clears ls_session', async () => {
    const res = mockResWithHeaders();
    await handler(mockReq<typeof handler>({ method: 'POST' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    const cookie = res.headers['Set-Cookie'] as string;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('returns 405 for non-POST', async () => {
    const res = mockResWithHeaders();
    await handler(mockReq<typeof handler>({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });
});
