# Booking Payment Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require customers to save a card during booking while preserving "charged only after clean."

**Architecture:** Reuse Stripe SetupIntents, because the booking flow saves a card for later off-session charges. To stay under the Vercel 12-function cap, add a `payment_setup` action to `POST /api/book` rather than adding another endpoint. The final booking request includes the Stripe customer/setup intent ids; the API verifies the SetupIntent succeeded and stores the default payment method on the customer before creating visits.

**Tech Stack:** Static React/Babel booking UI, Vercel Node API, Stripe SetupIntents/Payment Element, Drizzle/Postgres, Vitest.

---

### Task 1: Billing Helpers

**Files:**
- Modify: `lib/billing.ts`
- Test: `lib/_tests/billing.test.ts`

- [x] Add failing tests for creating a booking SetupIntent and reading the saved payment method from a succeeded SetupIntent.
- [x] Implement `createBookingSetupIntent(input)` by creating a Stripe customer and SetupIntent with `usage: 'off_session'`.
- [x] Implement `getSavedPaymentMethodFromSetupIntent(setupIntentId, stripeCustomerId)` by retrieving the SetupIntent and requiring `status === 'succeeded'`, matching customer id, and a string `payment_method`.
- [x] Run `npm test -- lib/_tests/billing.test.ts`.

### Task 2: Booking API

**Files:**
- Modify: `api/book.ts`
- Test: `api/_tests/book.test.ts`

- [x] Add failing tests that `POST /api/book` with `{intent:'payment_setup'}` returns SetupIntent data and that normal booking requires/uses a verified saved card when Stripe is configured.
- [x] Add an early `/api/book` branch for `intent === 'payment_setup'` that validates name/email/phone/postal code and returns `{status:'ok', client_secret, publishable_key, stripe_customer_id, setup_intent_id}`.
- [x] Validate service area and reject existing active subscribers before creating a Stripe SetupIntent.
- [x] Add final booking verification: when Stripe is configured, require `payment_setup.stripe_customer_id` and `payment_setup.setup_intent_id`, verify the SetupIntent, then persist `stripeCustomerId` and `defaultPaymentMethodId` in the customer row inside the existing transaction.
- [x] Keep non-Stripe test/dev fallback working: if Stripe is not configured, booking can still proceed for local tests.
- [x] Run `npm test -- api/_tests/book.test.ts lib/_tests/billing.test.ts`.

### Task 3: Booking UI

**Files:**
- Modify: `components-booking.jsx`

- [x] Add a Payment step between Info and Confirm.
- [x] Load Stripe.js in the booking component and mount the Payment Element after `/api/book {intent:'payment_setup'}` returns a client secret.
- [x] Require successful `stripe.confirmSetup(... redirect:'if_required')` before allowing Review & Confirm.
- [x] Include `payment_setup` in the final `/api/book` payload.
- [x] Update success copy from "Check your email for manage link" to clarify the card is saved and no charge happened today.

### Task 4: Verification and Deploy

**Files:**
- Modify: `CLAUDE.md` if conventions changed.
- Update: `/Users/homie/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md`

- [x] Run `npm run typecheck`.
- [x] Run targeted tests: `npm test -- lib/_tests/billing.test.ts api/_tests/book.test.ts lib/_tests/validation.test.ts`.
- [x] Run full `npm test`.
- [ ] Commit and push.
- [ ] Verify Vercel deploy status, production `/api/health`, and live booking component contains the Payment step.

## Self-Review

- Scope is one workflow: require card setup during booking.
- No new Vercel function is added.
- No upfront charge is introduced; charging remains operator Done/off-session.
- Existing manage-page card replacement remains intact.
