CREATE INDEX "magic_link_customer_idx" ON "magic_link_token" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "visit_subscription_idx" ON "visit" USING btree ("subscription_id");