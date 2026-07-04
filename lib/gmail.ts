import { JWT } from 'google-auth-library';

export interface SendGmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  /**
   * Render inside the HTML body (via <img src="cid:contentId">) instead of as
   * a downloadable attachment. Requires contentId; without one the attachment
   * silently falls back to regular (there'd be nothing referencing it).
   */
  inline?: boolean;
  contentId?: string;
}

export interface SendGmailResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isGmailConfigured(): boolean {
  return typeof process.env.GMAIL_SERVICE_ACCOUNT_JSON === 'string' && process.env.GMAIL_SERVICE_ACCOUNT_JSON.length > 0;
}

export async function sendViaGmail(input: SendGmailInput): Promise<SendGmailResult> {
  if (!SIMPLE_EMAIL_RE.test(input.to)) {
    return { ok: false, error: `invalid recipient: ${input.to}` };
  }

  if (!isGmailConfigured()) {
    // Dev/test fallback: log and return synthetic message id
    console.log('[email:stub]', {
      to: input.to,
      subject: input.subject,
      bodyPreview: input.text.slice(0, 80),
    });
    return { ok: true, gmailMessageId: `stub-${crypto.randomUUID()}` };
  }

  const sendAs = process.env.GMAIL_SEND_AS;
  if (!sendAs) {
    return { ok: false, error: 'GMAIL_SEND_AS is not set' };
  }

  let creds: { client_email: string; private_key: string };
  try {
    creds = JSON.parse(process.env.GMAIL_SERVICE_ACCOUNT_JSON!);
    if (!creds.client_email || !creds.private_key) {
      return { ok: false, error: 'GMAIL_SERVICE_ACCOUNT_JSON missing client_email or private_key' };
    }
  } catch (err) {
    return { ok: false, error: `GMAIL_SERVICE_ACCOUNT_JSON is not valid JSON: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  try {
    const auth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: sendAs,
    });
    const tokenResponse = await auth.getAccessToken();
    const accessToken = tokenResponse.token;
    if (!accessToken) {
      return { ok: false, error: 'no access token returned by Google' };
    }

    // Display name matters: customers should see "Lucky Shamrock", not the
    // bare mailbox address, in their inbox sender column.
    const raw = buildRfc822Message({ from: `"Lucky Shamrock" <${sendAs}>`, ...input });
    const encoded = Buffer.from(raw, 'utf-8').toString('base64url');

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sendAs)}/messages/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `gmail API ${resp.status}: ${body.slice(0, 200)}` };
    }

    const data = (await resp.json()) as { id?: string };
    return { ok: true, gmailMessageId: data.id ?? undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown gmail error' };
  }
}

export function buildRfc822Message(p: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}): string {
  const all = p.attachments ?? [];
  // Inline images need a Content-ID the HTML can reference; without one they
  // degrade to regular attachments rather than becoming orphaned parts.
  const inline = all.filter((a) => a.inline && a.contentId);
  const regular = all.filter((a) => !(a.inline && a.contentId));

  const headers = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${encodeSubject(p.subject)}`,
    `MIME-Version: 1.0`,
  ];

  // Innermost: text + html alternatives.
  const altBoundary = `alt_${crypto.randomUUID()}`;
  let body = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    ``,
    `--${altBoundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    p.text,
    ``,
    `--${altBoundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    p.html,
    ``,
    `--${altBoundary}--`,
  ];

  // Wrap in multipart/related when there are inline images (RFC 2387: the
  // alternative part comes first, then the parts its HTML references by cid).
  if (inline.length) {
    const relBoundary = `rel_${crypto.randomUUID()}`;
    const rel = [
      `Content-Type: multipart/related; boundary="${relBoundary}"`,
      ``,
      `--${relBoundary}`,
      ...body,
    ];
    for (const a of inline) {
      rel.push(
        ``,
        `--${relBoundary}`,
        `Content-Type: ${a.contentType}`,
        `Content-Transfer-Encoding: base64`,
        `Content-ID: <${a.contentId}>`,
        `Content-Disposition: inline; filename="${escapeFilename(a.filename)}"`,
        ``,
        wrapBase64(a.contentBase64),
      );
    }
    rel.push(``, `--${relBoundary}--`);
    body = rel;
  }

  // Wrap in multipart/mixed when there are regular (downloadable) attachments.
  if (regular.length) {
    const mixedBoundary = `mixed_${crypto.randomUUID()}`;
    const mixed = [
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      ``,
      `--${mixedBoundary}`,
      ...body,
    ];
    for (const a of regular) {
      mixed.push(
        ``,
        `--${mixedBoundary}`,
        `Content-Type: ${a.contentType}`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${escapeFilename(a.filename)}"`,
        ``,
        wrapBase64(a.contentBase64),
      );
    }
    mixed.push(``, `--${mixedBoundary}--`);
    body = mixed;
  }

  return [...headers, ...body].join('\r\n');
}

function encodeSubject(subject: string): string {
  // RFC 2047 encoded-word for non-ASCII safety. For ASCII this is a no-op.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}

function escapeFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_');
}

function wrapBase64(contentBase64: string): string {
  return contentBase64.replace(/(.{1,76})/g, '$1\r\n').trimEnd();
}
