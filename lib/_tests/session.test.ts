import { describe, it, expect, beforeAll } from 'vitest';
import { getSessionCustomerId } from '../session.js';
import { signSessionCookie, SESSION_COOKIE_NAME } from '../cookies.js';

const TEST_SECRET = 'a'.repeat(64);

beforeAll(() => {
  process.env.SESSION_SECRET = TEST_SECRET;
});

function mockReq(cookieHeader: string | undefined): any {
  return { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } };
}

describe('getSessionCustomerId', () => {
  it('returns the customer id when the cookie holds a valid session JWT', async () => {
    const token = await signSessionCookie('cust-abc');
    const id = await getSessionCustomerId(mockReq(`${SESSION_COOKIE_NAME}=${token}`));
    expect(id).toBe('cust-abc');
  });

  it('returns null when no Cookie header is sent', async () => {
    expect(await getSessionCustomerId(mockReq(undefined))).toBeNull();
  });

  it('returns null when the session cookie is absent among other cookies', async () => {
    expect(await getSessionCustomerId(mockReq('other=1; foo=bar'))).toBeNull();
  });

  it('returns null when the session cookie value is a malformed JWT', async () => {
    expect(await getSessionCustomerId(mockReq(`${SESSION_COOKIE_NAME}=not-a-jwt`))).toBeNull();
  });

  it('returns null when the session cookie value is empty', async () => {
    expect(await getSessionCustomerId(mockReq(`${SESSION_COOKIE_NAME}=`))).toBeNull();
  });

  it('handles multi-cookie headers with surrounding whitespace', async () => {
    const token = await signSessionCookie('cust-xyz');
    const id = await getSessionCustomerId(mockReq(`foo=bar; ${SESSION_COOKIE_NAME}=${token}; baz=qux`));
    expect(id).toBe('cust-xyz');
  });
});
