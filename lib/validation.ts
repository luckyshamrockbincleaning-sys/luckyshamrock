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
    oneoff_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'oneoff_date must be YYYY-MM-DD').optional(),
  })
  .refine(
    (data) => (data.plan === 'oneoff' ? data.oneoff_date !== undefined : data.oneoff_date === undefined),
    {
      message: 'oneoff_date is required when plan=oneoff and forbidden otherwise',
      path: ['oneoff_date'],
    },
  );

export type BookRequest = z.infer<typeof bookRequestSchema>;

export const waitlistRequestSchema = z.object({
  email: emailField,
  postal_code: z.string().trim().min(1).max(10),
});

export type WaitlistRequest = z.infer<typeof waitlistRequestSchema>;

export { cadence, pickupDay };
