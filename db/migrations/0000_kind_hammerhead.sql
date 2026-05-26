CREATE TYPE "public"."cadence" AS ENUM('monthly', 'bimonthly', 'quarterly');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('magic_link', 'booking_confirmed', 'on_our_way', 'done', 'day_before');--> statement-breakpoint
CREATE TYPE "public"."pickup_day" AS ENUM('monday', 'tuesday', 'wednesday', 'thursday', 'friday');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('scheduled', 'heading_there', 'done', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"street" text NOT NULL,
	"city" text NOT NULL,
	"postal_code" varchar(10) NOT NULL,
	"pickup_day" "pickup_day" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "magic_link_token" (
	"token" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"visit_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error" text,
	"gmail_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_visit_kind_unique" UNIQUE("visit_id","kind")
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"cadence" "cadence" NOT NULL,
	"bin_count" integer NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"started_on" date NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"subscription_id" uuid,
	"scheduled_for" date NOT NULL,
	"status" "visit_status" DEFAULT 'scheduled' NOT NULL,
	"heading_there_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"postal_code" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "magic_link_token" ADD CONSTRAINT "magic_link_token_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_customer_idx" ON "notification_log" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "subscription_customer_idx" ON "subscription" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "visit_customer_idx" ON "visit" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "visit_scheduled_for_idx" ON "visit" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "visit_status_idx" ON "visit" USING btree ("status");