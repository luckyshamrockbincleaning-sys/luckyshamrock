ALTER TABLE "subscription" ADD COLUMN "bin_types" text[];--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "bin_types" text[];--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_bin_types_match_count" CHECK ("subscription"."bin_types" is null or array_length("subscription"."bin_types", 1) = "subscription"."bin_count");--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_bin_types_match_count" CHECK ("visit"."bin_types" is null or ("visit"."bin_count" is not null and array_length("visit"."bin_types", 1) = "visit"."bin_count"));