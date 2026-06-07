import { describe, it, expect, beforeAll } from 'vitest';
import {
  signSessionCookie,
  verifySessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from '../cookies.js';

const TEST_SECRET = 'a'.repeat(64);

beforeAll(() => {
  process.env.SESSION_SECRET = TEST_SECRET;
});

describe('SESSION_COOKIE_NAME', () => {
  it('is "ls_session"', () => {
    expect(SESSION_COOKIE_NAME).toBe('ls_session');
  });
});

describe('SESSION_TTL_SECONDS', () => {
  it('is 30 days in seconds', () => {
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe('signSessionCookie + verifySessionCookie', () => {
  it('round-trips a customer id', async () => {
    const token = await signSessionCookie('cust-123');
    const payload = await verifySessionCookie(token);
    expect(payload?.customerId).toBe('cust-123');
  });

  it('returns null for a tampered token', async () => {
    const token = await signSessionCookie('cust-123');
    const parts = token.split('.');
    parts[2] = (parts[2]!.startsWith('a') ? 'b' : 'a') + parts[2]!.slice(1);
    const tampered = parts.join('.');
    expect(await verifySessionCookie(tampered)).toBeNull();
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await signSessionCookie('cust-123');
    process.env.SESSION_SECRET = 'b'.repeat(64);
    expect(await verifySessionCookie(token)).toBeNull();
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  it('returns null for garbage input', async () => {
    expect(await verifySessionCookie('not-a-jwt')).toBeNull();
    expect(await verifySessionCookie('')).toBeNull();
  });

  it('throws if SESSION_SECRET is unset when signing', async () => {
    const prev = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    await expect(signSessionCookie('cust-123')).rejects.toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = prev;
  });
});
