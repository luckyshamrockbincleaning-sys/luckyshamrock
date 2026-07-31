ALTER TYPE "public"."notification_kind" ADD VALUE 'referral_earned';--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "referred_by" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "referral_awarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "credit_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_referred_by_customer_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_referral_code_unique" UNIQUE("referral_code");--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_credit_non_negative" CHECK ("customer"."credit_cents" >= 0);