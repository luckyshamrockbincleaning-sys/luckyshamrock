import { z } from 'zod';
import { LAUNCH_DATE_ISO } from './launch.js';
import { normalizeBinTypes, BIN_TYPES } from './bin-types.js';

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('invalid email');

const pickupDay = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
const cadence = z.enum(['monthly', 'bimonthly', 'quarterly', 'seasonal']);
// Only the plans we actually SELL are bookable. bimonthly/quarterly remain in the
// DB enum + Cadence type for legacy subscriptions, but the public booking
// endpoint must not let a crafted request create an unsold plan.
const planField = z.enum(['oneoff', 'monthly', 'seasonal']);
const binCount = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const paymentSetup = z.object({
  stripe_customer_id: z.string().trim().min(1),
  setup_intent_id: z.string().trim().min(1),
});

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnlyUtcNoon(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

function todayEdmontonUtcNoon(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value;
  return new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), 12, 0, 0));
}

export const bookRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'name required').max(120),
    email: emailField,
    phone: z.string().trim().min(1).max(40).optional(),
    street: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(80),
    postal_code: z.string().trim().min(1).max(10),
    pickup_day: pickupDay,
    bin_count: binCount,
    // Which bins to clean. Optional so a caller predating the field still
    // works, but when present it must agree with bin_count — bin_count is what
    // gets priced, so a request claiming one bin and two types would be two
    // bins cleaned for the price of one. Bound follows the vocabulary, so
    // adding or removing a bin type can't leave a stale number here.
    bin_types: z.array(z.string()).max(BIN_TYPES.length).optional(),
    bin_location: z.enum(['curb', 'side', 'garage', 'back']).optional(),
    plan: planField,
    oneoff_date: z.string().regex(DATE_ONLY_RE, 'oneoff_date must be YYYY-MM-DD').optional(),
    payment_setup: paymentSetup.optional(),
    // Deliberately unvalidated beyond a length bound: an unknown or malformed
    // code must degrade to "no discount", never reject an otherwise-valid
    // booking. Resolution happens in api/book.ts.
    referral_code: z.string().trim().max(32).optional(),
  })
  .refine(
    (data) => (data.plan === 'oneoff' ? data.oneoff_date !== undefined : data.oneoff_date === undefined),
    {
      message: 'oneoff_date is required when plan=oneoff and forbidden otherwise',
      path: ['oneoff_date'],
    },
  )
  .superRefine((data, ctx) => {
    if (data.bin_types !== undefined) {
      const normalized = normalizeBinTypes(data.bin_types);
      if (normalized === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'bin_types must be one or more of: garbage, organics',
          path: ['bin_types'],
        });
      } else if (normalized.length !== data.bin_count) {
        // Also catches a duplicate selection ({garbage,garbage} normalizes to
        // one entry) — you cannot clean the same bin twice.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'bin_types must list exactly bin_count distinct bins',
          path: ['bin_types'],
        });
      }
    }
  })
  .superRefine((data, ctx) => {
    if (data.plan !== 'oneoff' || !data.oneoff_date) return;

    const oneoffDate = parseDateOnlyUtcNoon(data.oneoff_date);
    if (!oneoffDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oneoff_date must be a real calendar date',
        path: ['oneoff_date'],
      });
      return;
    }

    if (oneoffDate < todayEdmontonUtcNoon()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oneoff_date cannot be in the past',
        path: ['oneoff_date'],
      });
    }
    if (data.oneoff_date < LAUNCH_DATE_ISO) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `we start cleaning on ${LAUNCH_DATE_ISO} — pick that day or later`,
        path: ['oneoff_date'],
      });
    }
    if (oneoffDate.getUTCDay() === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oneoff_date cannot be a Sunday',
        path: ['oneoff_date'],
      });
    }
  });

export type BookRequest = z.infer<typeof bookRequestSchema>;

export const waitlistRequestSchema = z.object({
  email: emailField,
  postal_code: z.string().trim().min(1).max(10),
});

export type WaitlistRequest = z.infer<typeof waitlistRequestSchema>;

export { cadence, pickupDay };
