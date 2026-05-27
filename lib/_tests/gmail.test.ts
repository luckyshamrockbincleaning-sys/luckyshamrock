import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendViaGmail, isGmailConfigured } from '../gmail.js';

describe('isGmailConfigured', () => {
  it('is false when GMAIL_SERVICE_ACCOUNT_JSON is unset', () => {
    const prev = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    expect(isGmailConfigured()).toBe(false);
    if (prev !== undefined) process.env.GMAIL_SERVICE_ACCOUNT_JSON = prev;
  });

  it('is true when GMAIL_SERVICE_ACCOUNT_JSON is set', () => {
    const prev = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = '{}';
    expect(isGmailConfigured()).toBe(true);
    if (prev === undefined) delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    else process.env.GMAIL_SERVICE_ACCOUNT_JSON = prev;
  });
});

describe('sendViaGmail — stub branch (no GMAIL_SERVICE_ACCOUNT_JSON)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const prev = process.env.GMAIL_SERVICE_ACCOUNT_JSON;

  beforeEach(() => {
    delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (prev !== undefined) process.env.GMAIL_SERVICE_ACCOUNT_JSON = prev;
  });

  it('returns ok=true and a stub-<uuid> message id', async () => {
    const r = await sendViaGmail({ to: 'sam@example.com', subject: 's', text: 't', html: '<p>t</p>' });
    expect(r.ok).toBe(true);
    expect(r.gmailMessageId).toMatch(/^stub-[a-f0-9-]{36}$/);
  });

  it('logs the payload via [email:stub] tag', async () => {
    await sendViaGmail({ to: 'sam@example.com', subject: 'hi', text: 'body', html: '<b>body</b>' });
    expect(logSpy).toHaveBeenCalledWith('[email:stub]', expect.objectContaining({
      to: 'sam@example.com',
      subject: 'hi',
    }));
  });

  it('rejects malformed recipient even in stub mode', async () => {
    const r = await sendViaGmail({ to: 'not-an-email', subject: '', text: '', html: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid recipient/i);
  });
});

describe('sendViaGmail — real branch entry conditions', () => {
  beforeEach(() => {
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = '{"client_email":"x@y.iam","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----"}';
    process.env.GMAIL_SEND_AS = 'hello@luckyshamrock.ca';
  });

  it('errors clearly when GMAIL_SEND_AS is missing', async () => {
    delete process.env.GMAIL_SEND_AS;
    const r = await sendViaGmail({ to: 'sam@example.com', subject: 's', text: 't', html: 'h' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GMAIL_SEND_AS/);
  });

  it('errors clearly when service account JSON is unparseable', async () => {
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = 'not-json';
    const r = await sendViaGmail({ to: 'sam@example.com', subject: 's', text: 't', html: 'h' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GMAIL_SERVICE_ACCOUNT_JSON/);
  });
});
