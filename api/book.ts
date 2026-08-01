import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { customer, subscription, visit, magicLinkToken } from '../db/schema.js';
import { bookRequestSchema } from '../lib/validation.js';
import { isInServiceArea, normalizePostalCode } from '../lib/postal.js';
import { generateVisitDates, generateSeasonalDates, type Cadence } from '../lib/schedule.js';
import { sendAndLog } from '../lib/notifications.js';
import { bookingConfirmedTemplate, operatorNewBookingTemplate } from '../lib/email/templates.js';
import { generateMagicLinkToken, hashToken } from '../lib/tokens.js';
import {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_CODE_LENGTH,
  REFERRAL_REWARD_CENTS,
} from '../lib/referral.js';
import {
  createBookingSetupIntent,
  createStripeCustomer,
  getSavedPaymentMethodFromSetupIntent,
} from '../lib/billing.js';
import { isStripeConfigured } from '../lib/stripe.js';
import { formatFriendlyDate } from '../lib/dates.js';
import { effectiveStartDate } from '../lib/launch.js';

// How many future visits to generate per cadence at booking time.
const RECURRING_COUNT: Record<Cadence, number> = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  seasonal: 3, // Three Wash Season — 3 cleans/year (May, Jul, Sep)
};

const paymentSetupRequestSchema = z.object({
  intent: z.literal('payment_setup'),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(40).optional(),
  postal_code: z.string().trim().min(1).max(10),
});

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (req.body?.intent === 'payment_setup') {
    const setupParsed = paymentSetupRequestSchema.safeParse(req.body);
    if (!setupParsed.success) {
      res.status(400).json({
        status: 'invalid',
        errors: setupParsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      if (!isInServiceArea(setupParsed.data.postal_code)) {
        res.status(422).json({
          status: 'out_of_area',
          message: "We don't serve your area yet. Join the waitlist and we'll let you know when we do.",
        });
        return;
      }

      const db = getDb();
      const [existing] = await db
        .select()
        .from(customer)
        .where(eq(customer.email, setupParsed.data.email));
      if (existing) {
        const [activeSub] = await db
          .select({ id: subscription.id })
          .from(subscription)
          .where(and(eq(subscription.customerId, existing.id), eq(subscription.status, 'active')))
          .limit(1);
        if (activeSub) {
          res.status(409).json({
            status: 'already_subscribed',
            message: 'This email is already on an active plan. Check your inbox for the manage link or visit /manage.',
          });
          return;
        }
      }

      const setup = await createBookingSetupIntent({
        email: setupParsed.data.email,
        name: setupParsed.data.name,
        phone: setupParsed.data.phone,
      });
      if (!setup) {
        res.status(503).json({ status: 'billing_unavailable', message: 'Card payments are not set up yet.' });
        return;
      }
      res.status(200).json({
        status: 'ok',
        client_secret: setup.clientSecret,
        publishable_key: setup.publishableKey,
        stripe_customer_id: setup.stripeCustomerId,
        setup_intent_id: setup.setupIntentId,
      });
    } catch (err) {
      console.error('[book:payment_setup] failed', err);
      res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
    }
    return;
  }

  // Look up a referral code typed (or link-carried) by a prospective customer.
  //
  // ALWAYS 200 with a `valid` flag — never 404 on a miss. A distinguishable
  // "not found" turns this into a free oracle for enumerating live codes, the
  // same reason /api/magic-link/send always returns 200 regardless of whether
  // the email exists. Only the referrer's FIRST NAME is returned: enough to
  // make "$5 off, courtesy of Richelle" feel real, not enough to hand a
  // stranger who guessed a code someone's full identity.
  if (req.body?.intent === 'check_referral') {
    const code = normalizeReferralCode(String(req.body?.code ?? ''));
    if (code.length !== REFERRAL_CODE_LENGTH) {
      res.status(200).json({ status: 'ok', valid: false });
      return;
    }
    try {
      const db = getDb();
      const [owner] = await db
        .select({ name: customer.name })
        .from(customer)
        .where(eq(customer.referralCode, code));
      if (!owner) {
        res.status(200).json({ status: 'ok', valid: false });
        return;
      }
      res.status(200).json({
        status: 'ok',
        valid: true,
        referrer_first_name: owner.name.trim().split(/\s+/)[0] ?? '',
      });
    } catch (err) {
      console.error('[book:check_referral] failed', err);
      // Degrade to "no discount" rather than blocking the booking entirely.
      res.status(200).json({ status: 'ok', valid: false });
    }
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
        .select({ id: subscription.id })
        .from(subscription)
        .where(and(eq(subscription.customerId, existing.id), eq(subscription.status, 'active')))
        .limit(1);
      if (activeSub) {
        res.status(409).json({
          status: 'already_subscribed',
          message: 'This email is already on an active plan. Check your inbox for the manage link or visit /manage.',
        });
        return;
      }
    }

    let verifiedPaymentSetup: { stripeCustomerId: string; paymentMethodId: string } | null = null;
    if (isStripeConfigured()) {
      if (!data.payment_setup) {
        res.status(400).json({
          status: 'invalid',
          errors: { payment_setup: ['Save a card before confirming your booking.'] },
        });
        return;
      }
      const paymentMethodId = await getSavedPaymentMethodFromSetupIntent(
        data.payment_setup.setup_intent_id,
        data.payment_setup.stripe_customer_id,
      );
      if (!paymentMethodId) {
        res.status(400).json({
          status: 'invalid',
          errors: { payment_setup: ['Card setup is incomplete. Save a card before confirming your booking.'] },
        });
        return;
      }
      verifiedPaymentSetup = {
        stripeCustomerId: data.payment_setup.stripe_customer_id,
        paymentMethodId,
      };
    }

    const isNewCustomer = !existing;
    const customerId = existing?.id ?? crypto.randomUUID();

    // Resolve an inbound referral code. A bad code silently yields no discount —
    // never block a real booking over it. Self-referral is rejected by comparing
    // the resolved owner against the booking customer.
    let referrerId: string | null = null;
    const inboundCode = normalizeReferralCode(data.referral_code ?? '');
    if (inboundCode.length === REFERRAL_CODE_LENGTH) {
      const [owner] = await db
        .select({ id: customer.id })
        .from(customer)
        .where(eq(customer.referralCode, inboundCode));
      if (owner && owner.id !== customerId) referrerId = owner.id;
    }

    // Prepare the rows (pure — no I/O yet). The inserts run inside the
    // transaction below so a mid-flight failure can't leave orphan rows.
    // Floored to the day before launch (2026-07-23) so pre-orders can't
    // schedule a clean before routes exist. No-op after launch day.
    const startDate = effectiveStartDate();
    let subscriptionId: string | null = null;
    let cadence: Cadence | null = null;
    let visitDates: Date[];

    if (data.plan === 'oneoff') {
      visitDates = [new Date(`${data.oneoff_date!}T12:00:00Z`)];
    } else {
      subscriptionId = crypto.randomUUID();
      cadence = data.plan;
      visitDates =
        cadence === 'seasonal'
          ? generateSeasonalDates({ startDate, pickupDay: data.pickup_day, count: RECURRING_COUNT.seasonal })
          : generateVisitDates({
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
    // Every customer gets their own shareable code at booking. Generated here
    // rather than lazily so /manage and the done email can always show one.
    const newReferralCode = generateReferralCode();

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
          binLocation: data.bin_location ?? null,
          stripeCustomerId: verifiedPaymentSetup?.stripeCustomerId ?? null,
          defaultPaymentMethodId: verifiedPaymentSetup?.paymentMethodId ?? null,
          referralCode: newReferralCode,
          referredBy: referrerId,
          // The friend's welcome $5 rides the same balance the referrer's
          // reward will — one mechanism, spent automatically at Done.
          creditCents: referrerId ? REFERRAL_REWARD_CENTS : 0,
        });
      } else {
        await tx
          .update(customer)
          .set({
            name: data.name,
            phone: data.phone ?? null,
            street: data.street,
            city: data.city,
            postalCode: normalizePostalCode(data.postal_code),
            pickupDay: data.pickup_day,
            binLocation: data.bin_location ?? null,
            ...(verifiedPaymentSetup
              ? {
                  stripeCustomerId: verifiedPaymentSetup.stripeCustomerId,
                  defaultPaymentMethodId: verifiedPaymentSetup.paymentMethodId,
                }
              : {}),
            // A returning customer can still be referred by a neighbour — most
            // repeat business comes through this branch, and without it the
            // form would promise "$5 off, courtesy of X" and then charge full
            // price. Guarded on referredBy still being null so nobody can farm
            // credit by re-booking with a different code each time.
            ...(referrerId && !existing?.referredBy
              ? {
                  referredBy: referrerId,
                  creditCents: sql`${customer.creditCents} + ${REFERRAL_REWARD_CENTS}`,
                }
              : {}),
          })
          .where(eq(customer.id, customerId));
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
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    });

    const firstVisitDate = visitDates[0]!.toISOString().slice(0, 10);
    const firstVisitDateLong = formatFriendlyDate(firstVisitDate);
    const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';
    const manageUrl = `${siteUrl}/api/magic-link/verify?token=${encodeURIComponent(tokenPlain)}`;

    // Send ONE email at booking: booking_confirmed already carries the manage
    // link built from `tokenPlain`. We deliberately do NOT also send a separate
    // magic_link email here — both would embed the same token and create
    // duplicate inbox noise. The magic_link email is reserved for the /manage
    // "email me a link" flow, which mints its own fresh token.
    const bookingTemplate = bookingConfirmedTemplate({
      name: data.name,
      firstVisitDate: firstVisitDateLong,
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

    // Heads-up to the operator. Best-effort: a failed internal email must
    // never fail the customer's booking. Idempotent on (firstVisitId, kind).
    const operatorEmail = process.env.OPERATOR_NOTIFY_EMAIL || process.env.GMAIL_SEND_AS;
    if (operatorEmail) {
      try {
        const planLabel =
          data.plan === 'oneoff' ? 'One-Time Clean' : data.plan === 'monthly' ? 'Monthly' : 'Three Wash Season';
        const opTpl = operatorNewBookingTemplate({
          name: data.name,
          email: data.email,
          phone: data.phone ?? null,
          street: data.street,
          city: data.city,
          postalCode: data.postal_code,
          plan: planLabel,
          binCount: data.bin_count,
          binLocation: data.bin_location ?? null,
          firstVisitDate: firstVisitDateLong,
        });
        await sendAndLog({
          kind: 'operator_new_booking',
          to: operatorEmail,
          subject: opTpl.subject,
          body: opTpl.text,
          html: opTpl.html,
          customerId,
          visitId: firstVisitId,
        });
      } catch (err) {
        console.error('[book] operator notification failed (booking unaffected)', err);
      }
    }

    // If Stripe is not configured, keep the old no-card booking path alive and
    // best-effort provision a customer for later. When Stripe is configured,
    // booking requires `verifiedPaymentSetup` and this fallback is skipped.
    if (isNewCustomer && !verifiedPaymentSetup) {
      try {
        const stripeCustomerId = await createStripeCustomer({
          email: data.email,
          name: data.name,
          phone: data.phone ?? null,
        });
        if (stripeCustomerId) {
          await db
            .update(customer)
            .set({ stripeCustomerId })
            .where(eq(customer.id, customerId));
        }
      } catch (err) {
        console.error('[book] stripe customer provisioning failed (non-fatal)', err);
      }
    }

    res.status(200).json({
      status: 'ok',
      customer_id: customerId,
      first_visit_date: firstVisitDate,
      first_visit_date_long: firstVisitDateLong,
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
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
