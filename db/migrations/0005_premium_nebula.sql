ALTER TYPE "public"."payment_status" ADD VALUE 'refunded';--> statement-breakpoint
DROP INDEX "visit_status_idx";--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "bin_location" text;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_sub_per_customer" ON "subscription" USING btree ("customer_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "visit_actionable_idx" ON "visit" USING btree ("scheduled_for") WHERE status in ('scheduled', 'heading_there');--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_non_negative" CHECK ("payment"."amount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_discount_non_negative" CHECK ("payment"."discount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_bin_count_positive" CHECK ("subscription"."bin_count" > 0);--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_bin_count_positive" CHECK ("visit"."bin_count" is null or "visit"."bin_count" > 0);