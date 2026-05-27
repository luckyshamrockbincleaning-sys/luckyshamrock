/**
 * Email sender entrypoint. Delegates to lib/gmail.ts (real OAuth + Gmail
 * REST when GMAIL_SERVICE_ACCOUNT_JSON is set, otherwise a console-log
 * stub). Signature and result shape are stable across Phase 1 and Phase 2.
 */

import { sendViaGmail, type SendGmailResult } from './gmail.js';

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
  /** Plain-text body. */
  body: string;
  /** Optional HTML body. If absent, body is wrapped in <pre>. */
  html?: string;
}

export interface SendEmailResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const html = input.html ?? `<pre>${escapeHtml(input.body)}</pre>`;
  const result: SendGmailResult = await sendViaGmail({
    to: input.to,
    subject: input.subject,
    text: input.body,
    html,
  });
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
