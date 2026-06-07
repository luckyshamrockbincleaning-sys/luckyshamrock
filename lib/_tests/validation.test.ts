import { describe, it, expect } from 'vitest';
import { bookRequestSchema, waitlistRequestSchema } from '../validation.js';

describe('bookRequestSchema', () => {
  const valid = {
    name: 'Sam Customer',
    email: 'sam@example.com',
    phone: '780-555-0100',
    street: '123 Main St',
    city: 'Fort Saskatchewan',
    postal_code: 'T8L 1A1',
    pickup_day: 'wednesday',
    bin_count: 2,
    plan: 'monthly',
  };

  it('accepts a complete, valid recurring booking', () => {
    const result = bookRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts a one-off booking with oneoff_date', () => {
    const result = bookRequestSchema.safeParse({
      ...valid,
      plan: 'oneoff',
      oneoff_date: '2099-07-15',
    });
    expect(result.success).toBe(true);
  });

  it('rejects one-off dates that are invalid, past, or Sunday', () => {
    expect(
      bookRequestSchema.safeParse({ ...valid, plan: 'oneoff', oneoff_date: '2026-13-45' }).success,
    ).toBe(false);
    expect(
      bookRequestSchema.safeParse({ ...valid, plan: 'oneoff', oneoff_date: '2000-01-01' }).success,
    ).toBe(false);
    expect(
      bookRequestSchema.safeParse({ ...valid, plan: 'oneoff', oneoff_date: '2099-07-19' }).success,
    ).toBe(false);
  });

  it('rejects one-off booking without oneoff_date', () => {
    const result = bookRequestSchema.safeParse({ ...valid, plan: 'oneoff' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('oneoff_date'));
      expect(issue).toBeDefined();
    }
  });

  it('rejects recurring booking that includes oneoff_date', () => {
    const result = bookRequestSchema.safeParse({
      ...valid,
      plan: 'monthly',
      oneoff_date: '2099-07-15',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed email', () => {
    expect(bookRequestSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects bin_count outside 1-3', () => {
    expect(bookRequestSchema.safeParse({ ...valid, bin_count: 0 }).success).toBe(false);
    expect(bookRequestSchema.safeParse({ ...valid, bin_count: 4 }).success).toBe(false);
  });

  it('rejects invalid pickup_day', () => {
    expect(bookRequestSchema.safeParse({ ...valid, pickup_day: 'saturday' }).success).toBe(false);
  });

  it('rejects invalid plan', () => {
    expect(bookRequestSchema.safeParse({ ...valid, plan: 'weekly' }).success).toBe(false);
  });

  it('allows omitting phone', () => {
    const { phone: _, ...withoutPhone } = valid;
    expect(bookRequestSchema.safeParse(withoutPhone).success).toBe(true);
  });

  it('trims and lowercases email', () => {
    const result = bookRequestSchema.safeParse({ ...valid, email: '  SAM@Example.com  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('sam@example.com');
    }
  });
});

describe('waitlistRequestSchema', () => {
  it('accepts a valid email + postal code pair', () => {
    expect(
      waitlistRequestSchema.safeParse({ email: 'sam@example.com', postal_code: 'T5J 1A1' }).success,
    ).toBe(true);
  });

  it('rejects a missing email', () => {
    expect(waitlistRequestSchema.safeParse({ postal_code: 'T5J 1A1' }).success).toBe(false);
  });

  it('rejects a missing postal code', () => {
    expect(waitlistRequestSchema.safeParse({ email: 'sam@example.com' }).success).toBe(false);
  });

  it('lowercases email', () => {
    const result = waitlistRequestSchema.safeParse({ email: 'SAM@example.com', postal_code: 'T5J' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('sam@example.com');
  });
});
