import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, type EmailKind } from '../email.js';

describe('sendEmail (stubbed for Phase 1)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns ok=true and a synthetic gmail_message_id', async () => {
    const result = await sendEmail({
      kind: 'booking_confirmed',
      to: 'sam@example.com',
      subject: 'You are booked',
      body: 'See you Thursday.',
    });
    expect(result.ok).toBe(true);
    expect(result.gmailMessageId).toMatch(/^stub-[a-f0-9-]{36}$/);
    expect(result.error).toBeUndefined();
  });

  it('logs the email payload via console.log so AB can see what would have shipped', async () => {
    await sendEmail({
      kind: 'magic_link',
      to: 'sam@example.com',
      subject: 'Manage your booking',
      body: 'Click here: https://...',
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = logSpy.mock.calls[0]!;
    expect(tag).toBe('[email:stub]');
    expect(payload).toMatchObject({
      to: 'sam@example.com',
      subject: 'Manage your booking',
    });
  });

  it('rejects an obviously malformed recipient address', async () => {
    const result = await sendEmail({
      kind: 'booking_confirmed',
      to: 'not-an-email',
      subject: '',
      body: '',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid recipient/i);
    expect(result.gmailMessageId).toBeUndefined();
  });

  it('accepts all five EmailKind values without throwing', async () => {
    const kinds: EmailKind[] = ['magic_link', 'booking_confirmed', 'on_our_way', 'done', 'day_before'];
    for (const kind of kinds) {
      const result = await sendEmail({
        kind,
        to: 'sam@example.com',
        subject: 's',
        body: 'b',
      });
      expect(result.ok).toBe(true);
    }
  });
});
