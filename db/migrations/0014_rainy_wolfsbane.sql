ALTER TYPE "public"."payment_method" ADD VALUE 'etransfer';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'paid_etransfer' BEFORE 'awaiting_payment';