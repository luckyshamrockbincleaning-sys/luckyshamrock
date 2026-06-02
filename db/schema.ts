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
  index,
} from 'drizzle-orm/pg-core';

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
]);

// Per-visit billing state (Phase 6 — Stripe).
export const paymentStatusEnum = pgEnum('payment_status', [
  'unpaid', // not yet charged
  'charged', // successfully charged
  'comped', // intentionally not charged (full discount / freebie)
  'failed', // charge attempted and declined — needs retry / another method
]);

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
    postalCode: varchar('postal_code', { length: 10 }).notNull(),
    pickupDay: pickupDayEnum('pickup_day').notNull(),
    notes: text('notes'),
    // Stripe billing identifiers (Phase 6). Null until the customer saves a card.
    stripeCustomerId: text('stripe_customer_id'),
    defaultPaymentMethodId: text('default_payment_method_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: unique('customer_email_unique').on(t.email),
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
    status: subscriptionStatusEnum('status').notNull().default('active'),
    startedOn: date('started_on', { mode: 'date' }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('subscription_customer_idx').on(t.customerId),
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
    scheduledFor: date('scheduled_for', { mode: 'date' }).notNull(),
    status: visitStatusEnum('status').notNull().default('scheduled'),
    headingThereAt: timestamp('heading_there_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    notes: text('notes'),
    // Billing state for this visit (Phase 6). Default unpaid until charged on Done.
    paymentStatus: paymentStatusEnum('payment_status').notNull().default('unpaid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('visit_customer_idx').on(t.customerId),
    subscriptionIdx: index('visit_subscription_idx').on(t.subscriptionId),
    scheduledForIdx: index('visit_scheduled_for_idx').on(t.scheduledFor),
    statusIdx: index('visit_status_idx').on(t.status),
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
    currency: varchar('currency', { length: 3 }).notNull().default('cad'),
    status: paymentRecordStatusEnum('status').notNull().default('pending'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('payment_customer_idx').on(t.customerId),
    visitIdx: index('payment_visit_idx').on(t.visitId),
    // A given PaymentIntent maps to exactly one payment row (idempotent webhooks).
    intentUnique: unique('payment_intent_unique').on(t.stripePaymentIntentId),
  }),
);
