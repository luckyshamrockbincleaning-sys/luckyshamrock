import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import {
  signOperatorCookie,
  verifyOperatorCookie,
  formatOperatorCookieHeader,
  formatClearOperatorCookieHeader,
  getOperatorSession,
  verifyOperatorPassword,
  operatorTodayISO,
  OPERATOR_COOKIE_NAME,
} from '../operator.js';

beforeAll(() => {
  process.env.OPERATOR_SECRET = 'o'.repeat(48);
  process.env.OPERATOR_PASSWORD = 'lucky-route-2026';
});

// Tests that change OPERATOR_* use vi.stubEnv so vitest restores them through
// its own lifecycle. Raw `delete process.env.X` interacts badly with vitest's
// per-file module isolation when sibling files import the same module.
afterEach(() => {
  vi.unstubAllEnvs();
});

function makeReq(cookie?: string): VercelRequest {
  return { headers: cookie ? { cookie } : {} } as unknown as VercelRequest;
}

describe('operator cookies', () => {
  it('signs and verifies an operator cookie round-trip', async () => {
    const token = await signOperatorCookie();
    expect(await verifyOperatorCookie(token)).toBe(true);
  });

  it('returns false for a tampered or garbage token', async () => {
    const token = await signOperatorCookie();
    expect(await verifyOperatorCookie(token.slice(0, -3) + 'xxx')).toBe(false);
    expect(await verifyOperatorCookie('')).toBe(false);
    expect(await verifyOperatorCookie('not.a.jwt')).toBe(false);
  });

  it('rejects a cookie signed with a different secret', async () => {
    const token = await signOperatorCookie();
    vi.stubEnv('OPERATOR_SECRET', 'different-secret-value-different');
    expect(await verifyOperatorCookie(token)).toBe(false);
  });

  it('throws when OPERATOR_SECRET is unset', async () => {
    vi.stubEnv('OPERATOR_SECRET', undefined);
    await expect(signOperatorCookie()).rejects.toThrow(/OPERATOR_SECRET/);
  });

  it('formats Set-Cookie headers with security flags', () => {
    const header = formatOperatorCookieHeader('tok');
    expect(header).toContain(`${OPERATOR_COOKIE_NAME}=tok`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=');

    const clear = formatClearOperatorCookieHeader();
    expect(clear).toContain(`${OPERATOR_COOKIE_NAME}=;`);
    expect(clear).toContain('Max-Age=0');
  });
});

describe('verifyOperatorPassword', () => {
  it('accepts the correct password', () => {
    expect(verifyOperatorPassword('lucky-route-2026')).toBe(true);
  });

  it('rejects a wrong password (same and different length)', () => {
    expect(verifyOperatorPassword('lucky-route-2027')).toBe(false); // same length
    expect(verifyOperatorPassword('nope')).toBe(false); // different length
    expect(verifyOperatorPassword('')).toBe(false);
  });

  it('returns false when OPERATOR_PASSWORD is unset', () => {
    vi.stubEnv('OPERATOR_PASSWORD', undefined);
    expect(verifyOperatorPassword('anything')).toBe(false);
  });
});

describe('getOperatorSession', () => {
  it('returns true for a valid operator cookie', async () => {
    const token = await signOperatorCookie();
    expect(await getOperatorSession(makeReq(`${OPERATOR_COOKIE_NAME}=${token}`))).toBe(true);
  });

  it('returns false with no cookie header or unrelated cookies', async () => {
    expect(await getOperatorSession(makeReq())).toBe(false);
    expect(await getOperatorSession(makeReq('other=value'))).toBe(false);
  });

  it('reads the operator cookie among multiple cookies', async () => {
    const token = await signOperatorCookie();
    const req = makeReq(`foo=bar; ${OPERATOR_COOKIE_NAME}=${token}; baz=qux`);
    expect(await getOperatorSession(req)).toBe(true);
  });

  it('does not treat a customer session cookie as operator auth', async () => {
    const token = await signOperatorCookie();
    // ls_session (customer) must NOT grant operator access.
    expect(await getOperatorSession(makeReq(`ls_session=${token}`))).toBe(false);
  });
});

describe('operatorTodayISO', () => {
  it('returns an Edmonton calendar day as YYYY-MM-DD', () => {
    expect(operatorTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
