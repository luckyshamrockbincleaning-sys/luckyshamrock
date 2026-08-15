import {
  pgTable,
  text,
  varchar,
  integer,
  timestamp,
  date,
  pgEnum,
  uuid,
  unique,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────

export const pickupDayEnum = pgEnum('pickup_day', [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
]);

export const cadenceEnum = pgEnum('cadence', [
  'monthly',
  'bimonthly',
  'quarterly',
  'seasonal',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'paused',
  'cancelled',
]);

export const visitStatusEnum = pgEnum('visit_status', [
  'scheduled',
  'heading_there',
  'done',
  'skipped',
  'cancelled',
]);

export const notificationKindEnum = pgEnum('notification_kind', [
  'magic_link',
  'booking_confirmed',
  'on_our_way',
  'done',
  'day_before',
  'operator_new_booking', // internal: tells the operator a booking landed
  'refund', // customer refund receipt, triggered by the charge.refunded webhook
  'operator_feedback', // internal: a customer left a low-star rating comment
  'receipt', // payment confirmation, triggered by the checkout.session.completed webhook
  'referral_earned', // a referred friend's first clean was paid; the referrer earned $5
  'season_start', // spring: the cleaning season has reopened and visits are booked
]);

// Per-visit billing state (Phase 6 — Stripe).
export const paymentStatusEnum = pgEnum('payment_status', [
  'unpaid', // not yet charged
  'charged', // successfully charged
  'comped', // intentionally not charged (full discount / freebie)
  'failed', // charge attempted and declined — needs retry / another method
  'refunded', // charge was refunded (e.g. from the Stripe dashboard)
  'paid_cash', // collected in cash at the door
  'paid_terminal', // collected via tap in the Stripe app; reconciled in Stripe
  'paid_etransfer', // Interac e-transfer; reconciled in the bank, not in Stripe
  'awaiting_payment', // QR issued, waiting for checkout.session.completed
]);

// How the money arrived. Lets revenue be split by channel later.
export const paymentMethodEnum = pgEnum('payment_method', ['card', 'cash', 'terminal', 'qr', 'etransfer']);

// Lifecycle of a single payment attempt (Phase 6 — Stripe).
export const paymentRecordStatusEnum = pgEnum('payment_record_status', [
  'pending',
  'succeeded',
  'failed',
  'refunded',
]);

// ─────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────

export const customer = pgTable(
  'customer',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    street: text('street').notNull(),
    city: text('city').notNull(),
    // Optional: self-serve bookings always supply one (it gates the service
    // area), but a walk-up created at the door collects a phone number instead
    // — the operator is standing at the address and does not need it.
    postalCode: varchar('postal_code', { length: 10 }),
    pickupDay: pickupDayEnum('pickup_day').notNull(),
    // Where the operator can find the bin on service day (curb / side / garage /
    // back). Collected at booking; nullable for legacy rows.
    binLocation: text('bin_location'),
    notes: text('notes'),
    // Stripe billing identifiers (Phase 6). Null until the customer saves a card.
    stripeCustomerId: text('stripe_customer_id'),
    defaultPaymentMethodId: text('default_payment_method_id'),
    // Referral program. `referralCode` is this customer's own shareable code
    // (nullable: rows predating the feature are backfilled by
    // db/backfill-referral-codes.ts). `creditCents` is a stacking,
    // never-expiring balance spent automatically at Done — it holds BOTH the
    // friend's welcome $5 and any referral $5 they later earn. `referredBy` is
    // who sent them; `referralAwardedAt` stamps the moment that referrer was
    // paid, and is the idempotency guard against double payouts.
    referralCode: text('referral_code'),
    creditCents: integer('credit_cents').notNull().default(0),
    // Self-reference needs the callback + explicit return type, otherwise
    // TypeScript hits a circular inference error on the table it belongs to.
    // `restrict` matches the rest of the schema: deleting someone who referred
    // a customer must be deliberate, never a silent cascade.
    referredBy: uuid('referred_by').references((): AnyPgColumn => customer.id, { onDelete: 'restrict' }),
    referralAwardedAt: timestamp('referral_awarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: unique('customer_email_unique').on(t.email),
    referralCodeUnique: unique('customer_referral_code_unique').on(t.referralCode),
    creditNonNegative: check('customer_credit_non_negative', sql`${t.creditCents} >= 0`),
  }),
);

export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    cadence: cadenceEnum('cadence').notNull(),
    binCount: integer('bin_count').notNull(),
    // Which bins, e.g. {garbage,organics}. NULL on plans booked before we
    // asked — see lib/bin-types.ts. bin_count stays the source of truth for
    // pricing and photo pairing; the CHECK below stops the two drifting.
    binTypes: text('bin_types').array(),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    startedOn: date('started_on', { mode: 'date' }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('subscription_customer_idx').on(t.customerId),
    // At most one ACTIVE subscription per customer. Backs the app-level
    // "already_subscribed" guard so a concurrent double-submit can't create
    // two active plans (and two sets of billable visits).
    oneActiveSubPerCustomer: uniqueIndex('one_active_sub_per_customer')
      .on(t.customerId)
      .where(sql`status = 'active'`),
    binCountPositive: check('subscription_bin_count_positive', sql`${t.binCount} > 0`),
    binTypesMatchCount: check(
      'subscription_bin_types_match_count',
      sql`${t.binTypes} is null or array_length(${t.binTypes}, 1) = ${t.binCount}`,
    ),
  }),
);

export const visit = pgTable(
  'visit',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    subscriptionId: uuid('subscription_id').references(() => subscription.id, {
      onDelete: 'set null',
    }),
    // Bin count for one-off visits, which have no subscription to derive it from.
    // Recurring visits leave this null and read bin_count off their subscription
    // (single source of truth per visit type). The operator view COALESCEs the two.
    binCount: integer('bin_count'),
    // Set on one-off/walk-up visits, the same way bin_count is. Recurring
    // visits leave it null and inherit the subscription's.
    binTypes: text('bin_types').array(),
    scheduledFor: date('scheduled_for', { mode: 'date' }).notNull(),
    status: visitStatusEnum('status').notNull().default('scheduled'),
    headingThereAt: timestamp('heading_there_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    notes: text('notes'),
    // Customer star rating from the done email (1-5, tap-a-star). 4-5 stars
    // funnel on to Google; 1-3 collect a private comment instead.
    rating: integer('rating'),
    ratingComment: text('rating_comment'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    // Billing state for this visit (Phase 6). Default unpaid until charged on Done.
    paymentStatus: paymentStatusEnum('payment_status').notNull().default('unpaid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('visit_customer_idx').on(t.customerId),
    subscriptionIdx: index('visit_subscription_idx').on(t.subscriptionId),
    scheduledForIdx: index('visit_scheduled_for_idx').on(t.scheduledFor),
    // Partial index matching the operator "actionable stops" predicate exactly
    // (today + upcoming queries filter scheduled_for + status IN actionable).
    // Far smaller and more selective than the old full visit_status_idx, which
    // skewed toward 'done' over time and was never selective enough to be chosen.
    actionableIdx: index('visit_actionable_idx')
      .on(t.scheduledFor)
      .where(sql`status in ('scheduled', 'heading_there')`),
    binCountPositive: check(
      'visit_bin_count_positive',
      sql`${t.binCount} is null or ${t.binCount} > 0`,
    ),
    // A visit that names its bins must also state how many, and agree.
    binTypesMatchCount: check(
      'visit_bin_types_match_count',
      sql`${t.binTypes} is null or (${t.binCount} is not null and array_length(${t.binTypes}, 1) = ${t.binCount})`,
    ),
  }),
);

export const magicLinkToken = pgTable(
  'magic_link_token',
  {
    token: text('token').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('magic_link_customer_idx').on(t.customerId),
  }),
);

export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    visitId: uuid('visit_id').references(() => visit.id, { onDelete: 'set null' }),
    kind: notificationKindEnum('kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    error: text('error'),
    gmailMessageId: text('gmail_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('notification_customer_idx').on(t.customerId),
    visitKindUnique: unique('notification_visit_kind_unique').on(t.visitId, t.kind),
  }),
);

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  postalCode: varchar('postal_code', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per charge attempt against a visit (Phase 6 — Stripe). Amounts are in
// cents. We bill per-visit (not via Stripe Subscriptions) so skips, seasonal
// scheduling, and on-the-spot discounts stay under our control. The Stripe
// webhook is the source of truth for status transitions.
export const payment = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    visitId: uuid('visit_id').references(() => visit.id, { onDelete: 'set null' }),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    amountCents: integer('amount_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    // Referral/goodwill credit consumed by this payment. Recorded so the PDF
    // receipt line items still add up to the total paid, and so spent credit is
    // auditable after the fact.
    creditCents: integer('credit_cents').notNull().default(0),
    // Operator's on-the-spot surcharge for a bin in an unusually bad state,
    // with the reason shown to the customer on their receipt. An unexplained
    // extra charge is the fastest way to a dispute, so the reason travels with
    // the amount rather than living only in the operator's head.
    surchargeCents: integer('surcharge_cents').notNull().default(0),
    surchargeReason: text('surcharge_reason'),
    currency: varchar('currency', { length: 3 }).notNull().default('cad'),
    status: paymentRecordStatusEnum('status').notNull().default('pending'),
    method: paymentMethodEnum('method').notNull().default('card'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('payment_customer_idx').on(t.customerId),
    visitIdx: index('payment_visit_idx').on(t.visitId),
    // A given PaymentIntent maps to exactly one payment row (idempotent webhooks).
    intentUnique: unique('payment_intent_unique').on(t.stripePaymentIntentId),
    // Amounts are non-negative. NOTE: discount can exceed amount (a comped visit
    // stores amount_cents=0 with the full discount_cents), so we do NOT constrain
    // discount <= amount — only that neither goes negative.
    amountNonNegative: check('payment_amount_non_negative', sql`${t.amountCents} >= 0`),
    discountNonNegative: check('payment_discount_non_negative', sql`${t.discountCents} >= 0`),
    surchargeNonNegative: check('payment_surcharge_non_negative', sql`${t.surchargeCents} >= 0`),
  }),
);
