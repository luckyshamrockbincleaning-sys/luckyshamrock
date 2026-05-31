import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { customer, subscription, visit, magicLinkToken } from '../db/schema.js';
import { bookRequestSchema } from '../lib/validation.js';
import { isInServiceArea, normalizePostalCode } from '../lib/postal.js';
import { generateVisitDates, type Cadence } from '../lib/schedule.js';
import { sendAndLog } from '../lib/notifications.js';
import { bookingConfirmedTemplate, magicLinkTemplate } from '../lib/email/templates.js';
import { generateMagicLinkToken, hashToken } from '../lib/tokens.js';

const RECURRING_COUNT: Record<Cadence, number> = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Validation
  const parsed = bookRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: 'invalid',
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  const data = parsed.data;

  // Service-area check
  if (!isInServiceArea(data.postal_code)) {
    res.status(422).json({
      status: 'out_of_area',
      message: "We don't serve your area yet. Join the waitlist and we'll let you know when we do.",
    });
    return;
  }

  const db = getDb();

  try {
    // Look up existing customer by email (read — outside the write transaction).
    const [existing] = await db
      .select()
      .from(customer)
      .where(eq(customer.email, data.email));

    if (existing) {
      // A customer with an active subscription can't re-book a plan.
      const [activeSub] = await db
        .select()
        .from(subscription)
        .where(eq(subscription.customerId, existing.id));
      if (activeSub && activeSub.status === 'active') {
        res.status(409).json({
          status: 'already_subscribed',
          message: 'This email is already on an active plan. Check your inbox for the manage link or visit /manage.',
        });
        return;
      }
    }

    const isNewCustomer = !existing;
    const customerId = existing?.id ?? crypto.randomUUID();

    // Prepare the rows (pure — no I/O yet). The inserts run inside the
    // transaction below so a mid-flight failure can't leave orphan rows.
    const startDate = new Date();
    let subscriptionId: string | null = null;
    let cadence: Cadence | null = null;
    let visitDates: Date[];

    if (data.plan === 'oneoff') {
      visitDates = [new Date(`${data.oneoff_date!}T12:00:00Z`)];
    } else {
      subscriptionId = crypto.randomUUID();
      cadence = data.plan;
      visitDates = generateVisitDates({
        startDate,
        pickupDay: data.pickup_day,
        cadence,
        count: RECURRING_COUNT[cadence],
      });
    }

    const visitRows = visitDates.map((scheduledFor) => ({
      id: crypto.randomUUID(),
      customerId,
      subscriptionId,
      // One-offs have no subscription, so store bin count on the visit itself.
      // Recurring visits leave it null and derive from the subscription.
      binCount: data.plan === 'oneoff' ? data.bin_count : null,
      scheduledFor,
    }));
    const firstVisitId = visitRows[0]?.id ?? null;
    const tokenPlain = generateMagicLinkToken();

    // All booking writes in one transaction: customer (if new) + subscription
    // (if recurring) + visits + magic-link token. If any insert fails, the whole
    // booking rolls back — no orphan customer/subscription/visit rows. Email
    // sends stay OUTSIDE: a failed send must not undo a saved booking, and
    // network I/O should never hold a DB transaction open.
    await db.transaction(async (tx) => {
      if (isNewCustomer) {
        await tx.insert(customer).values({
          id: customerId,
          email: data.email,
          name: data.name,
          phone: data.phone ?? null,
          street: data.street,
          city: data.city,
          postalCode: normalizePostalCode(data.postal_code),
          pickupDay: data.pickup_day,
        });
      }
      if (subscriptionId) {
        await tx.insert(subscription).values({
          id: subscriptionId,
          customerId,
          cadence: cadence!,
          binCount: data.bin_count,
          startedOn: startDate,
        });
      }
      await tx.insert(visit).values(visitRows);
      await tx.insert(magicLinkToken).values({
        token: hashToken(tokenPlain),
        customerId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
    });

    const firstVisitDate = visitDates[0]!.toISOString().slice(0, 10);
    const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';
    const manageUrl = `${siteUrl}/api/magic-link/verify?token=${encodeURIComponent(tokenPlain)}`;

    // Send booking_confirmed — idempotent on (firstVisitId, 'booking_confirmed')
    const bookingTemplate = bookingConfirmedTemplate({
      name: data.name,
      firstVisitDate,
      manageUrl,
    });
    await sendAndLog({
      kind: 'booking_confirmed',
      to: data.email,
      subject: bookingTemplate.subject,
      body: bookingTemplate.text,
      html: bookingTemplate.html,
      customerId,
      visitId: firstVisitId,
    });

    // Send magic_link — visitId: null, no idempotency check (each booking issues a fresh token)
    const mlTemplate = magicLinkTemplate({ manageUrl });
    await sendAndLog({
      kind: 'magic_link',
      to: data.email,
      subject: mlTemplate.subject,
      body: mlTemplate.text,
      html: mlTemplate.html,
      customerId,
      visitId: null,
    });

    res.status(200).json({
      status: 'ok',
      customer_id: customerId,
      first_visit_date: firstVisitDate,
    });
  } catch (err) {
    // Postgres unique_violation = SQLSTATE 23505. Drizzle surfaces this in
    // err.code or err.constraint depending on driver version; postgres-js
    // attaches it on err.code as '23505'.
    const code = (err as { code?: string } | undefined)?.code;
    if (code === '23505') {
      res.status(409).json({
        status: 'already_subscribed',
        message: 'This email is already on our system. Request a manage link instead.',
      });
      return;
    }
    console.error('[book] failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    res.status(500).json({ status: 'error', message });
  }
}
