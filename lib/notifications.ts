import { and, eq } from 'drizzle-orm';
import { sendEmail, type EmailKind } from './email.js';
import { getDb } from '../db/client.js';
import { notificationLog } from '../db/schema.js';

export interface SendAndLogInput {
  kind: EmailKind;
  to: string;
  subject: string;
  body: string;
  html?: string;
  customerId: string;
  /** Null for non-visit-bound emails (magic_link). */
  visitId: string | null;
}

export interface SendAndLogResult {
  ok: boolean;
  gmailMessageId?: string;
  error?: string;
  /** True if the send was skipped due to an existing log row. */
  skipped?: boolean;
}

/**
 * Wraps sendEmail with notification_log idempotency + record-keeping.
 *
 * For visit-bound emails (visitId is not null), checks for a prior
 * notification_log row with the same (visitId, kind). If found, skips
 * the send and returns { ok: true, skipped: true }.
 *
 * Magic-link emails have visitId=null; the unique constraint allows
 * many rows per customer, so we always send.
 */
export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogResult> {
  const db = getDb();

  if (input.visitId !== null) {
    const prior = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.visitId, input.visitId), eq(notificationLog.kind, input.kind)));
    if (prior.length > 0) {
      return { ok: true, skipped: true };
    }
  }

  const sendResult = await sendEmail({
    kind: input.kind,
    to: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html,
  });

  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    customerId: input.customerId,
    visitId: input.visitId,
    kind: input.kind,
    gmailMessageId: sendResult.gmailMessageId,
  };
  if (sendResult.ok) {
    row.sentAt = new Date();
  } else {
    row.failedAt = new Date();
    row.error = sendResult.error;
  }

  await db.insert(notificationLog).values(row as any);

  return {
    ok: sendResult.ok,
    gmailMessageId: sendResult.gmailMessageId,
    error: sendResult.error,
  };
}
