import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRfc822Message, sendViaGmail, isGmailConfigured } from '../gmail.js';

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
  const prevJson = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
  const prevSendAs = process.env.GMAIL_SEND_AS;

  beforeEach(() => {
    process.env.GMAIL_SERVICE_ACCOUNT_JSON = '{"client_email":"x@y.iam","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----"}';
    process.env.GMAIL_SEND_AS = 'hello@luckyshamrock.ca';
  });
  afterEach(() => {
    if (prevJson === undefined) delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
    else process.env.GMAIL_SERVICE_ACCOUNT_JSON = prevJson;
    if (prevSendAs === undefined) delete process.env.GMAIL_SEND_AS;
    else process.env.GMAIL_SEND_AS = prevSendAs;
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

describe('buildRfc822Message', () => {
  it('builds a multipart/mixed email with html/text alternatives and an attachment', () => {
    const raw = buildRfc822Message({
      from: 'hello@luckyshamrock.ca',
      to: 'sam@example.com',
      subject: 'Your garbage bin is clean',
      text: 'Cleaned. Photo proof attached.',
      html: '<p>Cleaned. Photo proof attached.</p>',
      attachments: [
        {
          filename: 'clean-bin.jpg',
          contentType: 'image/jpeg',
          contentBase64: Buffer.from('fake-image').toString('base64'),
        },
      ],
    });

    expect(raw).toContain('Content-Type: multipart/mixed;');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    expect(raw).toContain('Content-Type: image/jpeg');
    expect(raw).toContain('Content-Disposition: attachment; filename="clean-bin.jpg"');
    expect(raw).toContain(Buffer.from('fake-image').toString('base64'));
  });

  it('builds multipart/related with Content-ID + inline disposition for inline images', () => {
    const raw = buildRfc822Message({
      from: 'shea@luckyshamrock.ca',
      to: 'sam@example.com',
      subject: 'Your garbage bin is clean',
      text: 'Before-and-after photos are attached.',
      html: '<img src="cid:before-photo"><img src="cid:after-photo">',
      attachments: [
        {
          filename: 'before-bin.jpg',
          contentType: 'image/jpeg',
          contentBase64: Buffer.from('before-image').toString('base64'),
          inline: true,
          contentId: 'before-photo',
        },
        {
          filename: 'clean-bin.jpg',
          contentType: 'image/jpeg',
          contentBase64: Buffer.from('after-image').toString('base64'),
          inline: true,
          contentId: 'after-photo',
        },
      ],
    });

    expect(raw).toContain('Content-Type: multipart/related;');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    expect(raw).toContain('Content-ID: <before-photo>');
    expect(raw).toContain('Content-ID: <after-photo>');
    expect(raw).toContain('Content-Disposition: inline; filename="before-bin.jpg"');
    expect(raw).toContain('Content-Disposition: inline; filename="clean-bin.jpg"');
    // Inline-only messages don't need a mixed wrapper.
    expect(raw).not.toContain('Content-Type: multipart/mixed;');
    expect(raw).toContain(Buffer.from('before-image').toString('base64'));
    expect(raw).toContain(Buffer.from('after-image').toString('base64'));
  });

  it('nests related inside mixed when inline and regular attachments coexist', () => {
    const raw = buildRfc822Message({
      from: 'shea@luckyshamrock.ca',
      to: 'sam@example.com',
      subject: 'Hi',
      text: 'x',
      html: '<img src="cid:after-photo">',
      attachments: [
        {
          filename: 'clean-bin.jpg',
          contentType: 'image/jpeg',
          contentBase64: Buffer.from('after-image').toString('base64'),
          inline: true,
          contentId: 'after-photo',
        },
        {
          filename: 'receipt.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('fake-pdf').toString('base64'),
        },
      ],
    });

    expect(raw).toContain('Content-Type: multipart/mixed;');
    expect(raw).toContain('Content-Type: multipart/related;');
    expect(raw).toContain('Content-ID: <after-photo>');
    expect(raw).toContain('Content-Disposition: inline; filename="clean-bin.jpg"');
    expect(raw).toContain('Content-Disposition: attachment; filename="receipt.pdf"');
    // The mixed wrapper must open before the related part.
    expect(raw.indexOf('multipart/mixed')).toBeLessThan(raw.indexOf('multipart/related'));
  });

  it('treats an inline attachment without a contentId as a regular attachment', () => {
    const raw = buildRfc822Message({
      from: 'shea@luckyshamrock.ca',
      to: 'sam@example.com',
      subject: 'Hi',
      text: 'x',
      html: '<p>x</p>',
      attachments: [
        {
          filename: 'clean-bin.jpg',
          contentType: 'image/jpeg',
          contentBase64: Buffer.from('after-image').toString('base64'),
          inline: true,
        },
      ],
    });

    expect(raw).toContain('Content-Type: multipart/mixed;');
    expect(raw).not.toContain('multipart/related');
    expect(raw).toContain('Content-Disposition: attachment; filename="clean-bin.jpg"');
  });

  it('keeps a display-name From header intact ("Lucky Shamrock <addr>")', () => {
    // sendViaGmail sends with a display name so customers see "Lucky Shamrock"
    // in their inbox, not the bare mailbox address.
    const raw = buildRfc822Message({
      from: '"Lucky Shamrock" <sheasommerfeld@luckyshamrock.ca>',
      to: 'sam@example.com',
      subject: 'Hi',
      text: 'x',
      html: '<p>x</p>',
    });
    expect(raw).toContain('From: "Lucky Shamrock" <sheasommerfeld@luckyshamrock.ca>');
  });
});
