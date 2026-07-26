import { describe, it, expect } from 'vitest';
import { isPlaceholderEmail } from '../walkup-email.js';

describe('isPlaceholderEmail', () => {
  it('matches the minted walkup+<8hex>@luckyshamrock.ca placeholder', () => {
    expect(isPlaceholderEmail('walkup+a1b2c3d4@luckyshamrock.ca')).toBe(true);
    // Case-insensitive — hex digits and the domain can come back either case.
    expect(isPlaceholderEmail('WALKUP+A1B2C3D4@LuckyShamrock.CA')).toBe(true);
  });

  it('does not match a real customer email, even on our own domain', () => {
    expect(isPlaceholderEmail('pat@example.com')).toBe(false);
    expect(isPlaceholderEmail('hello@luckyshamrock.ca')).toBe(false);
    // Wrong hex length / shape must not slip through.
    expect(isPlaceholderEmail('walkup+a1b2c3@luckyshamrock.ca')).toBe(false);
    expect(isPlaceholderEmail('walkup+zzzzzzzz@luckyshamrock.ca')).toBe(false);
  });
});
