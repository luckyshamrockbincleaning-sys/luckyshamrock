import { z } from 'zod';

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('invalid email');

const pickupDay = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
const cadence = z.enum(['monthly', 'bimonthly', 'quarterly', 'seasonal']);
const planField = z.enum(['oneoff', 'monthly', 'bimonthly', 'quarterly', 'seasonal']);
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
    plan: planField,
    oneoff_date: z.string().regex(DATE_ONLY_RE, 'oneoff_date must be YYYY-MM-DD').optional(),
    payment_setup: paymentSetup.optional(),
  })
  .refine(
    (data) => (data.plan === 'oneoff' ? data.oneoff_date !== undefined : data.oneoff_date === undefined),
    {
      message: 'oneoff_date is required when plan=oneoff and forbidden otherwise',
      path: ['oneoff_date'],
    },
  )
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
