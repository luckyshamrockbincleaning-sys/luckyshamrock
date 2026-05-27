/**
 * Email sender. STUBBED for Phase 1: writes the would-be email to console
 * and returns a synthetic gmail_message_id. Phase 2 swaps the body of
 * sendEmail() for a real Gmail API call without changing the signature.
 *
 * Callers should also write a notification_log row themselves; this module
 * only handles the send side and reports whether it succeeded.
 */

export type EmailKind =
  | 'magic_link'
  | 'booking_confirmed'
  | 'on_our_way'
  | 'done'
  | 'day_before';

export interface SendEmailInput {
  kind: EmailKind;
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { kind, to, subject, body } = input;

  if (!SIMPLE_EMAIL_RE.test(to)) {
    return { ok: false, error: `invalid recipient: ${to}` };
  }

  console.log('[email:stub]', { kind, to, subject, bodyPreview: body.slice(0, 80) });

  return {
    ok: true,
    gmailMessageId: `stub-${crypto.randomUUID()}`,
  };
}
