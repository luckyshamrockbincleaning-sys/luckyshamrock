ALTER TABLE "customer" ALTER COLUMN "postal_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "surcharge_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "surcharge_reason" text;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_surcharge_non_negative" CHECK ("payment"."surcharge_cents" >= 0);