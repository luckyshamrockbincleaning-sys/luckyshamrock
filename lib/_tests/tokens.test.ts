import { describe, it, expect } from 'vitest';
import { generateMagicLinkToken, hashToken } from '../tokens.js';

describe('generateMagicLinkToken', () => {
  it('returns a 43-char URL-safe base64 string (32 bytes encoded)', () => {
    const token = generateMagicLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns a different value on every call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateMagicLinkToken()));
    expect(tokens.size).toBe(100);
  });
});

describe('hashToken', () => {
  it('returns a 64-char lowercase hex SHA-256 hash', () => {
    const hash = hashToken('any-input');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashToken('same')).toBe(hashToken('same'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});
