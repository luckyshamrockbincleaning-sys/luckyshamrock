import { JWT } from 'google-auth-library';

export interface SendGmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
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

    const raw = buildRfc822Message({ from: sendAs, ...input });
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

function buildRfc822Message(p: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `boundary_${crypto.randomUUID()}`;
  return [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${encodeSubject(p.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    p.text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    p.html,
    ``,
    `--${boundary}--`,
  ].join('\r\n');
}

function encodeSubject(subject: string): string {
  // RFC 2047 encoded-word for non-ASCII safety. For ASCII this is a no-op.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
}
