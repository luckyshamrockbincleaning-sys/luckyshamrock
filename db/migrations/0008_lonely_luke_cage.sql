ALTER TYPE "public"."notification_kind" ADD VALUE 'operator_feedback';--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "rating" integer;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "rating_comment" text;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "rated_at" timestamp with time zone;