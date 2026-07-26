CREATE TYPE "public"."payment_method" AS ENUM('card', 'cash', 'terminal', 'qr');--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'paid_cash';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'paid_terminal';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'awaiting_payment';--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "method" "payment_method" DEFAULT 'card' NOT NULL;