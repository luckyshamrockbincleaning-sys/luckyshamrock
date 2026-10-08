CREATE TABLE "season" (
	"year" integer PRIMARY KEY NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_starts_before_ends" CHECK ("season"."starts_on" <= "season"."ends_on"),
	CONSTRAINT "season_within_year" CHECK (extract(year from "season"."starts_on") = "season"."year" and extract(year from "season"."ends_on") = "season"."year")
);
